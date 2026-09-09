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
		t.Cleanup(func() {
			conn.CloseNow()
		})
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
	go func() {
		_, _, err := owner.c.Read(context.Background())
		closed <- err
	}()
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
	c := &client{ctx: ctx, cancel: cancel, send: make(chan outbound, sendQueueCount)}
	h := &Hub{}
	for range volatileQueueThreshold + 1 {
		c.send <- outbound{}
	}
	h.emit(c, "volatile", true)
	if len(c.send) != volatileQueueThreshold+1 {
		t.Fatal("volatile not dropped")
	}
	h.emit(c, "regular", false)
	if len(c.send) != volatileQueueThreshold+2 {
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

func TestAnonymousAdHocBroadcast(t *testing.T) {
	s, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	cfg := config.Config{BaseURL: "http://draw.example", MaxRoomBytes: 8 << 20}
	h := New(s, cfg)
	server := httptest.NewServer(h)
	defer server.Close()
	defer h.Close()
	dial := func() peer {
		conn, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(server.URL, "http"), &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {cfg.BaseURL}}})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			conn.CloseNow()
		})
		p := peer{t: t, c: conn}
		p.id = p.read("hello").Args[0].(string)
		p.read("init-room")
		return p
	}
	a, b := dial(), dial()
	room := "unsaved-anonymous"
	a.send("join-room", room)
	a.read("first-in-room")
	a.read("room-user-change")
	b.send("join-room", room)
	a.read("new-user")
	a.read("room-user-change")
	b.read("room-user-change")
	ct, iv := bytes.Repeat([]byte{7}, 32), bytes.Repeat([]byte{8}, 12)
	for _, pair := range [][2]peer{{a, b}, {b, a}} {
		pair[0].send("server-broadcast", room, ct, iv)
		m := pair[1].read("client-broadcast")
		if !bytes.Equal(m.Args[0].([]byte), ct) || !bytes.Equal(m.Args[1].([]byte), iv) {
			t.Fatal(m)
		}
	}
	if p, err := s.RoomPermission("", room); err != nil || p != "view" {
		t.Fatalf("HTTP create permission changed: %s, %v", p, err)
	}
}

func queuedClient(t *testing.T, id string) *client {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	return &client{id: id, ctx: ctx, cancel: cancel, send: make(chan outbound, sendQueueCount)}
}

func TestBroadcastSharesFrameAndBoundsBytes(t *testing.T) {
	h := &Hub{}
	a, b := queuedClient(t, "a"), queuedClient(t, "b")
	members := map[string]*client{"a": a, "b": b}
	payload := make([]byte, (8<<20)-128)
	h.broadcast(members, nil, "client-broadcast", false, payload, make([]byte, 12))
	first, second := <-a.send, <-b.send
	if &first.data[0] != &second.data[0] {
		t.Fatal("broadcast encoded a separate frame per recipient")
	}
	a.queuedBytes.Add(-int64(len(first.data)))
	b.queuedBytes.Add(-int64(len(second.data)))
	for range 2 {
		h.broadcast(members, nil, "client-broadcast", false, payload, make([]byte, 12))
	}
	if a.queuedBytes.Load() > sendQueueBytes || len(a.send) != 2 {
		t.Fatal("unexpected queue size", a.queuedBytes.Load(), len(a.send))
	}
	h.broadcast(members, nil, "client-broadcast", true, payload, make([]byte, 12))
	if len(a.send) != 2 || a.ctx.Err() != nil {
		t.Fatal("volatile overflow should be dropped")
	}
	h.broadcast(members, nil, "client-broadcast", false, payload, make([]byte, 12))
	if a.ctx.Err() == nil || b.ctx.Err() == nil || len(a.send) != 2 || a.queuedBytes.Load() > sendQueueBytes {
		t.Fatal("regular byte overflow did not disconnect")
	}
	c := queuedClient(t, "count")
	for range sendQueueCount + 1 {
		h.emit(c, "small", false)
	}
	if len(c.send) != sendQueueCount || c.ctx.Err() == nil {
		t.Fatal("count overflow did not disconnect")
	}
}

func TestPermissionQueriesDoNotBlockBroadcast(t *testing.T) {
	for _, operation := range []string{"join", "recheck"} {
		t.Run(operation, func(t *testing.T) {
			s, err := store.Open(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			h := New(s, config.Config{})
			a, b, checked := queuedClient(t, "a"), queuedClient(t, "b"), queuedClient(t, "checked")
			a.room, a.permission, b.room = "active", "edit", "active"
			checked.room, checked.permission = "old", "edit"
			h.rooms["active"] = map[string]*client{"a": a, "b": b}
			conn, err := s.DB.Conn(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			before := s.DB.Stats().WaitCount
			finished := make(chan struct{})
			go func() {
				defer close(finished)
				if operation == "join" {
					h.handle(checked, Message{Event: "join-room", Args: []any{"new"}})
				} else {
					h.recheck(checked)
				}
			}()
			deadline := time.Now().Add(3 * time.Second)
			for s.DB.Stats().WaitCount == before {
				if time.Now().After(deadline) {
					t.Fatal("permission query did not wait for the held connection")
				}
				time.Sleep(time.Millisecond)
			}
			broadcast := make(chan struct{})
			go func() {
				h.handle(a, Message{Event: "server-broadcast", Args: []any{"active", make([]byte, 16), make([]byte, 12)}})
				close(broadcast)
			}()
			select {
			case <-broadcast:
			case <-time.After(time.Second):
				t.Fatal("SQLite query held hub mutex and blocked another room")
			}
			if len(b.send) != 1 {
				t.Fatal("broadcast not delivered")
			}
			// A membership change while SQLite is busy must invalidate the stale result.
			h.mu.Lock()
			h.leave(checked)
			checked.room, checked.permission = "replacement", "view"
			h.mu.Unlock()
			conn.Close()
			select {
			case <-finished:
			case <-time.After(3 * time.Second):
				t.Fatal("permission query did not finish")
			}
			if checked.room != "replacement" || checked.permission != "view" {
				t.Fatal("stale permission result applied to new membership")
			}
		})
	}
}
