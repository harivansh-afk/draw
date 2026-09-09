package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"

	crypt "git.harivan.sh/harivansh-afk/draw/server/internal/crypto"
	"git.harivan.sh/harivansh-afk/draw/server/internal/store"
)

type SceneAccess struct {
	Scene      store.Scene `json:"scene"`
	Permission string      `json:"permission"`
	RoomKey    string      `json:"roomKey"`
}

func access(scene store.Scene, p string) SceneAccess {
	return SceneAccess{scene, p, scene.RoomKey}
}

func (s *Server) listScenes(w http.ResponseWriter, r *http.Request) error {
	uid, err := requireUser(r)
	if err != nil {
		return err
	}
	q := "SELECT " + store.SceneColumns + " FROM scenes WHERE owner_id=?"
	args := []any{uid}
	if r.URL.Query().Get("trash") == "1" {
		q += " AND deleted_at IS NOT NULL"
	} else {
		q += " AND deleted_at IS NULL"
	}
	collection := r.URL.Query().Get("collection")
	if collection == "none" {
		q += " AND collection_id IS NULL"
	} else if collection != "" && collection != "all" {
		q += " AND collection_id=?"
		args = append(args, collection)
	}
	if search := r.URL.Query().Get("q"); search != "" {
		q += " AND instr(lower(name),lower(?))>0"
		args = append(args, search)
	}
	sort := map[string]string{"name": "name COLLATE NOCASE", "created": "created_at", "updated": "updated_at"}[r.URL.Query().Get("sort")]
	if sort == "" {
		sort = "updated_at"
	}
	order := "DESC"
	if r.URL.Query().Get("order") == "asc" {
		order = "ASC"
	}
	q += " ORDER BY " + sort + " " + order + ", id"
	rows, err := s.Store.DB.Query(q, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	scenes := []store.Scene{}
	for rows.Next() {
		scene, err := store.ScanScene(rows)
		if err != nil {
			return err
		}
		scenes = append(scenes, scene)
	}
	if err = rows.Err(); err != nil {
		return err
	}
	JSON(w, 200, map[string]any{"scenes": scenes})
	return nil
}

func (s *Server) collectionOwner(id *string, uid string) error {
	if id == nil {
		return nil
	}
	var owner string
	err := s.Store.DB.QueryRow("SELECT owner_id FROM collections WHERE id=?", *id).Scan(&owner)
	if errors.Is(err, sql.ErrNoRows) {
		return bad("Unknown collection")
	}
	if err != nil {
		return err
	}
	if owner != uid {
		return forbidden()
	}
	return nil
}

func validName(name string) bool {
	return strings.TrimSpace(name) != "" && len(name) <= 1024
}

func (s *Server) insertScene(scene store.Scene) error {
	_, err := s.Store.DB.Exec("INSERT INTO scenes(id,owner_id,name,collection_id,room_key,share_mode,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)", scene.ID, scene.OwnerID, scene.Name, scene.CollectionID, scene.RoomKey, scene.ShareMode, scene.CreatedAt, scene.UpdatedAt)
	return err
}

func (s *Server) createScene(w http.ResponseWriter, r *http.Request) error {
	uid, err := requireUser(r)
	if err != nil {
		return err
	}
	var v struct {
		Name         *string
		CollectionID *string `json:"collectionId"`
	}
	if err = decode(w, r, &v, 16384); err != nil {
		return err
	}
	name := "Untitled"
	if v.Name != nil {
		name = *v.Name
	}
	if !validName(name) {
		return bad("Invalid name")
	}
	s.Store.Mutation.Lock()
	defer s.Store.Mutation.Unlock()
	if err = s.collectionOwner(v.CollectionID, uid); err != nil {
		return err
	}
	scene := store.Scene{ID: crypt.ID(), OwnerID: uid, Name: name, CollectionID: v.CollectionID, RoomKey: crypt.Key(), ShareMode: "private", CreatedAt: store.Now(), UpdatedAt: store.Now()}
	if err = s.insertScene(scene); err != nil {
		return err
	}
	JSON(w, 201, access(scene, "owner"))
	return nil
}

func (s *Server) getScene(w http.ResponseWriter, r *http.Request) error {
	scene, p, err := s.sceneAccess(r, false, false)
	if err != nil {
		return err
	}
	JSON(w, 200, access(scene, p))
	return nil
}

func (s *Server) patchScene(w http.ResponseWriter, r *http.Request) error {
	s.Store.Mutation.Lock()
	defer s.Store.Mutation.Unlock()
	scene, _, err := s.sceneAccess(r, true, false)
	if err != nil {
		return err
	}
	var v struct {
		Name         *string
		CollectionID json.RawMessage `json:"collectionId"`
		ShareMode    *string         `json:"shareMode"`
	}
	if err = decode(w, r, &v, 16384); err != nil {
		return err
	}
	if v.Name != nil {
		if !validName(*v.Name) {
			return bad("Invalid name")
		}
		scene.Name = *v.Name
	}
	if v.ShareMode != nil {
		if *v.ShareMode != "private" && *v.ShareMode != "view" && *v.ShareMode != "edit" {
			return bad("Invalid shareMode")
		}
		scene.ShareMode = *v.ShareMode
	}
	if v.CollectionID != nil {
		if err = json.Unmarshal(v.CollectionID, &scene.CollectionID); err != nil {
			return bad("Invalid collectionId")
		}
		if err = s.collectionOwner(scene.CollectionID, scene.OwnerID); err != nil {
			return err
		}
	}
	scene.UpdatedAt = store.Now()
	_, err = s.Store.DB.Exec("UPDATE scenes SET name=?,collection_id=?,share_mode=?,updated_at=? WHERE id=?", scene.Name, scene.CollectionID, scene.ShareMode, scene.UpdatedAt, scene.ID)
	if err != nil {
		return err
	}
	JSON(w, 200, scene)
	return nil
}

func (s *Server) deleteScene(w http.ResponseWriter, r *http.Request) error {
	s.Store.Mutation.Lock()
	defer s.Store.Mutation.Unlock()
	scene, _, err := s.sceneAccess(r, true, false)
	if err != nil {
		return err
	}
	if r.URL.Query().Get("permanent") == "1" {
		err = s.Store.DeleteScene(scene.ID)
		if err == nil {
			s.Hub.Kick(scene.ID)
		}
	} else {
		_, err = s.Store.DB.Exec("UPDATE scenes SET deleted_at=COALESCE(deleted_at,?),updated_at=? WHERE id=?", store.Now(), store.Now(), scene.ID)
	}
	if err != nil {
		return err
	}
	w.WriteHeader(204)
	return nil
}

func (s *Server) restoreScene(w http.ResponseWriter, r *http.Request) error {
	s.Store.Mutation.Lock()
	defer s.Store.Mutation.Unlock()
	scene, _, err := s.sceneAccess(r, true, false)
	if err != nil {
		return err
	}
	scene.DeletedAt = nil
	scene.UpdatedAt = store.Now()
	if _, err = s.Store.DB.Exec("UPDATE scenes SET deleted_at=NULL,updated_at=? WHERE id=?", scene.UpdatedAt, scene.ID); err != nil {
		return err
	}
	JSON(w, 200, scene)
	return nil
}

func (s *Server) duplicateScene(w http.ResponseWriter, r *http.Request) (err error) {
	uid, err := requireUser(r)
	if err != nil {
		return err
	}
	s.Store.Mutation.Lock()
	defer s.Store.Mutation.Unlock()
	old, _, err := s.sceneAccess(r, false, false)
	if err != nil {
		return err
	}
	var v struct{ Name *string }
	if err = decode(w, r, &v, 16384); err != nil {
		return err
	}
	name := old.Name + " (copy)"
	if v.Name != nil {
		name = *v.Name
	}
	if !validName(name) {
		return bad("Invalid name")
	}
	scene := store.Scene{ID: crypt.ID(), OwnerID: uid, Name: name, CollectionID: old.CollectionID, ShareMode: "private", RoomKey: crypt.Key(), CreatedAt: store.Now(), UpdatedAt: store.Now()}
	if uid != old.OwnerID {
		scene.CollectionID = nil
	}
	if err = s.insertScene(scene); err != nil {
		return err
	}
	defer func() {
		if err != nil {
			if cleanup := s.Store.DeleteScene(scene.ID); cleanup != nil {
				s.Log.Error("duplicate cleanup failed", "error", cleanup)
			}
		}
	}()
	room, err := s.Store.Room(old.ID, 0)
	if err == nil {
		var plaintext []byte
		plaintext, err = crypt.Decrypt(old.RoomKey, room.IV, room.Ciphertext)
		if err != nil {
			return err
		}
		room.IV, room.Ciphertext, err = crypt.Encrypt(scene.RoomKey, plaintext)
		if err != nil {
			return err
		}
		if err = s.saveRoom(scene.ID, uid, room, 0); err != nil {
			return err
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	entries, err := os.ReadDir(s.Store.File("rooms", old.ID, ""))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	for _, entry := range entries {
		if !store.ValidFileID(entry.Name()) || !entry.Type().IsRegular() {
			continue
		}
		var data []byte
		data, err = os.ReadFile(s.Store.File("rooms", old.ID, entry.Name()))
		if err != nil {
			return err
		}
		data, err = crypt.Reencrypt(old.RoomKey, scene.RoomKey, data)
		if err != nil {
			return err
		}
		if err = store.AtomicWrite(s.Store.File("rooms", scene.ID, entry.Name()), data); err != nil {
			return err
		}
	}
	thumb, err := os.ReadFile(s.Store.Thumb(old.ID))
	if err == nil {
		if err = store.AtomicWrite(s.Store.Thumb(scene.ID), thumb); err != nil {
			return err
		}
		if _, err = s.Store.DB.Exec("UPDATE scenes SET thumbnail_updated_at=? WHERE id=?", store.Now(), scene.ID); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	scene, err = s.Store.Scene(scene.ID)
	if err != nil {
		return err
	}
	JSON(w, 201, access(scene, "owner"))
	return nil
}
