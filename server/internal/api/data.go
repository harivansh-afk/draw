package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"image/png"
	"net/http"
	"os"
	"strconv"

	crypt "git.harivan.sh/harivansh-afk/draw/server/internal/crypto"
	"git.harivan.sh/harivansh-afk/draw/server/internal/store"
)

type Room struct {
	Rev          int64  `json:"rev"`
	SceneVersion int64  `json:"sceneVersion"`
	IV           []byte `json:"iv"`
	Ciphertext   []byte `json:"ciphertext"`
}

func (s *Server) getRoom(w http.ResponseWriter, r *http.Request) error {
	if err := s.roomAccess(r, false); err != nil {
		return err
	}
	var room Room
	var err error
	if rev := r.PathValue("rev"); rev != "" {
		n, e := strconv.ParseInt(rev, 10, 64)
		if e != nil || n < 1 {
			return bad("Invalid revision")
		}
		err = s.Store.DB.QueryRow("SELECT rev,scene_version,iv,ciphertext FROM room_versions WHERE room_id=? AND rev=?", r.PathValue("roomId"), n).Scan(&room.Rev, &room.SceneVersion, &room.IV, &room.Ciphertext)
	} else {
		err = s.Store.DB.QueryRow("SELECT rev,scene_version,iv,ciphertext FROM rooms WHERE id=?", r.PathValue("roomId")).Scan(&room.Rev, &room.SceneVersion, &room.IV, &room.Ciphertext)
	}
	if err != nil {
		return err
	}
	w.Header().Set("ETag", fmt.Sprintf("%q", strconv.FormatInt(room.Rev, 10)))
	JSON(w, 200, room)
	return nil
}
func (s *Server) putRoom(w http.ResponseWriter, r *http.Request) error {
	var v struct {
		SceneVersion   int64 `json:"sceneVersion"`
		IV, Ciphertext []byte
	}
	if err := decode(w, r, &v, s.Config.MaxRoomBytes); err != nil {
		return err
	}
	if v.SceneVersion < 0 || len(v.IV) != 12 || len(v.Ciphertext) < 16 {
		return bad("Expected a nonnegative sceneVersion, 12-byte IV and AES-GCM ciphertext")
	}
	s.Store.Mutation.Lock()
	defer s.Store.Mutation.Unlock()
	if err := s.roomAccess(r, true); err != nil {
		return err
	}
	previous := int64(0)
	if r.Header.Get("If-None-Match") == "*" && r.Header.Get("If-Match") == "" {
	} else {
		h := r.Header.Get("If-Match")
		if r.Header.Get("If-None-Match") != "" || len(h) < 3 || h[0] != '"' || h[len(h)-1] != '"' {
			return failure{412, "precondition_failed", "A matching room revision is required"}
		}
		var err error
		previous, err = strconv.ParseInt(h[1:len(h)-1], 10, 64)
		if err != nil || previous < 1 {
			return failure{412, "precondition_failed", "Invalid revision"}
		}
	}
	room := Room{SceneVersion: v.SceneVersion, IV: v.IV, Ciphertext: v.Ciphertext}
	if err := s.saveRoom(r.PathValue("roomId"), userID(r), room, previous); err != nil {
		return err
	}
	status := 200
	if previous == 0 {
		status = 201
	}
	w.Header().Set("ETag", fmt.Sprintf("%q", strconv.FormatInt(previous+1, 10)))
	JSON(w, status, map[string]any{"rev": previous + 1})
	return nil
}
func (s *Server) saveRoom(id, uid string, room Room, previous int64) error {
	tx, err := s.Store.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := store.Now()
	rev := previous + 1
	var result sql.Result
	if previous == 0 {
		var creator any
		if uid != "" {
			creator = uid
		}
		result, err = tx.Exec("INSERT INTO rooms(id,rev,scene_version,iv,ciphertext,created_by,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING", id, rev, room.SceneVersion, room.IV, room.Ciphertext, creator, now)
	} else {
		result, err = tx.Exec("UPDATE rooms SET rev=?,scene_version=?,iv=?,ciphertext=?,updated_at=? WHERE id=? AND rev=?", rev, room.SceneVersion, room.IV, room.Ciphertext, now, id, previous)
	}
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return failure{412, "precondition_failed", "Room revision changed"}
	}
	if _, err = tx.Exec("INSERT INTO room_versions VALUES(?,?,?,?,?,?)", id, rev, room.SceneVersion, room.IV, room.Ciphertext, now); err != nil {
		return err
	}
	if _, err = tx.Exec("DELETE FROM room_versions WHERE room_id=? AND rev<=?", id, rev-int64(s.Config.RoomHistory)); err != nil {
		return err
	}
	if _, err = tx.Exec("UPDATE scenes SET updated_at=? WHERE id=?", now, id); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Server) roomVersions(w http.ResponseWriter, r *http.Request) error {
	if err := s.roomAccess(r, false); err != nil {
		return err
	}
	rows, err := s.Store.DB.Query("SELECT rev,scene_version,created_at,length(iv)+length(ciphertext) FROM room_versions WHERE room_id=? ORDER BY rev DESC", r.PathValue("roomId"))
	if err != nil {
		return err
	}
	defer rows.Close()
	type version struct {
		Rev          int64  `json:"rev"`
		SceneVersion int64  `json:"sceneVersion"`
		CreatedAt    string `json:"createdAt"`
		Bytes        int    `json:"bytes"`
	}
	versions := []version{}
	for rows.Next() {
		var v version
		if err = rows.Scan(&v.Rev, &v.SceneVersion, &v.CreatedAt, &v.Bytes); err != nil {
			return err
		}
		versions = append(versions, v)
	}
	if err = rows.Err(); err != nil {
		return err
	}
	JSON(w, 200, map[string]any{"versions": versions})
	return nil
}
func (s *Server) fileAccess(r *http.Request, write bool) error {
	kind, id, file := r.PathValue("kind"), r.PathValue("roomId"), r.PathValue("fileId")
	if !store.ValidID(file) {
		return bad("Invalid file id")
	}
	if kind == "rooms" {
		return s.roomAccess(r, write)
	}
	if kind != "shareLinks" || !store.SnapshotID(id) {
		return bad("Invalid file path")
	}
	var n int
	if err := s.Store.DB.QueryRow("SELECT count(*) FROM snapshots WHERE id=?", id).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return notFound()
	}
	return nil
}
func (s *Server) putFile(w http.ResponseWriter, r *http.Request) error {
	b, err := body(w, r, s.Config.MaxFileBytes)
	if err != nil {
		return err
	}
	s.Store.Mutation.Lock()
	defer s.Store.Mutation.Unlock()
	if err = s.fileAccess(r, true); err != nil {
		return err
	}
	write := store.AtomicWrite
	if r.PathValue("kind") == "shareLinks" {
		write = store.AtomicCreate
	}
	if err = write(s.Store.File(r.PathValue("kind"), r.PathValue("roomId"), r.PathValue("fileId")), b); err != nil {
		return err
	}
	if r.PathValue("kind") == "rooms" {
		if _, err = s.Store.DB.Exec("UPDATE rooms SET updated_at=? WHERE id=?", store.Now(), r.PathValue("roomId")); err != nil {
			return err
		}
	}
	w.WriteHeader(204)
	return nil
}
func (s *Server) getFile(w http.ResponseWriter, r *http.Request) error {
	if err := s.fileAccess(r, false); err != nil {
		return err
	}
	cache := "private, max-age=31536000, immutable"
	if r.PathValue("kind") == "shareLinks" {
		cache = "public, max-age=31536000, immutable"
	}
	return disk(w, r, s.Store.File(r.PathValue("kind"), r.PathValue("roomId"), r.PathValue("fileId")), "application/octet-stream", cache, false)
}
func disk(w http.ResponseWriter, r *http.Request, path, kind, cache string, etag bool) error {
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return notFound()
	}
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", kind)
	w.Header().Set("Cache-Control", cache)
	if etag {
		w.Header().Set("ETag", fmt.Sprintf("\"%x\"", info.ModTime().UnixNano()))
	}
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
	return nil
}
func (s *Server) putThumbnail(w http.ResponseWriter, r *http.Request) error {
	if r.Header.Get("Content-Type") != "image/png" {
		return bad("Expected image/png")
	}
	b, err := body(w, r, 512<<10)
	if err != nil {
		return err
	}
	if _, err = png.DecodeConfig(bytes.NewReader(b)); err != nil {
		return bad("Invalid PNG")
	}
	s.Store.Mutation.Lock()
	defer s.Store.Mutation.Unlock()
	scene, _, err := s.sceneAccess(r, false, true)
	if err != nil {
		return err
	}
	if err = store.AtomicWrite(s.Store.Thumb(scene.ID), b); err != nil {
		return err
	}
	if _, err = s.Store.DB.Exec("UPDATE scenes SET thumbnail_updated_at=? WHERE id=?", store.Now(), scene.ID); err != nil {
		return err
	}
	w.WriteHeader(204)
	return nil
}
func (s *Server) getThumbnail(w http.ResponseWriter, r *http.Request) error {
	scene, _, err := s.sceneAccess(r, false, false)
	if err != nil {
		return err
	}
	return disk(w, r, s.Store.Thumb(scene.ID), "image/png", "private, max-age=60", true)
}
func (s *Server) postSnapshot(w http.ResponseWriter, r *http.Request) error {
	b, err := body(w, r, s.Config.MaxRoomBytes)
	if err != nil {
		var f failure
		if errors.As(err, &f) && f.status == http.StatusRequestEntityTooLarge {
			JSON(w, f.status, map[string]string{"error": f.code, "message": f.message, "error_class": "RequestTooLargeError"})
			return nil
		}
		return err
	}
	id := crypt.ID()
	if _, err = s.Store.DB.Exec("INSERT INTO snapshots VALUES(?,?,?,?)", id, b, store.Now(), s.ip(r)); err != nil {
		return err
	}
	JSON(w, 200, map[string]string{"id": id})
	return nil
}
func (s *Server) getSnapshot(w http.ResponseWriter, r *http.Request) error {
	if !store.SnapshotID(r.PathValue("id")) {
		return bad("Invalid snapshot id")
	}
	var b []byte
	if err := s.Store.DB.QueryRow("SELECT data FROM snapshots WHERE id=?", r.PathValue("id")).Scan(&b); err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	_, _ = w.Write(b)
	return nil
}
func (s *Server) getLibrary(w http.ResponseWriter, r *http.Request) error {
	uid, err := requireUser(r)
	if err != nil {
		return err
	}
	var b []byte
	err = s.Store.DB.QueryRow("SELECT data FROM libraries WHERE user_id=?", uid).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) {
		w.WriteHeader(204)
		return nil
	}
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(b)
	return nil
}
func (s *Server) putLibrary(w http.ResponseWriter, r *http.Request) error {
	uid, err := requireUser(r)
	if err != nil {
		return err
	}
	b, err := body(w, r, 16<<20)
	if err != nil {
		return err
	}
	if !json.Valid(b) || len(bytes.TrimSpace(b)) == 0 || bytes.TrimSpace(b)[0] != '{' {
		return bad("Expected JSON object")
	}
	_, err = s.Store.DB.Exec("INSERT INTO libraries VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at", uid, b, store.Now())
	if err != nil {
		return err
	}
	w.WriteHeader(204)
	return nil
}
