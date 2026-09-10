package api

import (
	"testing"

	crypt "git.harivan.sh/harivansh-afk/draw/server/internal/crypto"
	"git.harivan.sh/harivansh-afk/draw/server/internal/store"
)

func kinds(t *testing.T, f *fixture, cookie string) []store.Activity {
	t.Helper()
	r := f.request("GET", "/api/activity", nil, cookie, nil)
	status(t, r, 200)
	return readJSON[struct{ Activity []store.Activity }](t, r).Activity
}

func TestActivityTimeline(t *testing.T) {
	f := setup(t, true)
	owner := f.login("owner@example.com")
	status(t, f.request("GET", "/api/activity", nil, "", nil), 401)
	status(t, f.request("GET", "/api/activity?limit=0", nil, owner, nil), 400)

	scene := f.scene(owner)
	path := "/api/rooms/" + scene.Scene.ID
	iv, ct, err := crypt.Encrypt(scene.RoomKey, []byte("[]"))
	if err != nil {
		t.Fatal(err)
	}
	payload := map[string]any{"sceneVersion": 1, "iv": iv, "ciphertext": ct}
	status(t, f.request("PUT", path, payload, owner, map[string]string{"If-None-Match": "*"}), 201)
	status(t, f.request("PUT", path, payload, owner, map[string]string{"If-Match": "\"1\""}), 200)

	list := kinds(t, f, owner)
	if len(list) != 1 || list[0].Kind != store.ActivityCreated || list[0].SceneState != "live" {
		t.Fatalf("saves right after creation must fold into the created entry: %+v", list)
	}

	r := f.request("POST", "/api/collections", map[string]string{"name": "Ideas"}, owner, nil)
	status(t, r, 201)
	collection := readJSON[Collection](t, r)
	status(t, f.request("PATCH", "/api/scenes/"+scene.Scene.ID, map[string]any{"name": "Plan", "shareMode": "view", "collectionId": collection.ID}, owner, nil), 200)
	status(t, f.request("PATCH", "/api/scenes/"+scene.Scene.ID, map[string]any{"name": "Plan"}, owner, nil), 200)

	r = f.request("POST", "/api/scenes/"+scene.Scene.ID+"/duplicate", map[string]any{}, owner, nil)
	status(t, r, 201)
	copyID := readJSON[SceneAccess](t, r).Scene.ID
	status(t, f.request("DELETE", "/api/scenes/"+scene.Scene.ID, nil, owner, nil), 204)
	status(t, f.request("DELETE", "/api/scenes/"+scene.Scene.ID, nil, owner, nil), 204)
	status(t, f.request("POST", "/api/scenes/"+scene.Scene.ID+"/restore", nil, owner, nil), 200)
	status(t, f.request("DELETE", "/api/scenes/"+copyID+"?permanent=1", nil, owner, nil), 204)

	list = kinds(t, f, owner)
	want := []string{store.ActivityDeleted, store.ActivityRestored, store.ActivityTrashed, store.ActivityDuplicated, store.ActivityMoved, store.ActivityShared, store.ActivityRenamed, store.ActivityCreated}
	if len(list) != len(want) {
		t.Fatalf("got %d entries want %d: %+v", len(list), len(want), list)
	}
	for i, a := range list {
		if a.Kind != want[i] {
			t.Fatalf("entry %d kind %s want %s", i, a.Kind, want[i])
		}
	}
	if list[0].SceneState != "gone" || list[0].SceneName != "Plan (copy)" || list[3].Detail != "Plan" {
		t.Fatalf("deleted copy: %+v %+v", list[0], list[3])
	}
	if list[4].Detail != "Ideas" || list[5].Detail != "view" || list[6].Detail != "Untitled" || list[6].SceneName != "Plan" || list[7].SceneName != "Plan" {
		t.Fatalf("details: %+v", list[4:8])
	}
	me := readJSON[struct{ User store.User }](t, f.request("GET", "/api/auth/me", nil, owner, nil)).User
	if list[1].SceneState != "live" || list[0].ActorID == nil || *list[0].ActorID != me.ID {
		t.Fatalf("state/actor: %+v", list[:2])
	}

	other := f.login("other@example.com")
	if len(kinds(t, f, other)) != 0 {
		t.Fatal("timeline leaked across owners")
	}
	r = f.request("GET", "/api/activity?limit=2", nil, owner, nil)
	status(t, r, 200)
	if n := len(readJSON[struct{ Activity []store.Activity }](t, r).Activity); n != 2 {
		t.Fatalf("limit ignored: %d", n)
	}
}
