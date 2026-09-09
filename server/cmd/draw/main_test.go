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
