package api

import (
	crypt "git.harivan.sh/harivansh-afk/draw/server/internal/crypto"
	"git.harivan.sh/harivansh-afk/draw/server/internal/store"
	"net/http"
)

type Collection struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	CreatedAt  string `json:"createdAt"`
	SceneCount int    `json:"sceneCount"`
}

const collectionQuery = "SELECT c.id,c.name,c.created_at,(SELECT count(*) FROM scenes s WHERE s.collection_id=c.id AND s.deleted_at IS NULL) FROM collections c"

func (s *Server) listCollections(w http.ResponseWriter, r *http.Request) error {
	uid, err := requireUser(r)
	if err != nil {
		return err
	}
	rows, err := s.Store.DB.Query(collectionQuery+" WHERE c.owner_id=? ORDER BY c.name COLLATE NOCASE,c.id", uid)
	if err != nil {
		return err
	}
	defer rows.Close()
	collections := []Collection{}
	for rows.Next() {
		var c Collection
		if err = rows.Scan(&c.ID, &c.Name, &c.CreatedAt, &c.SceneCount); err != nil {
			return err
		}
		collections = append(collections, c)
	}
	if err = rows.Err(); err != nil {
		return err
	}
	JSON(w, 200, map[string]any{"collections": collections})
	return nil
}
func (s *Server) collection(r *http.Request) (Collection, error) {
	uid, err := requireUser(r)
	if err != nil {
		return Collection{}, err
	}
	var c Collection
	err = s.Store.DB.QueryRow(collectionQuery+" WHERE c.id=? AND c.owner_id=?", r.PathValue("id"), uid).Scan(&c.ID, &c.Name, &c.CreatedAt, &c.SceneCount)
	return c, err
}
func collectionName(w http.ResponseWriter, r *http.Request) (string, error) {
	var v struct{ Name string }
	if err := decode(w, r, &v, 16384); err != nil {
		return "", err
	}
	if !validName(v.Name) {
		return "", bad("Invalid name")
	}
	return v.Name, nil
}
func (s *Server) createCollection(w http.ResponseWriter, r *http.Request) error {
	uid, err := requireUser(r)
	if err != nil {
		return err
	}
	name, err := collectionName(w, r)
	if err != nil {
		return err
	}
	c := Collection{ID: crypt.ID(), Name: name, CreatedAt: store.Now()}
	_, err = s.Store.DB.Exec("INSERT INTO collections VALUES(?,?,?,?,?)", c.ID, uid, c.Name, c.CreatedAt, c.CreatedAt)
	if err != nil {
		return err
	}
	JSON(w, 201, c)
	return nil
}
func (s *Server) patchCollection(w http.ResponseWriter, r *http.Request) error {
	s.Store.Mutation.Lock()
	defer s.Store.Mutation.Unlock()
	c, err := s.collection(r)
	if err != nil {
		return err
	}
	c.Name, err = collectionName(w, r)
	if err != nil {
		return err
	}
	if _, err = s.Store.DB.Exec("UPDATE collections SET name=?,updated_at=? WHERE id=?", c.Name, store.Now(), c.ID); err != nil {
		return err
	}
	JSON(w, 200, c)
	return nil
}
func (s *Server) deleteCollection(w http.ResponseWriter, r *http.Request) error {
	s.Store.Mutation.Lock()
	defer s.Store.Mutation.Unlock()
	c, err := s.collection(r)
	if err != nil {
		return err
	}
	if _, err = s.Store.DB.Exec("DELETE FROM collections WHERE id=?", c.ID); err != nil {
		return err
	}
	w.WriteHeader(204)
	return nil
}
