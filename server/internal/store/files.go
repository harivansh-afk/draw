package store

import (
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// The caller holds Mutation so an upload cannot race the orphan check and removal.
func (s *Store) purgeOrphanRoomFiles(before time.Time) error {
	entries, err := os.ReadDir(s.File("rooms", "", ""))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() || !ValidID(entry.Name()) {
			continue
		}
		var exists bool
		if err := s.DB.QueryRow("SELECT EXISTS(SELECT 1 FROM scenes WHERE id=?) OR EXISTS(SELECT 1 FROM rooms WHERE id=?)", entry.Name(), entry.Name()).Scan(&exists); err != nil {
			return err
		}
		if exists {
			continue
		}
		path := s.File("rooms", entry.Name(), "")
		var newest time.Time
		err := filepath.WalkDir(path, func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			if info.ModTime().After(newest) {
				newest = info.ModTime()
			}
			return nil
		})
		if err != nil {
			return err
		}
		if newest.Before(before) {
			if err := os.RemoveAll(path); err != nil {
				return err
			}
		}
	}
	return nil
}

// BackupFiles links immutable published inodes, falling back to copies across filesystems.
func (s *Store) BackupFiles(dir string) (err error) {
	destination, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	source, err := filepath.Abs(s.Dir)
	if err != nil {
		return err
	}
	if rel, err := filepath.Rel(source, destination); err != nil || rel == "." || filepath.IsLocal(rel) {
		return fmt.Errorf("file backup must be outside the data directory")
	}
	if err = os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
		return err
	}
	if err = os.Mkdir(destination, 0700); err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = os.RemoveAll(destination)
		}
	}()
	for _, tree := range []string{"files", "thumbs"} {
		root := filepath.Join(source, tree)
		if _, err := os.Stat(root); os.IsNotExist(err) {
			continue
		} else if err != nil {
			return err
		}
		err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			rel, err := filepath.Rel(source, path)
			if err != nil {
				return err
			}
			target := filepath.Join(destination, rel)
			if entry.IsDir() {
				return os.Mkdir(target, 0700)
			}
			if !entry.Type().IsRegular() {
				return fmt.Errorf("unsupported backup file %s", path)
			}
			if err := os.Link(path, target); err == nil {
				return nil
			}
			return copyBackupFile(path, target)
		})
		if err != nil {
			return err
		}
	}
	return nil
}

func copyBackupFile(source, destination string) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	out, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	if err == nil {
		err = out.Sync()
	}
	closeErr := out.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Chtimes(destination, info.ModTime(), info.ModTime())
}
