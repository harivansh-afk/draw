package store

import (
	"database/sql"
	"errors"
	"time"
)

// Activity is one line in an owner's timeline: what happened to which scene,
// by whom. Rows outlive their scene so the feed can still say what was deleted.
type Activity struct {
	ID        int64   `json:"id"`
	Kind      string  `json:"kind"`
	SceneID   *string `json:"sceneId"`
	SceneName string  `json:"sceneName"`
	Detail    string  `json:"detail"`
	ActorID   *string `json:"actorId"`
	ActorName string  `json:"actorName"`
	At        string  `json:"at"`
	// SceneState is "live", "trash" or "gone" depending on whether the scene
	// row still exists and whether it is in the trash.
	SceneState string `json:"sceneState"`
}

const (
	ActivityCreated    = "created"
	ActivityEdited     = "edited"
	ActivityRenamed    = "renamed"
	ActivityMoved      = "moved"
	ActivityShared     = "shared"
	ActivityDuplicated = "duplicated"
	ActivityTrashed    = "trashed"
	ActivityRestored   = "restored"
	ActivityDeleted    = "deleted"
)

// CoalesceWindow bounds how far apart two saves may be and still count as one
// editing session in the timeline.
const CoalesceWindow = 30 * time.Minute

// ActivityRetentionDays bounds the timeline; older rows are purged hourly.
const ActivityRetentionDays = 90

type Execer interface {
	Exec(string, ...any) (sql.Result, error)
	QueryRow(string, ...any) *sql.Row
}

// Log appends an activity row for owner. Edits are folded into the previous
// entry for the same scene when it is recent and by the same actor, so a
// drawing session reads as one line instead of one per autosave; the entry
// keeps its original kind, so a scene created and then drawn stays "created".
func (s *Store) LogActivity(db Execer, owner, actor, kind string, sceneID *string, sceneName, detail string, now time.Time) error {
	at := Before(now)
	var actorArg any
	if actor != "" {
		actorArg = actor
	}
	if kind == ActivityEdited && sceneID != nil {
		var id int64
		var prevKind, prevAt string
		var prevActor sql.NullString
		err := db.QueryRow("SELECT id,kind,actor_id,at FROM activity WHERE owner_id=? AND scene_id=? ORDER BY at DESC, id DESC LIMIT 1", owner, *sceneID).Scan(&id, &prevKind, &prevActor, &prevAt)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if err == nil && prevActor.String == actor && (prevKind == ActivityEdited || prevKind == ActivityCreated || prevKind == ActivityDuplicated) {
			if t, perr := time.Parse(time.RFC3339Nano, prevAt); perr == nil && now.Sub(t) < CoalesceWindow {
				_, err = db.Exec("UPDATE activity SET at=?, scene_name=? WHERE id=?", at, sceneName, id)
				return err
			}
		}
	}
	_, err := db.Exec("INSERT INTO activity(owner_id,actor_id,kind,scene_id,scene_name,detail,at) VALUES(?,?,?,?,?,?,?)", owner, actorArg, kind, sceneID, sceneName, detail, at)
	return err
}

func (s *Store) ListActivity(owner string, limit int) ([]Activity, error) {
	rows, err := s.DB.Query(`SELECT a.id,a.kind,a.scene_id,a.scene_name,a.detail,a.actor_id,COALESCE(u.name,''),a.at,
		CASE WHEN sc.id IS NULL THEN 'gone' WHEN sc.deleted_at IS NULL THEN 'live' ELSE 'trash' END
		FROM activity a LEFT JOIN users u ON u.id=a.actor_id LEFT JOIN scenes sc ON sc.id=a.scene_id
		WHERE a.owner_id=? ORDER BY a.at DESC, a.id DESC LIMIT ?`, owner, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []Activity{}
	for rows.Next() {
		var a Activity
		if err = rows.Scan(&a.ID, &a.Kind, &a.SceneID, &a.SceneName, &a.Detail, &a.ActorID, &a.ActorName, &a.At, &a.SceneState); err != nil {
			return nil, err
		}
		list = append(list, a)
	}
	return list, rows.Err()
}
