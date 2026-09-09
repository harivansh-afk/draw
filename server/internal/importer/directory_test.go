package importer

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	crypt "git.harivan.sh/harivansh-afk/draw/server/internal/crypto"
	"git.harivan.sh/harivansh-afk/draw/server/internal/store"
)

func writeExport(t *testing.T, root, name, data string, mtime time.Time) {
	t.Helper()
	p := filepath.Join(root, name)
	if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(p, mtime, mtime); err != nil {
		t.Fatal(err)
	}
}

func assertCounts(t *testing.T, s *store.Store, want map[string]int) {
	t.Helper()
	for table, expected := range want {
		var got int
		if err := s.DB.QueryRow("SELECT count(*) FROM " + table).Scan(&got); err != nil || got != expected {
			t.Fatalf("%s count = %d, want %d: %v", table, got, expected, err)
		}
	}
}

func assertNoImport(t *testing.T, s *store.Store) {
	t.Helper()
	assertCounts(t, s, map[string]int{"users": 0, "collections": 0, "scenes": 0, "rooms": 0, "room_versions": 0, "imports": 0})
	if _, err := os.Stat(filepath.Join(s.Dir, "files")); !os.IsNotExist(err) {
		t.Fatalf("import created files directory: %v", err)
	}
}

func TestImportDirectory(t *testing.T) {
	mtime := time.Date(2025, 1, 2, 3, 4, 5, 123456789, time.UTC)
	created := "2024-01-02T01:04:05.123000000Z"
	updated := "2024-02-03T04:05:06.987654321Z"
	const dataURL = "data:image/png;base64,cG5nIGJ5dGVz"
	const imageElements = `[{"id":"rect","type":"rectangle","version":3},{"id":"image","type":"image","fileId":"img","version":7}]`
	scenes := []struct {
		path, name, collection, created, updated, elements, metadata, files string
		version                                                             int
	}{
		{"Work/nested/filename.excalidraw", "Metadata name", "Work", created, updated, imageElements,
			`"metadata":{"id":"plus-id","name":"Metadata name","created":"2024-01-02T03:04:05.123+02:00","updated":"2024-02-03T04:05:06.987654321Z"},`,
			`"files":{"img":{"id":"ignored","mimeType":"image/png","dataURL":"` + dataURL + `","created":123,"lastRetrieved":456},"unused":{"dataURL":"` + dataURL + `"},"remote":{"dataURL":"https://example.com/image"}},`, 10},
		{"top.excalidraw", "top", "", store.Before(mtime), store.Before(mtime), `[]`, "", "", 0},
		{"Work/partial.excalidraw", "partial", "Work", created, store.Before(mtime), `[{"version":2}]`,
			`"metadata":{"created":"2024-01-02T01:04:05.123Z"},`, "", 2},
		{"Other/updated.excalidraw", "updated", "Other", store.Before(mtime), updated, `[{"version":4}]`,
			`"metadata":{"updated":"2024-02-03T04:05:06.987654321Z"},`, "", 4},
	}
	for _, existingOwner := range []bool{false, true} {
		t.Run(fmt.Sprintf("existing-owner=%t", existingOwner), func(t *testing.T) {
			root := t.TempDir()
			s, err := store.Open(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			sources := map[string]string{}
			for _, scene := range scenes {
				data := `{` + scene.metadata + scene.files + `"elements":` + scene.elements + `}`
				writeExport(t, root, scene.path, data, mtime)
				sources[scene.path] = data
			}
			writeExport(t, root, "ignored.json", "invalid JSON", mtime)
			if existingOwner {
				for _, q := range []string{
					"INSERT INTO users VALUES('owner','draw:dev','owner@example.com','owner@example.com','Owner','','now','now')",
					"INSERT INTO users VALUES('other','draw:dev','other@example.com','other@example.com','Other','','now','now')",
					"INSERT INTO collections VALUES('existing','owner','Work','now','now')",
					"INSERT INTO collections VALUES('other-col','other','Other','now','now')",
				} {
					if _, err := s.DB.Exec(q); err != nil {
						t.Fatal(err)
					}
				}
			}
			o := Options{Owner: "OWNER@example.com", CreateOwner: !existingOwner, DryRun: true}
			var out bytes.Buffer
			if err := RunDir(s, root, o, &out); err != nil {
				t.Fatal(err)
			}
			for _, text := range []string{`Create collection "Other"`, `elements=2 images=2`, "created=" + created, "updated=" + updated, "Dry run: 4 scenes; skipped 0"} {
				if !strings.Contains(out.String(), text) {
					t.Fatalf("missing %q in %s", text, out.String())
				}
			}
			if strings.Contains(out.String(), `Create collection "Work"`) == existingOwner {
				t.Fatal("incorrect collection creation plan", out.String())
			}
			if !existingOwner {
				assertNoImport(t, s)
			} else {
				assertCounts(t, s, map[string]int{"users": 2, "collections": 2, "scenes": 0, "rooms": 0, "room_versions": 0, "imports": 0})
				if _, err := os.Stat(filepath.Join(s.Dir, "files")); !os.IsNotExist(err) {
					t.Fatal("dry run wrote media", err)
				}
			}
			o.DryRun = false
			out.Reset()
			if err := RunDir(s, root, o, &out); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(out.String(), "Imported 4 scenes; skipped 0") {
				t.Fatal(out.String())
			}
			collections, users := 2, 1
			if existingOwner {
				collections, users = 3, 2
			}
			assertCounts(t, s, map[string]int{"users": users, "collections": collections, "scenes": 4, "rooms": 4, "room_versions": 4, "imports": 4})
			keys := map[string]bool{}
			var imageScene store.Scene
			for _, want := range scenes {
				var id string
				if err := s.DB.QueryRow("SELECT id FROM scenes WHERE name=?", want.name).Scan(&id); err != nil {
					t.Fatal(err)
				}
				got, err := s.Scene(id)
				if err != nil {
					t.Fatal(err)
				}
				if got.CreatedAt != want.created || got.UpdatedAt != want.updated || got.ShareMode != "private" {
					t.Fatal(got)
				}
				var email string
				if err := s.DB.QueryRow("SELECT email FROM users WHERE id=?", got.OwnerID).Scan(&email); err != nil || email != "owner@example.com" {
					t.Fatal(email, err)
				}
				if want.collection == "" {
					if got.CollectionID != nil {
						t.Fatal(got)
					}
				} else {
					if got.CollectionID == nil {
						t.Fatal(got)
					}
					var name, owner string
					if err := s.DB.QueryRow("SELECT name,owner_id FROM collections WHERE id=?", *got.CollectionID).Scan(&name, &owner); err != nil || name != want.collection || owner != got.OwnerID {
						t.Fatal(name, owner, err)
					}
					if existingOwner && want.collection == "Work" && *got.CollectionID != "existing" {
						t.Fatal("did not reuse collection")
					}
				}
				if keys[got.RoomKey] || len(got.RoomKey) != 22 {
					t.Fatal("expected fresh room key", got)
				}
				keys[got.RoomKey] = true
				var iv, ct []byte
				var version, rev int
				var roomUpdated, roomOwner string
				if err := s.DB.QueryRow("SELECT iv,ciphertext,scene_version,rev,updated_at,created_by FROM rooms WHERE id=?", id).Scan(&iv, &ct, &version, &rev, &roomUpdated, &roomOwner); err != nil {
					t.Fatal(err)
				}
				plain, err := crypt.Decrypt(got.RoomKey, iv, ct)
				if err != nil || string(plain) != want.elements || version != want.version || rev != 1 || roomUpdated != want.updated || roomOwner != got.OwnerID {
					t.Fatal(string(plain), version, roomUpdated, err)
				}
				var historyAt string
				if err := s.DB.QueryRow("SELECT created_at FROM room_versions WHERE room_id=?", id).Scan(&historyAt); err != nil || historyAt != want.updated {
					t.Fatal(historyAt, err)
				}
				var sourceID string
				if err := s.DB.QueryRow("SELECT source_id FROM imports WHERE scene_id=?", id).Scan(&sourceID); err != nil {
					t.Fatal(err)
				}
				if want.name == "Metadata name" {
					imageScene = got
					if sourceID != "excalidraw:id:plus-id" {
						t.Fatal(sourceID)
					}
				} else if sourceID != fmt.Sprintf("excalidraw:sha256:%x", sha256.Sum256([]byte(sources[want.path]))) {
					t.Fatal(sourceID)
				}
			}
			for _, file := range []struct {
				id                 string
				created, retrieved int64
			}{{"img", 123, 456}, {"unused", 1704157445123, 1704157445123}} {
				blob, err := os.ReadFile(s.File("rooms", imageScene.ID, file.id))
				if err != nil {
					t.Fatal(err)
				}
				metadata, plain, err := crypt.Decompress(imageScene.RoomKey, blob)
				if err != nil || string(plain) != dataURL {
					t.Fatal(string(plain), err)
				}
				var m struct {
					ID, MimeType           string
					Created, LastRetrieved int64
				}
				if err := json.Unmarshal(metadata, &m); err != nil || m.ID != file.id || m.MimeType != "image/png" || m.Created != file.created || m.LastRetrieved != file.retrieved {
					t.Fatal(string(metadata), err)
				}
			}
			if _, err := os.Stat(s.File("rooms", imageScene.ID, "remote")); !os.IsNotExist(err) {
				t.Fatal("stored remote file", err)
			}
			// Provenance follows identity/bytes across paths and survives scene deletion.
			if err := s.DeleteScene(imageScene.ID); err != nil {
				t.Fatal(err)
			}
			writeExport(t, root, scenes[0].path, `{"metadata":{"id":"plus-id"},"elements":null}`, mtime)
			if err := os.Rename(filepath.Join(root, "top.excalidraw"), filepath.Join(root, "moved.excalidraw")); err != nil {
				t.Fatal(err)
			}
			for _, dry := range []bool{false, true} {
				o.DryRun = dry
				out.Reset()
				if err := RunDir(s, root, o, &out); err != nil {
					t.Fatal(err)
				}
				if !strings.Contains(out.String(), "0 scenes; skipped 4") {
					t.Fatal(out.String())
				}
				assertCounts(t, s, map[string]int{"scenes": 3, "imports": 4, "collections": collections})
			}
		})
	}
}

func TestDirectoryValidationBeforeWrites(t *testing.T) {
	for _, tt := range []struct{ name, data, message string }{
		{"bad-json", `{`, "unexpected end"},
		{"missing-elements", `{}`, "elements must be a JSON array"},
		{"null-elements", `{"elements":null}`, "elements must be a JSON array"},
		{"object-elements", `{"elements":{}}`, "elements must be a JSON array"},
		{"negative-version", `{"elements":[{"version":-1}]}`, "invalid scene version"},
		{"overflow-version", `{"elements":[{"version":9007199254740991},{"version":1}]}`, "invalid scene version"},
		{"bad-created", `{"elements":[],"metadata":{"created":"yesterday"}}`, "metadata.created"},
		{"bad-updated", `{"elements":[],"metadata":{"updated":"2025-01-02"}}`, "metadata.updated"},
		{"bad-files", `{"elements":[],"files":[]}`, "files JSON"},
		{"unsafe-file-id", `{"elements":[],"files":{"../escape":{"dataURL":"data:image/png;base64,aA=="}}}`, "invalid file id"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			s, err := store.Open(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			root := t.TempDir()
			writeExport(t, root, "A/valid.excalidraw", `{"elements":[],"files":{"img":{"dataURL":"data:image/png;base64,aA=="}}}`, time.Now())
			writeExport(t, root, "Z/invalid.excalidraw", tt.data, time.Now())
			for _, dry := range []bool{false, true} {
				err := RunDir(s, root, Options{Owner: "owner@example.com", CreateOwner: true, DryRun: dry}, io.Discard)
				if err == nil || !strings.Contains(err.Error(), tt.message) || !strings.Contains(err.Error(), "Z/invalid.excalidraw") {
					t.Fatalf("expected %q with path, got %v", tt.message, err)
				}
				assertNoImport(t, s)
			}
		})
	}
}

func TestDirectoryDuplicatesAndOwner(t *testing.T) {
	s, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	root := t.TempDir()
	for name, data := range map[string]string{
		"a.excalidraw": `{"metadata":{"id":"same-id"},"elements":[]}`,
		"b.excalidraw": `{"metadata":{"id":"same-id"},"elements":null}`,
		"c.excalidraw": `{"elements":[{"version":1}]}`,
		"d.excalidraw": `{"elements":[{"version":1}]}`,
	} {
		writeExport(t, root, name, data, time.Now())
	}
	for _, owner := range []string{"invalid", "owner@example.com"} {
		if err := RunDir(s, root, Options{Owner: owner}, io.Discard); err == nil {
			t.Fatal("accepted absent/invalid owner")
		}
		assertNoImport(t, s)
	}
	var out bytes.Buffer
	if err := RunDir(s, root, Options{Owner: "owner@example.com", CreateOwner: true}, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "Imported 2 scenes; skipped 2") {
		t.Fatal(out.String())
	}
	assertCounts(t, s, map[string]int{"scenes": 2, "imports": 2})
}

func TestDirectoryPreservesMissingImage(t *testing.T) {
	const elements = `[{"type":"image","fileId":"absent","status":"error","version":1}]`
	var scene exportScene
	if err := json.Unmarshal([]byte(`{"elements":`+elements+`}`), &scene); err != nil {
		t.Fatal(err)
	}
	d, err := prepareExport(scene, "missing-image.excalidraw", time.Now())
	if err != nil || string(d.elements) != elements || len(d.files) != 0 {
		t.Fatal(d, err)
	}
}
