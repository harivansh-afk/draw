package ws

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"git.harivan.sh/harivansh-afk/draw/server/internal/auth"
	"git.harivan.sh/harivansh-afk/draw/server/internal/config"
	crypt "git.harivan.sh/harivansh-afk/draw/server/internal/crypto"
	"git.harivan.sh/harivansh-afk/draw/server/internal/store"
	"github.com/coder/websocket"
)

type peer struct {
	t  *testing.T
	c  *websocket.Conn
	id string
}

func (p peer) send(event string, args ...any) {
	p.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := p.c.Write(ctx, websocket.MessageBinary, Encode(event, args...)); err != nil {
		p.t.Fatal(err)
	}
}
func (p peer) read(event string) Message {
	p.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	kind, b, err := p.c.Read(ctx)
	if err != nil {
		p.t.Fatalf("read %s: %v", event, err)
	}
	m, err := Decode(b)
	if err != nil || kind != websocket.MessageBinary || m.Event != event {
		p.t.Fatalf("want %s got %+v: %v", event, m, err)
	}
	return m
}
func TestTwoClients(t *testing.T) {
	c, err := config.Load(nil)
	if err != nil {
		t.Fatal(err)
	}
	c.DataDir = t.TempDir()
	c.SessionKeyFile = c.DataDir + "/session.key"
	c.DevLogin = true
	c.ClientID = ""
	c.ClientSecret = ""
	s, err := store.Open(c.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	a, err := auth.New(context.Background(), s, c)
	if err != nil {
		t.Fatal(err)
	}
	user, err := a.Login("draw:dev", "owner@example.com", "owner@example.com", "Owner", "")
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	if err = a.Session(rec, user); err != nil {
		t.Fatal(err)
	}
	cookie := rec.Result().Cookies()[0]
	room := crypt.ID()
	_, err = s.DB.Exec("INSERT INTO scenes(id,owner_id,name,room_key,share_mode,created_at,updated_at) VALUES(?,?,?,?,'view',?,?)", room, user.ID, "Test", crypt.Key(), store.Now(), store.Now())
	if err != nil {
		t.Fatal(err)
	}
	h := New(s, c)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r, err = a.Identify(w, r)
		if err != nil {
			t.Error(err)
			return
		}
		h.ServeHTTP(w, r)
	}))
	defer server.Close()
	defer h.Close()
	dial := func(cookie *http.Cookie) peer {
		t.Helper()
		headers := http.Header{"Origin": []string{c.BaseURL}}
		if cookie != nil {
			headers.Set("Cookie", cookie.String())
		}
		conn, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(server.URL, "http"), &websocket.DialOptions{HTTPHeader: headers})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { conn.CloseNow() })
		p := peer{t: t, c: conn}
		p.id = p.read("hello").Args[0].(string)
		if len(p.id) != 22 {
			t.Fatal(p.id)
		}
		p.read("init-room")
		return p
	}
	owner, viewer := dial(cookie), dial(nil)
	owner.send("join-room", room)
	owner.read("first-in-room")
	m := owner.read("room-user-change")
	if len(m.Args[0].([]any)) != 1 {
		t.Fatal(m)
	}
	viewer.send("join-room", room)
	if owner.read("new-user").Args[0] != viewer.id {
		t.Fatal("new user")
	}
	owner.read("room-user-change")
	viewer.read("room-user-change")
	ct := bytes.Repeat([]byte{4}, 32)
	iv := bytes.Repeat([]byte{5}, 12)
	owner.send("server-broadcast", room, ct, iv)
	m = viewer.read("client-broadcast")
	if !bytes.Equal(m.Args[0].([]byte), ct) || !bytes.Equal(m.Args[1].([]byte), iv) {
		t.Fatal(m)
	}
	viewer.send("server-volatile-broadcast", room, ct, iv)
	owner.read("client-broadcast")
	viewer.send("server-broadcast", room, ct, iv)
	if viewer.read("error").Args[0] != "forbidden" {
		t.Fatal("viewer write accepted")
	}
	follow := func(action string) {
		viewer.send("user-follow", map[string]any{"userToFollow": map[string]string{"socketId": owner.id, "username": "Owner"}, "action": action})
	}
	follow("FOLLOW")
	m = owner.read("user-follow-room-change")
	if m.Args[0].([]any)[0] != viewer.id {
		t.Fatal(m)
	}
	owner.send("server-volatile-broadcast", "follow@"+owner.id, ct, iv)
	viewer.read("client-broadcast")
	follow("UNFOLLOW")
	m = owner.read("user-follow-room-change")
	if len(m.Args[0].([]any)) != 0 {
		t.Fatal(m)
	}
	follow("FOLLOW")
	owner.read("user-follow-room-change")
	viewer.c.CloseNow()
	owner.read("room-user-change")
	owner.read("broadcast-unfollow")
	viewer = dial(nil)
	viewer.send("join-room", room)
	owner.read("new-user")
	owner.read("room-user-change")
	viewer.read("room-user-change")
	if _, err = s.DB.Exec("UPDATE scenes SET share_mode='private' WHERE id=?", room); err != nil {
		t.Fatal(err)
	}
	h.mu.Lock()
	vc := h.clients[viewer.id]
	h.mu.Unlock()
	if h.recheck(vc) {
		t.Fatal("revocation not detected")
	}
	viewer.read("error")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, _, err = viewer.c.Read(ctx)
	if websocket.CloseStatus(err) != 4403 {
		t.Fatalf("close: %v", err)
	}
	owner.read("room-user-change")
	denied := dial(nil)
	denied.send("join-room", room)
	denied.read("error")
	_, _, err = denied.c.Read(ctx)
	if websocket.CloseStatus(err) != 4403 {
		t.Fatal(err)
	}
	owner.send("join-room", "another-room")
	owner.read("first-in-room")
	owner.read("room-user-change")
	owner.send("server-broadcast", room, ct, iv)
	owner.read("error")
	// Reader must run while Close performs the WebSocket close handshake.
	closed := make(chan error, 1)
	go func() { _, _, err := owner.c.Read(context.Background()); closed <- err }()
	h.Close()
	if err = <-closed; websocket.CloseStatus(err) != websocket.StatusGoingAway {
		t.Fatalf("shutdown: %v", err)
	}
	_, resp, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(server.URL, "http"), &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{"https://evil.example"}}})
	if err == nil || resp.StatusCode != 403 {
		t.Fatal("cross-origin websocket accepted")
	}
}
func TestFraming(t *testing.T) {
	f := Encode("event", "room", []byte{1, 2}, []byte{3})
	m, err := Decode(f)
	if err != nil || len(m.Args) != 3 {
		t.Fatal(m, err)
	}
	for _, frame := range [][]byte{nil, {2, 0, 0, 0, 0}, {1, 255, 255, 255, 255}, append(Encode("e"), 1), frameJSON(`{"e":"e","a":[{"$b":0}],"b":[]}`), frameJSON(`{"e":"e","a":[],"b":[-1]}`), frameJSON(`{"e":"e","a":[{"$b":0.5}],"b":[0]}`)} {
		if _, err := Decode(frame); err == nil {
			t.Fatalf("accepted malformed %v", frame)
		}
	}
}
func frameJSON(raw string) []byte {
	b := Encode("e")
	b = append(b[:5], raw...)
	n := len(raw)
	b[1] = byte(n >> 24)
	b[2] = byte(n >> 16)
	b[3] = byte(n >> 8)
	b[4] = byte(n)
	return b
}
func TestQueuePolicy(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := &client{ctx: ctx, cancel: cancel, send: make(chan outbound, 128)}
	h := &Hub{}
	for range 65 {
		c.send <- outbound{}
	}
	h.emit(c, "volatile", true)
	if len(c.send) != 65 {
		t.Fatal("volatile not dropped")
	}
	h.emit(c, "regular", false)
	if len(c.send) != 66 {
		t.Fatal("regular dropped")
	}
	data := Encode("client-broadcast", []byte{1}, []byte{2})
	m, err := Decode(data)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = json.Marshal(m); err != nil {
		t.Fatal(err)
	}
}
