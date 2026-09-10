package api

import (
	"net/http"
	"strconv"
	"time"

	"git.harivan.sh/harivansh-afk/draw/server/internal/store"
)

func (s *Server) listActivity(w http.ResponseWriter, r *http.Request) error {
	uid, err := requireUser(r)
	if err != nil {
		return err
	}
	limit := 40
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 200 {
			return bad("limit must be between 1 and 200")
		}
		limit = n
	}
	list, err := s.Store.ListActivity(uid, limit)
	if err != nil {
		return err
	}
	JSON(w, 200, map[string]any{"activity": list})
	return nil
}

// record adds a timeline entry for the scene's owner after a mutation has
// already succeeded. The timeline is a convenience, so a failure here is
// logged rather than turned into an error the client would retry.
func (s *Server) record(r *http.Request, kind string, scene store.Scene, detail string) {
	id := scene.ID
	if err := s.Store.LogActivity(s.Store.DB, scene.OwnerID, userID(r), kind, &id, scene.Name, detail, time.Now()); err != nil {
		s.Log.Error("activity", "kind", kind, "scene", scene.ID, "error", err)
	}
}
