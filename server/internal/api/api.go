package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"git.harivan.sh/harivansh-afk/draw/server/internal/auth"
	"git.harivan.sh/harivansh-afk/draw/server/internal/config"
	"git.harivan.sh/harivansh-afk/draw/server/internal/static"
	"git.harivan.sh/harivansh-afk/draw/server/internal/store"
	"git.harivan.sh/harivansh-afk/draw/server/internal/ws"
)

type Server struct {
	Store   *store.Store
	Auth    *auth.Auth
	Config  config.Config
	Hub     *ws.Hub
	Log     *slog.Logger
	limiter limiter
}
type failure struct {
	status        int
	code, message string
}

func (e failure) Error() string { return e.message }
func bad(message string) error  { return failure{400, "bad_request", message} }
func forbidden() error          { return failure{403, "forbidden", "Permission denied"} }
func unauthorized() error       { return failure{401, "unauthorized", "Sign in required"} }
func notFound() error           { return failure{404, "not_found", "Not found"} }
func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func (s *Server) fail(w http.ResponseWriter, err error) {
	var f failure
	if !errors.As(err, &f) {
		if errors.Is(err, sql.ErrNoRows) {
			f = failure{404, "not_found", "Not found"}
		} else {
			s.Log.Error("request failed", "error", err)
			f = failure{500, "internal_error", "Internal server error"}
		}
	}
	JSON(w, f.status, map[string]string{"error": f.code, "message": f.message})
}

type handler func(http.ResponseWriter, *http.Request) error

func (s *Server) wrap(h handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := h(w, r); err != nil {
			s.fail(w, err)
		}
	}
}
func (s *Server) Handler(files fs.FS) http.Handler {
	mux := http.NewServeMux()
	routes := map[string]handler{
		"GET /api/health": func(w http.ResponseWriter, r *http.Request) error {
			JSON(w, 200, map[string]any{"ok": true, "version": Version})
			return nil
		},
		"GET /api/auth/config": func(w http.ResponseWriter, r *http.Request) error {
			JSON(w, 200, map[string]any{"devLogin": s.Config.DevLogin, "provider": "Google"})
			return nil
		},
		"GET /api/auth/me": func(w http.ResponseWriter, r *http.Request) error {
			u := auth.Current(r).User
			if u == nil {
				return unauthorized()
			}
			JSON(w, 200, map[string]any{"user": u})
			return nil
		},
		"POST /api/auth/dev": s.devLogin,
		"POST /api/auth/logout": func(w http.ResponseWriter, r *http.Request) error {
			if err := s.Auth.Logout(w, r); err != nil {
				return err
			}
			w.WriteHeader(204)
			return nil
		},
		"GET /api/auth/oidc/start":    func(w http.ResponseWriter, r *http.Request) error { s.Auth.Start(w, r); return nil },
		"GET /api/auth/oidc/callback": func(w http.ResponseWriter, r *http.Request) error { s.Auth.Callback(w, r); return nil },
		"GET /api/scenes":             s.listScenes, "POST /api/scenes": s.createScene,
		"GET /api/scenes/{id}": s.getScene, "PATCH /api/scenes/{id}": s.patchScene, "DELETE /api/scenes/{id}": s.deleteScene,
		"POST /api/scenes/{id}/restore": s.restoreScene, "POST /api/scenes/{id}/duplicate": s.duplicateScene,
		"PUT /api/scenes/{id}/thumbnail": s.putThumbnail, "GET /api/scenes/{id}/thumbnail": s.getThumbnail,
		"GET /api/collections": s.listCollections, "POST /api/collections": s.createCollection,
		"PATCH /api/collections/{id}": s.patchCollection, "DELETE /api/collections/{id}": s.deleteCollection,
		"GET /api/library": s.getLibrary, "PUT /api/library": s.putLibrary,
		"GET /api/rooms/{roomId}": s.getRoom, "PUT /api/rooms/{roomId}": s.putRoom,
		"GET /api/rooms/{roomId}/versions": s.roomVersions, "GET /api/rooms/{roomId}/versions/{rev}": s.getRoom,
		"PUT /api/files/{kind}/{roomId}/{fileId}": s.putFile, "GET /api/files/{kind}/{roomId}/{fileId}": s.getFile,
		"POST /api/v2/post": s.postSnapshot, "GET /api/v2/{id}": s.getSnapshot,
	}
	for p, h := range routes {
		mux.HandleFunc(p, s.wrap(h))
	}
	mux.Handle("GET /api/ws", s.Hub)
	mux.HandleFunc("/api/", s.wrap(func(w http.ResponseWriter, r *http.Request) error { return notFound() }))
	mux.HandleFunc("/api", s.wrap(func(w http.ResponseWriter, r *http.Request) error { return notFound() }))
	mux.Handle("/", static.Handler(files))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		out := &response{ResponseWriter: w, status: 200}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		defer func() {
			s.Log.Info("http", "method", r.Method, "path", r.URL.Path, "status", out.status, "duration", time.Since(start), "user_id", userID(r), "ip", s.ip(r))
		}()
		identified, err := s.Auth.Identify(out, r)
		if err != nil {
			s.fail(out, err)
			return
		}
		r = identified
		if !auth.CSRF(r, s.Config.BaseURL) {
			s.fail(out, forbidden())
			return
		}
		bucket, limit, window := "general", 600, time.Minute
		if r.URL.Path == "/api/auth/oidc/start" || r.URL.Path == "/api/auth/dev" {
			bucket, limit, window = "signin", 20, time.Minute
		}
		if r.Method == "POST" && r.URL.Path == "/api/v2/post" {
			bucket, limit, window = "snapshot", 30, time.Hour
		}
		key := s.ip(r)
		if bucket == "general" && auth.Current(r).SessionHash != "" {
			key = auth.Current(r).SessionHash
		}
		if !s.limiter.allow(bucket+":"+key, limit, window, time.Now()) {
			out.Header().Set("Retry-After", fmt.Sprint(int(window.Seconds())))
			s.fail(out, failure{429, "rate_limited", "Too many requests"})
			return
		}
		mux.ServeHTTP(out, r)
	})
}

