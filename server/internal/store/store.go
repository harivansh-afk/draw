package store

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrations embed.FS

type Store struct {
	DB  *sql.DB
	Dir string
	// Mutation serializes compound database/filesystem changes and permission checks.
	Mutation sync.Mutex
}

func Now() string { return Before(time.Now()) }
func Before(t time.Time) string {
	// Fixed fractional precision keeps SQLite TEXT ordering chronological.
	return t.UTC().Format("2006-01-02T15:04:05.000000000Z")
}

var validID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
var snapshotID = regexp.MustCompile(`^[a-f0-9]{20}$`)

func ValidID(s string) bool    { return validID.MatchString(s) }
func SnapshotID(s string) bool { return snapshotID.MatchString(s) }
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	path, err := filepath.Abs(filepath.Join(dir, "draw.db"))
	if err != nil {
		return nil, err
	}
	u := url.URL{Scheme: "file", Path: path, RawQuery: "_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)"}
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	s := &Store{DB: db, Dir: dir}
	if err = s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}
func (s *Store) migrate() error {
	for _, q := range []string{"CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY)"} {
		if _, err := s.DB.Exec(q); err != nil {
			return err
		}
	}
	entries, err := migrations.ReadDir("migrations")
	if err != nil {
		return err
	}
	for _, entry := range entries {
		var n int
		if err = s.DB.QueryRow("SELECT count(*) FROM schema_migrations WHERE version=?", entry.Name()).Scan(&n); err != nil {
			return err
		}
		if n != 0 {
			continue
		}
		b, err := migrations.ReadFile("migrations/" + entry.Name())
		if err != nil {
			return err
		}
		tx, err := s.DB.Begin()
		if err != nil {
			return err
		}
		if _, err = tx.Exec(string(b)); err == nil {
			_, err = tx.Exec("INSERT INTO schema_migrations VALUES(?)", entry.Name())
		}
		if err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %s: %w", entry.Name(), err)
		}
		if err = tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}
func (s *Store) Close() error { return s.DB.Close() }
func (s *Store) File(kind, id, file string) string {
	return filepath.Join(s.Dir, "files", kind, id, file)
}
func (s *Store) Thumb(id string) string { return filepath.Join(s.Dir, "thumbs", id+".png") }
func AtomicWrite(path string, data []byte) error {
	return atomicWrite(path, data, false)
}

// AtomicCreate publishes complete bytes without replacing an existing immutable file.
func AtomicCreate(path string, data []byte) error {
	return atomicWrite(path, data, true)
}

func atomicWrite(path string, data []byte, exclusive bool) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".write-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if exclusive {
		err := os.Link(f.Name(), path)
		if os.IsExist(err) {
			return nil
		}
		return err
	}
	return os.Rename(f.Name(), path)
}

type User struct {
	ID        string `json:"id"`
	Email     string `json:"email"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatarUrl"`
}
type Scene struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	CollectionID *string `json:"collectionId"`
	ShareMode    string  `json:"shareMode"`
	CreatedAt    string  `json:"createdAt"`
	UpdatedAt    string  `json:"updatedAt"`
	DeletedAt    *string `json:"deletedAt"`
	HasThumbnail bool    `json:"hasThumbnail"`
	OwnerID      string  `json:"-"`
	RoomKey      string  `json:"-"`
}

const SceneColumns = "id,name,collection_id,share_mode,created_at,updated_at,deleted_at,thumbnail_updated_at IS NOT NULL,owner_id,room_key"

type Scanner interface{ Scan(...any) error }

func ScanScene(row Scanner) (Scene, error) {
	var s Scene
	err := row.Scan(&s.ID, &s.Name, &s.CollectionID, &s.ShareMode, &s.CreatedAt, &s.UpdatedAt, &s.DeletedAt, &s.HasThumbnail, &s.OwnerID, &s.RoomKey)
	return s, err
}
func (s *Store) Scene(id string) (Scene, error) {
	return ScanScene(s.DB.QueryRow("SELECT "+SceneColumns+" FROM scenes WHERE id=?", id))
}
func Permission(user string, scene Scene) string {
	if user != "" && user == scene.OwnerID {
		return "owner"
	}
	if scene.DeletedAt != nil {
		return "none"
	}
	if scene.ShareMode == "edit" || scene.ShareMode == "view" {
		return scene.ShareMode
	}
	return "none"
}
func CanWrite(p string) bool { return p == "owner" || p == "edit" }
func (s *Store) RoomPermission(user, id string) (string, error) {
	scene, err := s.Scene(id)
	if err == nil {
		return Permission(user, scene), nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	if user != "" {
		return "edit", nil
	}
	var exists int
	err = s.DB.QueryRow("SELECT count(*) FROM rooms WHERE id=?", id).Scan(&exists)
	if exists > 0 {
		return "edit", err
	}
	return "view", err
}

// SocketPermission allows encrypted ad-hoc collaboration before the first HTTP save.
func (s *Store) SocketPermission(user, id string) (string, error) {
	scene, err := s.Scene(id)
	if errors.Is(err, sql.ErrNoRows) {
		return "edit", nil
	}
	if err != nil {
		return "", err
	}
	return Permission(user, scene), nil
}

func (s *Store) DeleteScene(id string) error {
	// Disk removal precedes the transaction so a failed removal can be retried.
	if err := os.RemoveAll(s.File("rooms", id, "")); err != nil {
		return err
	}
	if err := os.Remove(s.Thumb(id)); err != nil && !os.IsNotExist(err) {
		return err
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec("DELETE FROM rooms WHERE id=?", id); err != nil {
		return err
	}
	if _, err = tx.Exec("DELETE FROM scenes WHERE id=?", id); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) Backup(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	_, err = s.DB.Exec("VACUUM INTO '" + strings.ReplaceAll(abs, "'", "''") + "'")
	return err
}
func (s *Store) Purge(now time.Time, retention int, kick func(string)) error {
	s.Mutation.Lock()
	defer s.Mutation.Unlock()
	rows, err := s.DB.Query("SELECT id FROM scenes WHERE deleted_at IS NOT NULL AND deleted_at < ?", Before(now.AddDate(0, 0, -retention)))
	if err != nil {
		return err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err = s.DeleteScene(id); err != nil {
			return err
		}
		if kick != nil {
			kick(id)
		}
	}
	if _, err = s.DB.Exec("DELETE FROM sessions WHERE expires_at < ?", Before(now)); err != nil {
		return err
	}
	for _, item := range []struct {
		query, table, kind string
		days               int
	}{
		{"SELECT id FROM rooms WHERE updated_at < ? AND NOT EXISTS (SELECT 1 FROM scenes WHERE scenes.id=rooms.id)", "rooms", "rooms", 90},
		{"SELECT id FROM snapshots WHERE created_at < ?", "snapshots", "shareLinks", 365},
	} {
		rows, err := s.DB.Query(item.query, Before(now.AddDate(0, 0, -item.days)))
		if err != nil {
			return err
		}
		ids = nil
		for rows.Next() {
			var id string
			if err = rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			ids = append(ids, id)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		for _, id := range ids {
			if err = os.RemoveAll(s.File(item.kind, id, "")); err != nil {
				return err
			}
			if _, err = s.DB.Exec("DELETE FROM "+item.table+" WHERE id=?", id); err != nil {
				return err
			}
		}
	}
	return nil
}
func (s *Store) Jobs(ctx context.Context, retention int, kick func(string), report func(error)) {
	run := func() {
		if err := s.Purge(time.Now(), retention, kick); err != nil {
			report(err)
		}
	}
	run()
	tick := time.NewTicker(time.Hour)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			run()
		}
	}
}
