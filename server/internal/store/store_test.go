package store

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestMigrationsBackupPurge(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	old := Before(now.AddDate(-2, 0, 0))
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := s.DB.Exec(q, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec("INSERT INTO users VALUES('u','issuer','sub','owner@example.com','Owner','',?,?)", old, old)
	exec("INSERT INTO sessions VALUES('token','u',?,?,?)", old, old, old)
	exec("INSERT INTO scenes VALUES('scene','u','Old',NULL,'key','private',?,?,?,?)", old, old, old, old)
	exec("INSERT INTO rooms VALUES('scene',1,1,?,?,NULL,?)", []byte("iv"), []byte("ct"), old)
	exec("INSERT INTO rooms VALUES('adhoc',1,1,?,?,NULL,?)", []byte("iv"), []byte("ct"), old)
	exec("INSERT INTO room_versions VALUES('scene',1,1,?,?,?)", []byte("iv"), []byte("ct"), old)
	exec("INSERT INTO snapshots VALUES('snap',?,?,'ip')", []byte("data"), old)
	for _, path := range []string{s.File("rooms", "scene", "img"), s.File("rooms", "adhoc", "img"), s.File("shareLinks", "snap", "img"), s.Thumb("scene")} {
		if err = AtomicWrite(path, []byte("data")); err != nil {
			t.Fatal(err)
		}
	}
	backup := filepath.Join(t.TempDir(), "backup.sqlite")
	if err = s.Backup(backup); err != nil {
		t.Fatal(err)
	}
	copied, err := sql.Open("sqlite", backup)
	if err != nil {
		t.Fatal(err)
	}
	var count int
	if err = copied.QueryRow("SELECT count(*) FROM scenes").Scan(&count); err != nil || count != 1 {
		t.Fatal(count, err)
	}
	copied.Close()
	if err = s.Purge(now, 30); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"scenes", "sessions", "rooms", "room_versions", "snapshots"} {
		if err = s.DB.QueryRow("SELECT count(*) FROM " + table).Scan(&count); err != nil || count != 0 {
			t.Fatal(table, count, err)
		}
	}
	if _, err = os.Stat(s.Thumb("scene")); !os.IsNotExist(err) {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.DB.QueryRow("SELECT count(*) FROM schema_migrations").Scan(&count); err != nil || count != 1 {
		t.Fatal(count, err)
	}
	var mode string
	s.DB.QueryRow("PRAGMA journal_mode").Scan(&mode)
	if mode != "wal" {
		t.Fatal(mode)
	}
	var fk int
	s.DB.QueryRow("PRAGMA foreign_keys").Scan(&fk)
	if fk != 1 {
		t.Fatal("foreign keys disabled")
	}
}
func TestPermissionMatrix(t *testing.T) {
	for _, share := range []string{"private", "view", "edit"} {
		for _, user := range []string{"owner", "other", ""} {
			for _, trash := range []bool{false, true} {
				scene := Scene{OwnerID: "owner", ShareMode: share}
				if trash {
					v := Now()
					scene.DeletedAt = &v
				}
				want := "none"
				if user == "owner" {
					want = "owner"
				} else if !trash && share != "private" {
					want = share
				}
				if got := Permission(user, scene); got != want {
					t.Fatalf("share=%s user=%q trash=%t: %s != %s", share, user, trash, got, want)
				}
			}
		}
	}
}