var Version = "dev"

type response struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (w *response) WriteHeader(status int) {
	if !w.wrote {
		w.status = status
		w.wrote = true
		w.ResponseWriter.WriteHeader(status)
	}
}
func (w *response) Write(b []byte) (int, error) {
	if !w.wrote {
		w.WriteHeader(200)
	}
	return w.ResponseWriter.Write(b)
}
func (w *response) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (s *Server) ip(r *http.Request) string {
	if s.Config.TrustProxy {
		if v := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-For"), ",")[0]); net.ParseIP(v) != nil {
			return v
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return host
	}
	return r.RemoteAddr
}
func userID(r *http.Request) string {
	if u := auth.Current(r).User; u != nil {
		return u.ID
	}
	return ""
}
func requireUser(r *http.Request) (string, error) {
	id := userID(r)
	if id == "" {
		return "", unauthorized()
	}
	return id, nil
}
func body(w http.ResponseWriter, r *http.Request, max int64) ([]byte, error) {
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, max))
	if err != nil {
		var large *http.MaxBytesError
		if errors.As(err, &large) {
			return nil, failure{413, "too_large", "Request body exceeds the size limit"}
		}
		return nil, bad("Cannot read body")
	}
	return b, nil
}
func decode(w http.ResponseWriter, r *http.Request, v any, max int64) error {
	b, err := body(w, r, max)
	if err != nil {
		return err
	}
	if len(bytes.TrimSpace(b)) == 0 {
		return bad("JSON object required")
	}
	if bytes.TrimSpace(b)[0] != '{' {
		return bad("JSON object required")
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if err = d.Decode(v); err != nil {
		return bad("Invalid JSON body")
	}
	if d.Decode(new(any)) != io.EOF {
		return bad("Invalid JSON body")
	}
	return nil
}
func (s *Server) devLogin(w http.ResponseWriter, r *http.Request) error {
	if !s.Config.DevLogin {
		return notFound()
	}
	var v struct{ Email, Name string }
	if err := decode(w, r, &v, 4096); err != nil {
		return err
	}
	u, err := s.Auth.Login("draw:dev", strings.ToLower(strings.TrimSpace(v.Email)), v.Email, v.Name, "")
	if errors.Is(err, auth.ErrNotAllowed) {
		return failure{403, "not_allowed", "This account is not allowed here"}
	}
	if err != nil {
		return err
	}
	if err = s.Auth.Session(w, u); err != nil {
		return err
	}
	w.WriteHeader(204)
	return nil
}
func (s *Server) sceneAccess(r *http.Request, owner, write bool) (store.Scene, string, error) {
	id := r.PathValue("id")
	if !store.ValidID(id) {
		return store.Scene{}, "", bad("Invalid scene id")
	}
	scene, err := s.Store.Scene(id)
	if err != nil {
		return scene, "", err
	}
	p := store.Permission(userID(r), scene)
	if p == "none" || (owner && p != "owner") || (write && !store.CanWrite(p)) {
		if userID(r) == "" && p == "none" {
			return scene, p, unauthorized()
		}
		return scene, p, forbidden()
	}
	return scene, p, nil
}
func (s *Server) roomAccess(r *http.Request, write bool) error {
	id := r.PathValue("roomId")
	if !store.ValidID(id) {
		return bad("Invalid room id")
	}
	p, err := s.Store.RoomPermission(userID(r), id)
	if err != nil {
		return err
	}
	if p == "none" || (write && !store.CanWrite(p)) {
		if userID(r) == "" {
			if scene, err := s.Store.Scene(id); err == nil && store.Permission("", scene) != "none" {
				return forbidden()
			}
			return unauthorized()
		}
		return forbidden()
	}
	return nil
}

type limitEntry struct {
	count int
	until time.Time
}
type limiter struct {
	mu        sync.Mutex
	entries   map[string]limitEntry
	lastSweep time.Time
}

func (l *limiter) allow(key string, n int, window time.Duration, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.entries == nil {
		l.entries = map[string]limitEntry{}
	}
	if now.Sub(l.lastSweep) > time.Minute {
		for k, v := range l.entries {
			if !now.Before(v.until) {
				delete(l.entries, k)
			}
		}
		l.lastSweep = now
	}
	e := l.entries[key]
	if !now.Before(e.until) {
		e = limitEntry{until: now.Add(window)}
	}
	e.count++
	l.entries[key] = e
	return e.count <= n
}
