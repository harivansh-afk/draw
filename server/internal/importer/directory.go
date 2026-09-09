package importer

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"strings"
	"time"

	"git.harivan.sh/harivansh-afk/draw/server/internal/store"
)

type exportScene struct {
	Metadata struct {
		ID, Name, Created, Updated string
	}
	Elements json.RawMessage
	Files    json.RawMessage
}

// RunDir validates the whole tree before sharing the database/file commit path.
func RunDir(s *store.Store, dir string, o Options, out io.Writer) error {
	owner, err := ownerEmail(o.Owner)
	if err != nil {
		return err
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return err
	}
	defer root.Close()
	s.Mutation.Lock()
	defer s.Mutation.Unlock()
	uid, missing, err := lookupOwner(s, owner, o.CreateOwner)
	if err != nil {
		return err
	}
	var plans []drawing
	seen := map[string]bool{}
	skipped := 0
	err = fs.WalkDir(root.FS(), ".", func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || path.Ext(name) != ".excalidraw" {
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("%s: expected a regular file", name)
		}
		f, err := root.FS().Open(name)
		if err != nil {
			return err
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			return err
		}
		raw, err := io.ReadAll(io.LimitReader(f, 64<<20+1))
		if err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		if len(raw) > 64<<20 {
			return fmt.Errorf("%s: export exceeds 64 MiB", name)
		}
		var scene exportScene
		if err := json.Unmarshal(raw, &scene); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		id := "excalidraw:id:" + scene.Metadata.ID
		if scene.Metadata.ID == "" {
			id = fmt.Sprintf("excalidraw:sha256:%x", sha256.Sum256(raw))
		}
		var exists bool
		if err := s.DB.QueryRow("SELECT EXISTS(SELECT 1 FROM imports WHERE source_id=?)", id).Scan(&exists); err != nil {
			return err
		}
		if exists || seen[id] {
			skipped++
			return nil
		}
		d, err := prepareExport(scene, name, info.ModTime())
		if err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		d.oldID = id
		seen[id] = true
		plans = append(plans, d)
		return nil
	})
	if err != nil {
		return err
	}
	collections := map[string]bool{}
	for _, d := range plans {
		if d.collection != "" && !collections[d.collection] {
			var exists bool
			if err := s.DB.QueryRow("SELECT EXISTS(SELECT 1 FROM collections WHERE owner_id=? AND name=?)", uid, d.collection).Scan(&exists); err != nil {
				return err
			}
			if !exists {
				fmt.Fprintf(out, "Create collection %q\n", d.collection)
			}
			collections[d.collection] = true
		}
		fmt.Fprintf(out, "Import %q: collection=%q elements=%d images=%d created=%s updated=%s\n", d.name, d.collection, d.elementCount, len(d.files), d.created, d.updated)
	}
	return commitPlans(s, o, out, owner, uid, missing, plans, skipped)
}

func prepareExport(scene exportScene, name string, mtime time.Time) (drawing, error) {
	d := drawing{name: scene.Metadata.Name, files: map[string][]byte{}, metadata: map[string]json.RawMessage{}}
	if d.name == "" {
		d.name = strings.TrimSuffix(path.Base(name), ".excalidraw")
	}
	if first, _, nested := strings.Cut(name, "/"); nested {
		d.collection = first
	}
	var err error
	d.created, err = exportTimestamp(scene.Metadata.Created, mtime)
	if err != nil {
		return d, fmt.Errorf("metadata.created: %w", err)
	}
	d.updated, err = exportTimestamp(scene.Metadata.Updated, mtime)
	if err != nil {
		return d, fmt.Errorf("metadata.updated: %w", err)
	}
	_, err = d.setElements(scene.Elements)
	if err != nil {
		return d, err
	}
	var files map[string]map[string]any
	if len(scene.Files) > 0 {
		if err := json.Unmarshal(scene.Files, &files); err != nil {
			return d, fmt.Errorf("files JSON: %w", err)
		}
	}
	for id, file := range files {
		dataURL := str(file["dataURL"])
		if strings.HasPrefix(dataURL, "data:") {
			if err := d.addFile(id, str(file["mimeType"]), dataURL, file); err != nil {
				return d, err
			}
		}
	}
	return d, nil
}

func exportTimestamp(value string, fallback time.Time) (string, error) {
	if value == "" {
		return store.Before(fallback), nil
	}
	t, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return "", errors.New("expected RFC 3339 timestamp")
	}
	return store.Before(t), nil
}
