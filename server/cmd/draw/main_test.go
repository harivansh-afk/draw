package main

import (
	"io"
	"log/slog"
	"strings"
	"testing"
)

func TestEmptyCommand(t *testing.T) {
	err := run([]string{""}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err == nil || !strings.Contains(err.Error(), "unknown command") {
		t.Fatalf("expected command error, got %v", err)
	}
}
