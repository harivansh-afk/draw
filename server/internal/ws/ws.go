package ws

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"git.harivan.sh/harivansh-afk/draw/server/internal/auth"
	"git.harivan.sh/harivansh-afk/draw/server/internal/config"
	crypt "git.harivan.sh/harivansh-afk/draw/server/internal/crypto"
	"git.harivan.sh/harivansh-afk/draw/server/internal/store"
	"github.com/coder/websocket"
)

type outbound struct {
	data  []byte
	close websocket.StatusCode
}
type client struct {
	id, user, session, room, permission string
	conn                                *websocket.Conn
	send                                chan outbound
	ctx                                 context.Context
	cancel                              context.CancelFunc
	done                                chan struct{}
}
type Hub struct {
	store   *store.Store
	config  config.Config
	mu      sync.Mutex
	clients map[string]*client
	rooms   map[string]map[string]*client
	follows map[string]map[string]*client
	closed  bool
	wg      sync.WaitGroup
}

func New(s *store.Store, c config.Config) *Hub {
	return &Hub{store: s, config: c, clients: map[string]*client{}, rooms: map[string]map[string]*client{}, follows: map[string]map[string]*client{}}
}
func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Origin") != h.config.BaseURL {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(403)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "forbidden", "message": "WebSocket origin rejected"})
		return
	}
	// The exact origin comparison above is stricter than the library's host-pattern check.
	conn, err := websocket.Accept(&upgradeResponse{ResponseWriter: w}, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	c := &client{id: crypt.Key(), conn: conn, send: make(chan outbound, 128), ctx: ctx, cancel: cancel, done: make(chan struct{})}
	identity := auth.Current(r)
	c.session = identity.SessionHash
	if identity.User != nil {
		c.user = identity.User.ID
	}
	conn.SetReadLimit(max(h.config.MaxRoomBytes, 1<<20))
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		_ = conn.Close(websocket.StatusGoingAway, "server shutdown")
		return
	}
	h.clients[c.id] = c
	h.wg.Add(1)
	h.mu.Unlock()
	defer h.wg.Done()
	go c.writer()
	h.mu.Lock()
	h.emit(c, "hello", false, c.id)
	h.emit(c, "init-room", false)
	h.mu.Unlock()
	go h.maintenance(c)
	for {
		kind, b, err := conn.Read(ctx)
		if err != nil {
			break
		}
		m, err := Decode(b)
		if kind != websocket.MessageBinary || err != nil || (m.Event == "server-volatile-broadcast" && len(b) > 1<<20) || (m.Event != "server-volatile-broadcast" && int64(len(b)) > h.config.MaxRoomBytes) {
			h.mu.Lock()
			h.emit(c, "error", false, "bad_message")
			h.mu.Unlock()
			continue
		}
		h.mu.Lock()
		h.handle(c, m)
		h.mu.Unlock()
	}
	h.mu.Lock()
	h.leave(c)
	delete(h.clients, c.id)
	h.mu.Unlock()
	cancel()
	_ = conn.CloseNow()
	<-c.done
}

// Keep failed upgrade responses consistent with the HTTP API error contract.
type upgradeResponse struct {
	http.ResponseWriter
	failed bool
}

func (w *upgradeResponse) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *upgradeResponse) WriteHeader(status int) {
	if status < 400 {
		w.ResponseWriter.WriteHeader(status)
		return
	}
	w.failed = true
	w.Header().Set("Content-Type", "application/json")
	w.ResponseWriter.WriteHeader(status)
	_ = json.NewEncoder(w.ResponseWriter).Encode(map[string]string{"error": "bad_request", "message": "Invalid WebSocket upgrade"})
}
func (w *upgradeResponse) Write(b []byte) (int, error) {
	if w.failed {
		return len(b), nil
	}
	return w.ResponseWriter.Write(b)
}
func (c *client) writer() {
	defer close(c.done)
	defer c.cancel()
	for {
		select {
		case <-c.ctx.Done():
			return
		case item := <-c.send:
			ctx, cancel := context.WithTimeout(c.ctx, 10*time.Second)
			err := c.conn.Write(ctx, websocket.MessageBinary, item.data)
			cancel()
			if err != nil {
				_ = c.conn.CloseNow()
				return
			}
			if item.close != 0 {
				_ = c.conn.Close(item.close, "permission revoked")
				return
			}
		}
	}
}

