// Package importer reads schema-discovered ExcaliDash SQLite exports without modifying them.
package importer

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/mail"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	crypt "git.harivan.sh/harivansh-afk/draw/server/internal/crypto"
	"git.harivan.sh/harivansh-afk/draw/server/internal/store"
)

type Options struct {
	DB, Uploads, Owner  string
	DryRun, CreateOwner bool
}

type record map[string]any

func norm(s string) string {
	return strings.ToLower(strings.ReplaceAll(s, "_", ""))
}

func (r record) get(keys ...string) any {
	for _, k := range keys {
		if v, ok := r[norm(k)]; ok && v != nil {
			return v
		}
	}
	return nil
}

func str(v any) string {
	switch v := v.(type) {
	case nil:
		return ""
	case string:
		return v
	case []byte:
		return string(v)
	default:
		return fmt.Sprint(v)
	}
}

func quote(s string) string {
	return "\"" + strings.ReplaceAll(s, "\"", "\"\"") + "\""
}

func table(db *sql.DB, name string, out io.Writer) ([]record, error) {
	var actual, schema string
	err := db.QueryRow("SELECT name,sql FROM sqlite_master WHERE type='table' AND lower(name)=lower(?)", name).Scan(&actual, &schema)
	if err != nil {
		return nil, err
	}
	fmt.Fprintf(out, "Schema %s: %s\n", actual, schema)
	rows, err := db.Query("SELECT * FROM " + quote(actual))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	result := []record{}
	for rows.Next() {
		values := make([]any, len(columns))
		dest := make([]any, len(columns))
		for i := range values {
			dest[i] = &values[i]
		}
		if err = rows.Scan(dest...); err != nil {
			return nil, err
		}
		r := record{}
		for i, col := range columns {
			r[norm(col)] = values[i]
		}
		result = append(result, r)
	}
	return result, rows.Err()
}

func timestamp(v any, fallback string) (string, error) {
	if v == nil || str(v) == "" {
		return fallback, nil
	}
	if t, ok := v.(time.Time); ok {
		return store.Before(t), nil
	}
	text := str(v)
	if n, err := strconv.ParseInt(text, 10, 64); err == nil {
		if n < 100000000000 {
			n *= 1000
		}
		return store.Before(time.UnixMilli(n)), nil
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05.999999999-07:00", "2006-01-02 15:04:05.999999999", "2006-01-02T15:04:05.999999999"} {
		if t, err := time.Parse(layout, text); err == nil {
			return store.Before(t), nil
		}
	}
	return "", fmt.Errorf("unrecognized timestamp %q", text)
}

type drawing struct {
	oldID, name, collection, created, updated string
	elements                                  []byte
	version                                   int64
	files                                     map[string][]byte
	metadata                                  map[string]json.RawMessage
}

