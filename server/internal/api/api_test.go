package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"git.harivan.sh/harivansh-afk/draw/server/internal/auth"
	"git.harivan.sh/harivansh-afk/draw/server/internal/config"
	crypt "git.harivan.sh/harivansh-afk/draw/server/internal/crypto"
	"git.harivan.sh/harivansh-afk/draw/server/internal/store"
	"git.harivan.sh/harivansh-afk/draw/server/internal/ws"
)

type fixture struct {
	t    *testing.T
	s    *Server
	http *httptest.Server
}

func setup(t *testing.T, open bool) *fixture {
	t.Helper()
	c, err := config.Load(nil)
	if err != nil {
		t.Fatal(err)
	}
	c.DataDir = t.TempDir()
	c.SessionKeyFile = c.DataDir + "/session.key"
	c.DevLogin = true
	c.OpenSignup = open
	c.ClientID = ""
	c.ClientSecret = ""
	c.MaxFileBytes = 256
	c.RoomHistory = 2
	s, err := store.Open(c.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	a, err := auth.New(context.Background(), s, c)
	if err != nil {
		t.Fatal(err)
	}
	hub := ws.New(s, c)
	app := &Server{Store: s, Auth: a, Config: c, Hub: hub, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	ts := httptest.NewServer(app.Handler(fstest.MapFS{"index.html": {Data: []byte("<html>draw</html>")}, "assets/a-123.js": {Data: []byte("asset")}, "fonts/a.woff2": {Data: []byte("font")}, "locales/en.json": {Data: []byte("{}")}, "sw.js": {Data: []byte("sw")}, "manifest.webmanifest": {Data: []byte("{}")}}))
	f := &fixture{t, app, ts}
	t.Cleanup(func() { hub.Close(); ts.Close(); s.Close() })
	return f
}
func (f *fixture) request(method, path string, data any, cookie string, headers map[string]string) *http.Response {
	f.t.Helper()
	var b []byte
	switch v := data.(type) {
	case nil:
	case []byte:
		b = v
	default:
		var err error
		b, err = json.Marshal(v)
		if err != nil {
			f.t.Fatal(err)
		}
	}
	req, err := http.NewRequest(method, f.http.URL+path, bytes.NewReader(b))
	if err != nil {
		f.t.Fatal(err)
	}
	req.Header.Set("Origin", f.s.Config.BaseURL)
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := f.http.Client().Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	f.t.Cleanup(func() { resp.Body.Close() })
	return resp
}
func status(t *testing.T, r *http.Response, want int) {
	t.Helper()
	if r.StatusCode != want {
		b, _ := io.ReadAll(r.Body)
		t.Fatalf("status %d want %d: %s", r.StatusCode, want, b)
	}
}
func readJSON[T any](t *testing.T, r *http.Response) T {
	t.Helper()
	defer r.Body.Close()
	var v T
	if err := json.NewDecoder(r.Body).Decode(&v); err != nil {
		t.Fatal(err)
	}
	return v
}
func (f *fixture) login(email string) string {
	r := f.request("POST", "/api/auth/dev", map[string]string{"email": email}, "", nil)
	status(f.t, r, 204)
	for _, c := range r.Cookies() {
		if c.Name == auth.CookieName {
			return c.Name + "=" + c.Value
		}
	}
	f.t.Fatal("no session cookie")
	return ""
}

type sceneAccess struct {
	Scene               store.Scene `json:"scene"`
	Permission, RoomKey string
}

func (f *fixture) scene(cookie string) sceneAccess {
	r := f.request("POST", "/api/scenes", map[string]any{}, cookie, nil)
	status(f.t, r, 201)
	return readJSON[sceneAccess](f.t, r)
}
func TestAuthAllowlistCSRF(t *testing.T) {
	f := setup(t, false)
	status(t, f.request("POST", "/api/auth/dev", map[string]string{"email": "owner@example.com"}, "", map[string]string{"Origin": ""}), 403)
	status(t, f.request("POST", "/api/auth/dev", map[string]string{"email": "owner@example.com"}, "", map[string]string{"Origin": "https://evil.example"}), 403)
	cookie := f.login("owner@example.com")
	r := f.request("GET", "/api/auth/me", nil, cookie, nil)
	status(t, r, 200)
	u := readJSON[struct{ User store.User }](t, r).User
	if u.Email != "owner@example.com" {
		t.Fatal(u)
	}
	for _, c := range r.Cookies() {
		if c.Name == auth.CookieName && (!c.HttpOnly || c.SameSite != http.SameSiteLaxMode || c.Path != "/" || c.MaxAge != 30*86400) {
			t.Fatalf("bad cookie: %+v", c)
		}
	}
	status(t, f.request("POST", "/api/auth/dev", map[string]string{"email": "other@example.com"}, "", nil), 403)
	status(t, f.request("GET", "/api/auth/me", nil, "draw_session=garbage", nil), 401)
	var stored string
	if err := f.s.Store.DB.QueryRow("SELECT token_hash FROM sessions").Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored == strings.TrimPrefix(cookie, "draw_session=") || len(stored) != 64 {
		t.Fatal("session not hashed")
	}
	status(t, f.request("POST", "/api/auth/logout", nil, cookie, map[string]string{"Origin": "", "Sec-Fetch-Site": "same-origin"}), 204)
	status(t, f.request("GET", "/api/auth/me", nil, cookie, nil), 401)
}
func TestScenesPermissionsCollectionsLibrary(t *testing.T) {
	f := setup(t, true)
	owner := f.login("owner@example.com")
	other := f.login("other@example.com")
	scene := f.scene(owner)
	base := "/api/scenes/" + scene.Scene.ID
	if len(scene.Scene.ID) != 20 || len(scene.RoomKey) != 22 || scene.Permission != "owner" || scene.Scene.CollectionID != nil {
		t.Fatalf("%+v", scene)
	}
	for _, tt := range []struct {
		mode, cookie string
		want         int
		permission   string
	}{
		{"private", owner, 200, "owner"}, {"private", other, 403, ""}, {"private", "", 401, ""},
		{"edit", other, 200, "edit"}, {"edit", "", 200, "edit"}, {"view", other, 200, "view"}, {"view", "", 200, "view"},
	} {
		status(t, f.request("PATCH", base, map[string]any{"shareMode": tt.mode}, owner, nil), 200)
		r := f.request("GET", base, nil, tt.cookie, nil)
		status(t, r, tt.want)
		if tt.want == 200 {
			a := readJSON[sceneAccess](t, r)
			if a.Permission != tt.permission || a.RoomKey != scene.RoomKey {
				t.Fatal(a)
			}
		}
	}
	status(t, f.request("PATCH", base, map[string]any{"name": "bad"}, other, nil), 403)
	status(t, f.request("PATCH", base, map[string]any{"shareMode": "edit"}, owner, nil), 200)
	status(t, f.request("DELETE", base, nil, owner, nil), 204)
	status(t, f.request("GET", base, nil, other, nil), 403)
	status(t, f.request("GET", base, nil, "", nil), 401)
	status(t, f.request("GET", base, nil, owner, nil), 200)
	r := f.request("GET", "/api/scenes?trash=1", nil, owner, nil)
	if got := readJSON[struct{ Scenes []store.Scene }](t, r); len(got.Scenes) != 1 {
		t.Fatal(got)
	}
	status(t, f.request("POST", base+"/restore", nil, owner, nil), 200)
	r = f.request("POST", "/api/collections", map[string]any{"name": "Work"}, owner, nil)
	status(t, r, 201)
	c := readJSON[Collection](t, r)
	status(t, f.request("PATCH", base, map[string]any{"collectionId": c.ID, "name": "Diagram"}, owner, nil), 200)
	r = f.request("GET", "/api/scenes?collection="+c.ID+"&q=Dia&sort=name&order=asc", nil, owner, nil)
	if got := readJSON[struct{ Scenes []store.Scene }](t, r); len(got.Scenes) != 1 {
		t.Fatal(got)
	}
	r = f.request("GET", "/api/collections", nil, owner, nil)
	if got := readJSON[struct{ Collections []Collection }](t, r); len(got.Collections) != 1 || got.Collections[0].SceneCount != 1 {
		t.Fatal(got)
	}
	status(t, f.request("PATCH", "/api/collections/"+c.ID, map[string]any{"name": "Renamed"}, owner, nil), 200)
	status(t, f.request("DELETE", "/api/collections/"+c.ID, nil, other, nil), 404)
	foreign := f.scene(other)
	status(t, f.request("PATCH", "/api/scenes/"+foreign.Scene.ID, map[string]any{"collectionId": c.ID}, other, nil), 403)
	status(t, f.request("DELETE", "/api/collections/"+c.ID, nil, owner, nil), 204)
	r = f.request("GET", base, nil, owner, nil)
	if readJSON[sceneAccess](t, r).Scene.CollectionID != nil {
		t.Fatal("collection not cleared")
	}
	status(t, f.request("GET", "/api/library", nil, owner, nil), 204)
	library := []byte("{ \"type\": \"excalidrawlib\", \"libraryItems\": [] }")
	status(t, f.request("PUT", "/api/library", library, owner, nil), 204)
	r = f.request("GET", "/api/library", nil, owner, nil)
	b, _ := io.ReadAll(r.Body)
	if !bytes.Equal(b, library) {
		t.Fatal("library changed")
	}
	status(t, f.request("PUT", "/api/library", []byte("[]"), owner, nil), 400)
	status(t, f.request("GET", "/api/library", nil, "", nil), 401)
	status(t, f.request("DELETE", base+"?permanent=1", nil, owner, nil), 204)
	status(t, f.request("GET", base, nil, owner, nil), 404)
}
func TestRoomsHistoryConcurrency(t *testing.T) {
	f := setup(t, true)
	owner := f.login("owner@example.com")
	scene := f.scene(owner)
	path := "/api/rooms/" + scene.Scene.ID
	iv, ct, err := crypt.Encrypt(scene.RoomKey, []byte("[]"))
	if err != nil {
		t.Fatal(err)
	}
	payload := map[string]any{"sceneVersion": 1, "iv": iv, "ciphertext": ct}
	status(t, f.request("GET", path, nil, owner, nil), 404)
	status(t, f.request("PUT", path, payload, owner, map[string]string{"If-None-Match": "*"}), 201)
	status(t, f.request("PUT", path, payload, owner, map[string]string{"If-None-Match": "*"}), 412)
	status(t, f.request("PUT", path, payload, owner, map[string]string{"If-Match": "\"99\""}), 412)
	status(t, f.request("PUT", path, payload, owner, nil), 412)
	r := f.request("GET", path, nil, owner, nil)
	status(t, r, 200)
	if r.Header.Get("ETag") != "\"1\"" {
		t.Fatal(r.Header)
	}
	room := readJSON[Room](t, r)
	if !bytes.Equal(room.Ciphertext, ct) {
		t.Fatal(room)
	}
	codes := make(chan int, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := f.request("PUT", path, payload, owner, map[string]string{"If-Match": "\"1\""})
			codes <- r.StatusCode
			r.Body.Close()
		}()
	}
	wg.Wait()
	close(codes)
	counts := map[int]int{}
	for c := range codes {
		counts[c]++
	}
	if counts[200] != 1 || counts[412] != 1 {
		t.Fatal(counts)
	}
	status(t, f.request("PUT", path, payload, owner, map[string]string{"If-Match": "\"2\""}), 200)
	r = f.request("GET", path+"/versions", nil, owner, nil)
	v := readJSON[struct {
		Versions []struct {
			Rev   int
			Bytes int
		}
	}](t, r)
	if len(v.Versions) != 2 || v.Versions[0].Rev != 3 || v.Versions[0].Bytes != len(iv)+len(ct) {
		t.Fatal(v)
	}
	status(t, f.request("GET", path+"/versions/1", nil, owner, nil), 404)
	status(t, f.request("GET", path+"/versions/2", nil, owner, nil), 200)
	status(t, f.request("PUT", "/api/rooms/legacy-room", payload, "", map[string]string{"If-None-Match": "*"}), 401)
	status(t, f.request("PUT", "/api/rooms/legacy-room", payload, owner, map[string]string{"If-None-Match": "*"}), 201)
	status(t, f.request("PUT", "/api/rooms/legacy-room", payload, "", map[string]string{"If-Match": "\"1\""}), 200)
	f.s.Config.MaxRoomBytes = 30
	status(t, f.request("PUT", path, payload, owner, map[string]string{"If-Match": "\"3\""}), 413)
}
func TestFilesSnapshotsThumbnailsDuplicate(t *testing.T) {
	f := setup(t, true)
	owner := f.login("owner@example.com")
	scene := f.scene(owner)
	base := "/api/scenes/" + scene.Scene.ID
	plaintext := []byte(`[{"id":"image","version":3,"type":"image","fileId":"file1"}]`)
	iv, ct, _ := crypt.Encrypt(scene.RoomKey, plaintext)
	status(t, f.request("PUT", "/api/rooms/"+scene.Scene.ID, map[string]any{"sceneVersion": 3, "iv": iv, "ciphertext": ct}, owner, map[string]string{"If-None-Match": "*"}), 201)
	file, _ := crypt.Compress(scene.RoomKey, json.RawMessage(`{"id":"file1","mimeType":"image/png"}`), []byte("data:image/png;base64,aGk="))
	filePath := "/api/files/rooms/" + scene.Scene.ID + "/file1"
	status(t, f.request("PUT", filePath, file, owner, nil), 204)
	r := f.request("GET", filePath, nil, owner, nil)
	status(t, r, 200)
	b, _ := io.ReadAll(r.Body)
	if !bytes.Equal(b, file) || r.Header.Get("Cache-Control") != "private, max-age=31536000, immutable" {
		t.Fatal("file round trip")
	}
	status(t, f.request("PUT", filePath, make([]byte, 257), owner, nil), 413)
	status(t, f.request("PUT", "/api/files/rooms/"+scene.Scene.ID+"/bad.id", nil, owner, nil), 400)
	status(t, f.request("GET", filePath, nil, "", nil), 401)
	var pngData bytes.Buffer
	_ = png.Encode(&pngData, image.NewRGBA(image.Rect(0, 0, 2, 2)))
	status(t, f.request("PUT", base+"/thumbnail", pngData.Bytes(), owner, map[string]string{"Content-Type": "image/png"}), 204)
	r = f.request("GET", base+"/thumbnail", nil, owner, nil)
	status(t, r, 200)
	if r.Header.Get("ETag") == "" || r.Header.Get("Cache-Control") != "private, max-age=60" {
		t.Fatal(r.Header)
	}
	status(t, f.request("GET", base+"/thumbnail", nil, owner, map[string]string{"If-None-Match": r.Header.Get("ETag")}), 304)
	status(t, f.request("PUT", base+"/thumbnail", []byte("not png"), owner, map[string]string{"Content-Type": "image/png"}), 400)
	status(t, f.request("PUT", base+"/thumbnail", make([]byte, (512<<10)+1), owner, map[string]string{"Content-Type": "image/png"}), 413)
	r = f.request("POST", base+"/duplicate", map[string]any{}, owner, nil)
	status(t, r, 201)
	copy := readJSON[sceneAccess](t, r)
	if copy.RoomKey == scene.RoomKey || !copy.Scene.HasThumbnail || copy.Scene.Name != "Untitled (copy)" {
		t.Fatal(copy)
	}
	r = f.request("GET", "/api/rooms/"+copy.Scene.ID, nil, owner, nil)
	room := readJSON[Room](t, r)
	p, err := crypt.Decrypt(copy.RoomKey, room.IV, room.Ciphertext)
	if err != nil || !bytes.Equal(p, plaintext) {
		t.Fatalf("duplicate decrypt %v", err)
	}
	if _, err = crypt.Decrypt(scene.RoomKey, room.IV, room.Ciphertext); err == nil {
		t.Fatal("old key decrypts duplicate")
	}
	r = f.request("GET", "/api/files/rooms/"+copy.Scene.ID+"/file1", nil, owner, nil)
	b, _ = io.ReadAll(r.Body)
	_, p, err = crypt.Decompress(copy.RoomKey, b)
	if err != nil || string(p) != "data:image/png;base64,aGk=" {
		t.Fatalf("duplicate file %v", err)
	}
	r = f.request("POST", "/api/v2/post", []byte("snapshot"), "", nil)
	status(t, r, 200)
	snap := readJSON[struct{ ID string }](t, r)
	r = f.request("GET", "/api/v2/"+snap.ID, nil, "", nil)
	status(t, r, 200)
	b, _ = io.ReadAll(r.Body)
	if string(b) != "snapshot" || !strings.HasPrefix(r.Header.Get("Cache-Control"), "public") {
		t.Fatal("snapshot round trip")
	}
	status(t, f.request("PUT", "/api/files/shareLinks/"+snap.ID+"/file1", file, "", nil), 204)
	status(t, f.request("GET", "/api/files/shareLinks/"+snap.ID+"/file1", nil, "", nil), 200)
	status(t, f.request("PUT", "/api/files/shareLinks/00000000000000000000/file1", file, "", nil), 404)
	status(t, f.request("PATCH", base, map[string]string{"shareMode": "view"}, owner, nil), 200)
	status(t, f.request("GET", filePath, nil, "", nil), 200)
	r = f.request("PUT", filePath, file, "", nil)
	if r.StatusCode != 403 && r.StatusCode != 401 {
		t.Fatal(r.StatusCode)
	}
	status(t, f.request("DELETE", base+"?permanent=1", nil, owner, nil), 204)
	if _, err = os.Stat(f.s.Store.File("rooms", scene.Scene.ID, "")); !os.IsNotExist(err) {
		t.Fatal("files remain")
	}
	if _, err = os.Stat(f.s.Store.Thumb(scene.Scene.ID)); !os.IsNotExist(err) {
		t.Fatal("thumbnail remains")
	}
}
func TestStaticAndLimits(t *testing.T) {
	f := setup(t, true)
	for _, tt := range []struct {
		path, cache string
		status      int
	}{
		{"/s/missing", "no-cache", 200}, {"/local", "no-cache", 200}, {"/index.html", "no-cache", 200}, {"/sw.js", "no-cache", 200}, {"/manifest.webmanifest", "no-cache", 200},
		{"/assets/a-123.js", "public, max-age=31536000, immutable", 200}, {"/fonts/a.woff2", "public, max-age=31536000, immutable", 200}, {"/locales/en.json", "public, max-age=31536000, immutable", 200},
		{"/api/missing", "no-store", 404}, {"/api", "no-store", 404},
	} {
		t.Run(tt.path, func(t *testing.T) {
			r := f.request("GET", tt.path, nil, "", nil)
			status(t, r, tt.status)
			if r.Header.Get("Cache-Control") != tt.cache {
				t.Fatal(r.Header)
			}
		})
	}
	for i := 0; i < 31; i++ {
		r := f.request("POST", "/api/v2/post", []byte("x"), "", nil)
		want := 200
		if i == 30 {
			want = 429
		}
		status(t, r, want)
	}
	for i := 0; i < 21; i++ {
		r := f.request("GET", "/api/auth/oidc/start", nil, "", nil)
		want := 200
		if i == 20 {
			want = 429
		}
		status(t, r, want)
	}
	status(t, f.request("GET", "/api/health", nil, "", nil), 200)
}
func TestNoPartialDuplicate(t *testing.T) {
	f := setup(t, true)
	owner := f.login("owner@example.com")
	scene := f.scene(owner)
	status(t, f.request("PUT", "/api/files/rooms/"+scene.Scene.ID+"/broken", []byte("broken"), owner, nil), 204)
	status(t, f.request("POST", "/api/scenes/"+scene.Scene.ID+"/duplicate", map[string]any{}, owner, nil), 500)
	r := f.request("GET", "/api/scenes", nil, owner, nil)
	got := readJSON[struct{ Scenes []store.Scene }](t, r)
	if len(got.Scenes) != 1 {
		t.Fatal(fmt.Sprint(got))
	}
}

func TestAuthenticatedLimitsAndForwardedIP(t *testing.T) {
	f := setup(t, true)
	cookie := f.login("owner@example.com")
	for range 600 {
		f.s.limiter.allow("general:127.0.0.1", 600, time.Minute, time.Now())
	}
	status(t, f.request("GET", "/api/health", nil, "", nil), 429)
	status(t, f.request("GET", "/api/scenes", nil, cookie, nil), 200)
	f.s.Config.TrustProxy = true
	status(t, f.request("GET", "/api/health", nil, "", map[string]string{"X-Forwarded-For": "192.0.2.1, 10.0.0.1"}), 200)
	if got := f.s.ip(&http.Request{Header: http.Header{"X-Forwarded-For": []string{"192.0.2.1, 10.0.0.1"}}, RemoteAddr: "127.0.0.1:1"}); got != "192.0.2.1" {
		t.Fatal(got)
	}
	status(t, f.request("GET", "/api/ws", nil, "", map[string]string{"X-Forwarded-For": "192.0.2.1"}), 426)
}
