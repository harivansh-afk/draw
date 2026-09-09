package importer

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"git.harivan.sh/harivansh-afk/draw/server/internal/auth"
	"git.harivan.sh/harivansh-afk/draw/server/internal/config"
	crypt "git.harivan.sh/harivansh-afk/draw/server/internal/crypto"
	"git.harivan.sh/harivansh-afk/draw/server/internal/store"
)

func TestImportSchemaVariants(t *testing.T) {
	for _, alternate := range []bool{false, true} {
		t.Run(map[bool]string{false: "Prisma", true: "snake_case"}[alternate], func(t *testing.T) {
			dir := t.TempDir()
			source := filepath.Join(dir, "excalidash.db")
			db, err := sql.Open("sqlite", source)
			if err != nil {
				t.Fatal(err)
			}
			created, updated := "createdAt", "updatedAt"
			name, collection := "name", "collectionId"
			if alternate {
				created, updated, name, collection = "created_at", "updated_at", "title", "collection_id"
			}
			for _, q := range []string{"CREATE TABLE Collection(id TEXT," + quote(name) + " TEXT)", "CREATE TABLE Drawing(id TEXT," + quote(name) + " TEXT,elements TEXT,files TEXT," + quote(collection) + " TEXT," + quote(created) + " INTEGER," + quote(updated) + " INTEGER)", "INSERT INTO Collection VALUES('col','Work')"} {
				if _, err = db.Exec(q); err != nil {
					t.Fatal(err)
				}
			}
			elements := `[{"id":"rect","type":"rectangle","version":3},{"id":"img","type":"image","fileId":"file1","version":7}]`
			files := `{"file1":{"mimeType":"image/png","dataURL":"/uploads/picture.png","created":1700000000000,"lastRetrieved":1700000000001}}`
			if _, err = db.Exec("INSERT INTO Drawing VALUES('drawing','Imported',?,?,'col',1700000000000,1700000001000)", elements, files); err != nil {
				t.Fatal(err)
			}
			db.Close()
			uploads := filepath.Join(dir, "uploads")
			if err = os.Mkdir(uploads, 0700); err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(filepath.Join(uploads, "picture.png"), []byte("png bytes"), 0600); err != nil {
				t.Fatal(err)
			}
			s, err := store.Open(filepath.Join(dir, "draw"))
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			o := Options{DB: source, Uploads: uploads, Owner: "owner@example.com", CreateOwner: true, DryRun: true}
			var out bytes.Buffer
			if err = Run(s, o, &out); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(out.String(), "Schema Drawing:") || !strings.Contains(out.String(), "Dry run: 1") {
				t.Fatal(out.String())
			}
			var n int
			s.DB.QueryRow("SELECT count(*) FROM users").Scan(&n)
			if n != 0 {
				t.Fatal("dry run created user")
			}
			o.DryRun = false
			if err = Run(s, o, &out); err != nil {
				t.Fatal(err)
			}
			var id string
			if err = s.DB.QueryRow("SELECT id FROM scenes").Scan(&id); err != nil {
				t.Fatal(err)
			}
			scene, err := s.Scene(id)
			if err != nil {
				t.Fatal(err)
			}
			if scene.Name != "Imported" || scene.CreatedAt != "2023-11-14T22:13:20.000000000Z" || scene.UpdatedAt != "2023-11-14T22:13:21.000000000Z" || scene.CollectionID == nil {
				t.Fatal(scene)
			}
			var iv, ct []byte
			var version int
			if err = s.DB.QueryRow("SELECT iv,ciphertext,scene_version FROM rooms WHERE id=?", id).Scan(&iv, &ct, &version); err != nil {
				t.Fatal(err)
			}
			p, err := crypt.Decrypt(scene.RoomKey, iv, ct)
			if err != nil || string(p) != elements || version != 10 {
				t.Fatal(string(p), version, err)
			}
			b, err := os.ReadFile(s.File("rooms", id, "file1"))
			if err != nil {
				t.Fatal(err)
			}
			metadata, p, err := crypt.Decompress(scene.RoomKey, b)
			if err != nil || string(p) != "data:image/png;base64,cG5nIGJ5dGVz" {
				t.Fatal(string(p), err)
			}
			var m map[string]any
			if err = json.Unmarshal(metadata, &m); err != nil || m["id"] != "file1" {
				t.Fatal(string(metadata), err)
			}
			if err := os.RemoveAll(uploads); err != nil {
				t.Fatal(err)
			}
			out.Reset()
			if err := Run(s, o, &out); err != nil {
				t.Fatal("repeat import must skip missing original uploads", err)
			}
			if !strings.Contains(out.String(), "Imported 0 scenes; skipped 1") {
				t.Fatal(out.String())
			}
			if err := s.DB.QueryRow("SELECT count(*) FROM scenes").Scan(&n); err != nil || n != 1 {
				t.Fatal("repeat import duplicated scenes", n, err)
			}
			var importedID string
			if err := s.DB.QueryRow("SELECT scene_id FROM imports WHERE source_id='drawing'").Scan(&importedID); err != nil || importedID != id {
				t.Fatal("missing import provenance", importedID, err)
			}
			o.DryRun = true
			out.Reset()
			if err := Run(s, o, &out); err != nil || !strings.Contains(out.String(), "Dry run: 0 scenes; skipped 1") {
				t.Fatal(out.String(), err)
			}
			o.DryRun = false
			c, err := config.Load(nil)
			if err != nil {
				t.Fatal(err)
			}
			c.DevLogin = true
			c.ClientID = ""
			c.ClientSecret = ""
			c.SessionKeyFile = filepath.Join(dir, "session.key")
			a, err := auth.New(context.Background(), s, c)
			if err != nil {
				t.Fatal(err)
			}
			user, err := a.Login("draw:dev", o.Owner, o.Owner, "Owner", "")
			if err != nil || user.ID != scene.OwnerID {
				t.Fatal("import owner was not claimed", user, err)
			}
		})
	}
}

func TestMissingFileAndTraversal(t *testing.T) {
	dir := t.TempDir()
	row := record{"id": "d", "name": "D", "elements": `[{"type":"image","version":1,"fileId":"img"}]`, "files": `{"img":{"dataURL":"/uploads/../secret"}}`}
	if _, err := prepare(row, nil, nil, dir); err == nil {
		t.Fatal("accepted traversal")
	}
	row["files"] = `{"img":{}}`
	if _, err := prepare(row, nil, nil, dir); err == nil {
		t.Fatal("accepted missing file")
	}
	outside := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(outside, []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "img")); err != nil {
		t.Fatal(err)
	}
	if _, err := prepare(row, nil, nil, dir); err == nil {
		t.Fatal("accepted symlink escape")
	}
}

func TestDatabaseFiles(t *testing.T) {
	row := record{"id": "d", "name": "D", "elements": `[{"type":"image","version":1,"fileId":"img"}]`, "files": `{"img":{"dataURL":"/api/files/d/img","mimeType":"image/png"}}`}
	files := []record{{"drawingid": "d", "fileid": "img", "data": []byte("hello")}}
	d, err := prepare(row, nil, files, "")
	if err != nil {
		t.Fatal(err)
	}
	if string(d.files["img"]) != "data:image/png;base64,aGVsbG8=" {
		t.Fatal(d)
	}
}