// All membership changes and queue operations run under h.mu; no network write holds it.
func (h *Hub) emit(c *client, event string, volatile bool, args ...any) {
	if volatile && len(c.send) > 64 {
		return
	}
	select {
	case c.send <- outbound{data: Encode(event, args...)}:
	default:
		c.cancel()
		go c.conn.Close(websocket.StatusPolicyViolation, "slow receiver")
	}
}
func (h *Hub) deny(c *client, close bool) {
	item := outbound{data: Encode("error", "forbidden")}
	if close {
		item.close = 4403
	}
	select {
	case c.send <- item:
	default:
		c.cancel()
	}
}
func ids(m map[string]*client) []string {
	v := []string{}
	for id := range m {
		v = append(v, id)
	}
	sort.Strings(v)
	return v
}
func (h *Hub) leave(c *client) {
	if members := h.rooms[c.room]; members != nil {
		delete(members, c.id)
		if len(members) == 0 {
			delete(h.rooms, c.room)
		} else {
			for _, other := range members {
				h.emit(other, "room-user-change", false, ids(members))
			}
		}
	}
	for target, members := range h.follows {
		if _, ok := members[c.id]; ok {
			delete(members, c.id)
			if followed := h.clients[target]; followed != nil {
				if len(members) == 0 {
					h.emit(followed, "broadcast-unfollow", false)
				} else {
					h.emit(followed, "user-follow-room-change", false, ids(members))
				}
			}
		}
		if len(members) == 0 || target == c.id {
			delete(h.follows, target)
		}
	}
	c.room = ""
	c.permission = ""
}
func (h *Hub) handle(c *client, m Message) {
	bad := func() { h.emit(c, "error", false, "bad_message") }
	switch m.Event {
	case "join-room":
		if len(m.Args) != 1 {
			bad()
			return
		}
		room, ok := m.Args[0].(string)
		if !ok || !store.ValidID(room) {
			bad()
			return
		}
		p, err := h.store.RoomPermission(c.user, room)
		if err != nil || p == "none" {
			h.deny(c, true)
			return
		}
		if c.room == room {
			return
		}
		h.leave(c)
		c.room = room
		c.permission = p
		if h.rooms[room] == nil {
			h.rooms[room] = map[string]*client{}
		}
		members := h.rooms[room]
		if len(members) == 0 {
			h.emit(c, "first-in-room", false)
		} else {
			for _, other := range members {
				h.emit(other, "new-user", false, c.id)
			}
		}
		members[c.id] = c
		for _, other := range members {
			h.emit(other, "room-user-change", false, ids(members))
		}
	case "server-broadcast", "server-volatile-broadcast":
		if len(m.Args) != 3 {
			bad()
			return
		}
		room, ok := m.Args[0].(string)
		ct, okCT := m.Args[1].([]byte)
		iv, okIV := m.Args[2].([]byte)
		if !ok || !okCT || !okIV || len(iv) != 12 || len(ct) < 16 {
			bad()
			return
		}
		volatile := m.Event == "server-volatile-broadcast"
		if c.room == "" || (!volatile && !store.CanWrite(c.permission)) {
			h.deny(c, false)
			return
		}
		members := h.rooms[c.room]
		if strings.HasPrefix(room, "follow@") {
			if !volatile || room != "follow@"+c.id {
				h.deny(c, false)
				return
			}
			members = h.follows[c.id]
		} else if room != c.room {
			h.deny(c, false)
			return
		}
		for _, other := range members {
			if other != c {
				h.emit(other, "client-broadcast", volatile, ct, iv)
			}
		}
	case "user-follow":
		if len(m.Args) != 1 || c.room == "" {
			bad()
			return
		}
		b, _ := json.Marshal(m.Args[0])
		var p struct {
			UserToFollow struct {
				SocketID string `json:"socketId"`
			} `json:"userToFollow"`
			Action string `json:"action"`
		}
		if json.Unmarshal(b, &p) != nil || (p.Action != "FOLLOW" && p.Action != "UNFOLLOW") {
			bad()
			return
		}
		target := h.clients[p.UserToFollow.SocketID]
		if target == nil || target == c || target.room != c.room {
			h.deny(c, false)
			return
		}
		if h.follows[target.id] == nil {
			h.follows[target.id] = map[string]*client{}
		}
		if p.Action == "FOLLOW" {
			h.follows[target.id][c.id] = c
		} else {
			delete(h.follows[target.id], c.id)
		}
		h.emit(target, "user-follow-room-change", false, ids(h.follows[target.id]))
		if len(h.follows[target.id]) == 0 {
			delete(h.follows, target.id)
		}
	default:
		bad()
	}
}
func (h *Hub) maintenance(c *client) {
	go func() {
		ping := time.NewTicker(25 * time.Second)
		defer ping.Stop()
		for {
			select {
			case <-c.ctx.Done():
				return
			case <-ping.C:
				ctx, cancel := context.WithTimeout(c.ctx, 35*time.Second)
				err := c.conn.Ping(ctx)
				cancel()
				if err != nil {
					c.cancel()
					_ = c.conn.CloseNow()
					return
				}
			}
		}
	}()
	check := time.NewTicker(30 * time.Second)
	defer check.Stop()
	for {
		select {
		case <-c.ctx.Done():
			return
		case <-check.C:
			if !h.recheck(c) {
				return
			}
		}
	}
}
func (h *Hub) recheck(c *client) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	uid := c.user
	if c.session != "" {
		var n int
		err := h.store.DB.QueryRow("SELECT count(*) FROM sessions WHERE token_hash=? AND expires_at>?", c.session, store.Now()).Scan(&n)
		if err != nil || n == 0 {
			uid = ""
		}
	}
	if c.room != "" {
		p, err := h.store.RoomPermission(uid, c.room)
		if err != nil || p == "none" || (store.CanWrite(c.permission) && !store.CanWrite(p)) {
			h.deny(c, true)
			return false
		}
		c.permission = p
	}
	c.user = uid
	return true
}
func (h *Hub) Close() {
	h.mu.Lock()
	h.closed = true
	clients := make([]*client, 0, len(h.clients))
	for _, c := range h.clients {
		clients = append(clients, c)
	}
	h.mu.Unlock()
	var wg sync.WaitGroup
	for _, c := range clients {
		wg.Add(1)
		go func() { defer wg.Done(); _ = c.conn.Close(websocket.StatusGoingAway, "server shutdown"); c.cancel() }()
	}
	wg.Wait()
	h.wg.Wait()
}
