package main

import (
	"git.harivan.sh/harivansh-afk/draw/server/internal/store"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEmptyCommand(t *testing.T) {
	err := run([]string{""}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err == nil || !strings.Contains(err.Error(), "unknown command") {
		t.Fatalf("expected command error, got %v", err)
	}
}

func TestBackupFilesFlag(t *testing.T) {
	for _, flagsFirst := range []bool{false, true} {
		t.Run(map[bool]string{false: "output-first", true: "flags-first"}[flagsFirst], func(t *testing.T) {
			data := t.TempDir()
			t.Setenv("DRAW_DATA_DIR", data)
			s, err := store.Open(data)
			if err != nil {
				t.Fatal(err)
			}
			if err := store.AtomicWrite(s.File("rooms", "room", "image"), []byte("original")); err != nil {
				t.Fatal(err)
			}
			s.Close()
			dest := t.TempDir()
			db, files := filepath.Join(dest, "backup.sqlite"), filepath.Join(dest, "media")
			args := []string{"backup", db, "--files", files}
			if flagsFirst {
				args = []string{"backup", "--files", files, db}
			}
			if err := run(args, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(db); err != nil {
				t.Fatal(err)
			}
			b, err := os.ReadFile(filepath.Join(files, "files", "rooms", "room", "image"))
			if err != nil || string(b) != "original" {
				t.Fatal(string(b), err)
			}
		})
	}
}

func TestImportDirFlags(t *testing.T) {
	for _, flagsFirst := range []bool{false, true} {
		t.Run(map[bool]string{false: "directory-first", true: "flags-first"}[flagsFirst], func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "scene.excalidraw"), []byte(`{"elements":[]}`), 0600); err != nil {
				t.Fatal(err)
			}
			envDir := filepath.Join(t.TempDir(), "unused")
			t.Setenv("DRAW_DATA_DIR", envDir)
			data := t.TempDir()
			flags := []string{"--owner", "owner@example.com", "--create-owner", "--data-dir", data}
			log := slog.New(slog.NewTextHandler(io.Discard, nil))
			for _, dry := range []bool{true, false} {
				args := append([]string{}, flags...)
				if dry {
					args = append(args, "--dry-run")
				}
				if flagsFirst {
					args = append(args, dir)
				} else {
					args = append([]string{dir}, args...)
				}
				if err := run(append([]string{"import-dir"}, args...), log); err != nil {
					t.Fatal(err)
				}
				s, err := store.Open(data)
				if err != nil {
					t.Fatal(err)
				}
				var scenes int
				err = s.DB.QueryRow("SELECT count(*) FROM scenes").Scan(&scenes)
				s.Close()
				want := 1
				if dry {
					want = 0
				}
				if err != nil || scenes != want {
					t.Fatal(scenes, err)
				}
			}
			if _, err := os.Stat(envDir); !os.IsNotExist(err) {
				t.Fatal("data-dir did not override environment", err)
			}
		})
	}
}