func prepare(row record, collections map[string]string, fileRows []record, uploads string) (drawing, error) {
	d := drawing{oldID: str(row.get("id", "drawingId")), name: str(row.get("name", "title")), files: map[string][]byte{}, metadata: map[string]json.RawMessage{}}
	if d.oldID == "" || d.name == "" {
		return d, errors.New("drawing requires id and name/title columns")
	}
	if engine := str(row.get("engine")); engine != "" && engine != "excalidraw" {
		return d, fmt.Errorf("unsupported drawing engine %q", engine)
	}
	var err error
	d.created, err = timestamp(row.get("createdAt", "created"), store.Now())
	if err != nil {
		return d, err
	}
	d.updated, err = timestamp(row.get("updatedAt", "updated", "modifiedAt"), d.created)
	if err != nil {
		return d, err
	}
	if cid := str(row.get("collectionId", "collection")); cid != "" {
		var ok bool
		d.collection, ok = collections[cid]
		if !ok {
			return d, fmt.Errorf("collection %q missing", cid)
		}
	}
	raw := []byte(str(row.get("elements", "data", "content", "scene")))
	var envelope struct {
		Elements json.RawMessage
		Files    json.RawMessage
	}
	if len(raw) > 0 && raw[0] == '{' {
		if err = json.Unmarshal(raw, &envelope); err != nil {
			return d, err
		}
		raw = envelope.Elements
	}
	var elements []struct {
		Version int64  `json:"version"`
		Type    string `json:"type"`
		FileID  string `json:"fileId"`
	}
	if err = json.Unmarshal(raw, &elements); err != nil || elements == nil {
		return d, errors.New("elements must be a JSON array")
	}
	d.elements = raw
	filesRaw := []byte(str(row.get("files")))
	if len(filesRaw) == 0 {
		filesRaw = envelope.Files
	}
	if len(filesRaw) == 0 {
		filesRaw = []byte("{}")
	}
	var files map[string]map[string]any
	if err = json.Unmarshal(filesRaw, &files); err != nil {
		return d, fmt.Errorf("files JSON: %w", err)
	}
	for _, element := range elements {
		if element.Version < 0 || d.version > 9007199254740991-element.Version {
			return d, errors.New("invalid scene version")
		}
		d.version += element.Version
		if element.Type != "image" || element.FileID == "" {
			continue
		}
		id := element.FileID
		if _, ok := d.files[id]; ok {
			continue
		}
		if !store.ValidID(id) {
			return d, fmt.Errorf("invalid file id %q", id)
		}
		f := files[id]
		if f == nil {
			return d, fmt.Errorf("image %s missing from files JSON", id)
		}
		mime := str(f["mimeType"])
		dataURL := str(f["dataURL"])
		if !strings.HasPrefix(dataURL, "data:") {
			var data []byte
			for _, r := range fileRows {
				if str(r.get("drawingId")) == d.oldID && str(r.get("fileId", "id")) == id && r.get("data") != nil {
					switch v := r.get("data").(type) {
					case []byte:
						data = v
					case string:
						data = []byte(v)
					}
					if mime == "" {
						mime = str(r.get("mimeType"))
					}
					break
				}
			}
			if data == nil {
				ref := dataURL
				if ref == "" {
					ref = str(f["path"])
				}
				if ref == "" {
					ref = str(f["url"])
				}
				data, err = readUpload(uploads, d.oldID, id, ref, mime)
				if err != nil {
					return d, fmt.Errorf("image %s: %w", id, err)
				}
			}
			if mime == "" {
				mime = http.DetectContentType(data)
			}
			dataURL = "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data)
		} else if mime == "" {
			mime = strings.Split(strings.TrimPrefix(dataURL, "data:"), ";")[0]
		}
		created := f["created"]
		if created == nil {
			t, _ := time.Parse(time.RFC3339Nano, d.created)
			created = t.UnixMilli()
		}
		retrieved := f["lastRetrieved"]
		if retrieved == nil {
			retrieved = created
		}
		metadata, err := json.Marshal(map[string]any{"id": id, "mimeType": mime, "created": created, "lastRetrieved": retrieved})
		if err != nil {
			return d, err
		}
		d.metadata[id] = metadata
		d.files[id] = []byte(dataURL)
	}
	return d, nil
}

