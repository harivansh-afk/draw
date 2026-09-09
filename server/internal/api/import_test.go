package api

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	crypt "git.harivan.sh/harivansh-afk/draw/server/internal/crypto"
	"git.harivan.sh/harivansh-afk/draw/server/internal/importer"
)

func TestImportedLongFileID(t *testing.T) {
	f := setup(t, true)
	owner := f.login("owner@example.com")
	root := t.TempDir()
	id := strings.Repeat("a", 96)
	const dataURL = "data:image/png;base64,aGk="
	data := `{"elements":[{"type":"image","version":1,"fileId":"` + id + `"}],"files":{"` + id + `":{"dataURL":"` + dataURL + `"}}}`
	if err := os.WriteFile(filepath.Join(root, "scene.excalidraw"), []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
	if err := importer.RunDir(f.s.Store, root, importer.Options{Owner: "owner@example.com"}, io.Discard); err != nil {
		t.Fatal(err)
	}
	var sceneID, key string
	if err := f.s.Store.DB.QueryRow("SELECT id,room_key FROM scenes").Scan(&sceneID, &key); err != nil {
		t.Fatal(err)
	}
	r := f.request("POST", "/api/scenes/"+sceneID+"/duplicate", map[string]any{}, owner, nil)
	status(t, r, 201)
	copy := readJSON[sceneAccess](t, r)
	for _, scene := range []struct{ id, key string }{{sceneID, key}, {copy.Scene.ID, copy.RoomKey}} {
		r := f.request("GET", "/api/files/rooms/"+scene.id+"/"+id, nil, owner, nil)
		status(t, r, 200)
		blob, err := io.ReadAll(r.Body)
		r.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		metadata, plain, err := crypt.Decompress(scene.key, blob)
		if err != nil || string(plain) != dataURL || !bytes.Contains(metadata, []byte(id)) {
			t.Fatal(string(metadata), string(plain), err)
		}
	}
	for _, tt := range []struct {
		id     string
		status int
	}{
		{strings.Repeat("b", 128), 204},
		{strings.Repeat("b", 129), 400},
		{"bad.id", 400},
	} {
		status(t, f.request("PUT", "/api/files/rooms/"+sceneID+"/"+tt.id, []byte("data"), owner, nil), tt.status)
	}
}