func readUpload(root, drawingID, id, ref, mime string) ([]byte, error) {
	if root == "" {
		return nil, errors.New("uploads directory is required")
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	candidates := []string{}
	if ref != "" {
		u, err := url.Parse(ref)
		if err != nil {
			return nil, err
		}
		p, err := url.PathUnescape(u.Path)
		if err != nil {
			return nil, err
		}
		p = strings.TrimPrefix(p, "/")
		p = strings.TrimPrefix(p, "uploads/")
		candidates = append(candidates, p)
	}
	ext := map[string]string{"image/png": ".png", "image/jpeg": ".jpg", "image/svg+xml": ".svg", "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif"}[mime]
	candidates = append(candidates, filepath.Join(drawingID, id), filepath.Join(drawingID, id+ext), id, id+ext)
	// os.Root prevents both traversal and symlink escapes from the upload directory.
	dir, err := os.OpenRoot(root)
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	for _, p := range candidates {
		if !filepath.IsLocal(p) {
			return nil, fmt.Errorf("unsafe upload path %q", p)
		}
		f, err := dir.Open(p)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		b, err := io.ReadAll(io.LimitReader(f, 64<<20+1))
		f.Close()
		if err != nil {
			return nil, err
		}
		if len(b) > 64<<20 {
			return nil, errors.New("upload exceeds 64 MiB")
		}
		return b, nil
	}
	return nil, fmt.Errorf("upload not found for %s", id)
}

func Run(s *store.Store, o Options, out io.Writer) error {
	owner := strings.ToLower(strings.TrimSpace(o.Owner))
	email, err := mail.ParseAddress(owner)
	if err != nil || email.Address != owner {
		return errors.New("valid --owner email required")
	}
	source, err := filepath.Abs(o.DB)
	if err != nil {
		return err
	}
	u := url.URL{Scheme: "file", Path: source, RawQuery: "mode=ro"}
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	drawings, err := table(db, "Drawing", out)
	if err != nil {
		return fmt.Errorf("inspect Drawing schema: %w", err)
	}
	cols, err := table(db, "Collection", out)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	fileRows, err := table(db, "DrawingFile", out)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	collections := map[string]string{}
	for _, c := range cols {
		id, name := str(c.get("id", "collectionId")), str(c.get("name", "title"))
		if id == "" || name == "" {
			return errors.New("Collection requires id and name/title columns")
		}
		collections[id] = name
	}
	s.Mutation.Lock()
	defer s.Mutation.Unlock()
	var uid string
	err = s.DB.QueryRow("SELECT id FROM users WHERE email=?", owner).Scan(&uid)
	missing := errors.Is(err, sql.ErrNoRows)
	if err != nil && !missing {
		return err
	}
	if missing && !o.CreateOwner {
		return errors.New("owner must sign in first or use --create-owner")
	}
	plans := []drawing{}
	skipped := 0
	for _, row := range drawings {
		var exists bool
		if err := s.DB.QueryRow("SELECT EXISTS(SELECT 1 FROM imports WHERE source_id=?)", str(row.get("id", "drawingId"))).Scan(&exists); err != nil {
			return err
		}
		if exists {
			skipped++
			continue
		}
		d, err := prepare(row, collections, fileRows, o.Uploads)
		if err != nil {
			return fmt.Errorf("drawing %s: %w", str(row.get("id")), err)
		}
		fmt.Fprintf(out, "Import %q: collection=%q elementsVersion=%d files=%d created=%s updated=%s\n", d.name, d.collection, d.version, len(d.files), d.created, d.updated)
		plans = append(plans, d)
	}
	if o.DryRun {
		fmt.Fprintf(out, "Dry run: %d scenes; skipped %d; createOwner=%t\n", len(plans), skipped, missing)
		return nil
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if missing {
		uid = crypt.ID()
		if _, err = tx.Exec("INSERT INTO users VALUES(?,?,?,?,?,?,?,?)", uid, "draw:import", owner, owner, owner, "", store.Now(), store.Now()); err != nil {
			return err
		}
	}
	newIDs := []string{}
	committed := false
	defer func() {
		if !committed {
			for _, id := range newIDs {
				_ = os.RemoveAll(s.File("rooms", id, ""))
			}
		}
	}()
	byName := map[string]string{}
	for _, d := range plans {
		var exists bool
		if err := tx.QueryRow("SELECT EXISTS(SELECT 1 FROM imports WHERE source_id=?)", d.oldID).Scan(&exists); err != nil {
			return err
		}
		if exists {
			skipped++
			continue
		}
		var collection any
		if d.collection != "" {
			cid := byName[d.collection]
			if cid == "" {
				err = tx.QueryRow("SELECT id FROM collections WHERE owner_id=? AND name=? LIMIT 1", uid, d.collection).Scan(&cid)
				if errors.Is(err, sql.ErrNoRows) {
					cid = crypt.ID()
					_, err = tx.Exec("INSERT INTO collections VALUES(?,?,?,?,?)", cid, uid, d.collection, d.created, d.updated)
				}
				if err != nil {
					return err
				}
				byName[d.collection] = cid
			}
			collection = cid
		}
		id, key := crypt.ID(), crypt.Key()
		newIDs = append(newIDs, id)
		if _, err = tx.Exec("INSERT INTO imports(source_id,scene_id,imported_at) VALUES(?,?,?)", d.oldID, id, store.Now()); err != nil {
			return err
		}
		if _, err = tx.Exec("INSERT INTO scenes(id,owner_id,name,collection_id,room_key,share_mode,created_at,updated_at) VALUES(?,?,?,?,?,'private',?,?)", id, uid, d.name, collection, key, d.created, d.updated); err != nil {
			return err
		}
		iv, ct, err := crypt.Encrypt(key, d.elements)
		if err != nil {
			return err
		}
		if _, err = tx.Exec("INSERT INTO rooms VALUES(?,1,?,?,?,?,?)", id, d.version, iv, ct, uid, d.updated); err != nil {
			return err
		}
		if _, err = tx.Exec("INSERT INTO room_versions VALUES(?,1,?,?,?,?)", id, d.version, iv, ct, d.updated); err != nil {
			return err
		}
		keys := []string{}
		for id := range d.files {
			keys = append(keys, id)
		}
		sort.Strings(keys)
		for _, file := range keys {
			b, err := crypt.Compress(key, d.metadata[file], d.files[file])
			if err != nil {
				return err
			}
			if err = store.AtomicWrite(s.File("rooms", id, file), b); err != nil {
				return err
			}
		}
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	committed = true
	fmt.Fprintf(out, "Imported %d scenes; skipped %d\n", len(newIDs), skipped)
	return nil
}
