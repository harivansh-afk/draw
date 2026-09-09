package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"git.harivan.sh/harivansh-afk/draw/server/internal/api"
	"git.harivan.sh/harivansh-afk/draw/server/internal/auth"
	"git.harivan.sh/harivansh-afk/draw/server/internal/config"
	"git.harivan.sh/harivansh-afk/draw/server/internal/importer"
	"git.harivan.sh/harivansh-afk/draw/server/internal/store"
	"git.harivan.sh/harivansh-afk/draw/server/internal/ws"
	"git.harivan.sh/harivansh-afk/draw/server/web"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	slog.SetDefault(log)
	if err := run(os.Args[1:], log); err != nil {
		log.Error("draw failed", "error", err)
		os.Exit(1)
	}
}
func run(args []string, log *slog.Logger) error {
	command := "serve"
	if len(args) > 0 && (args[0] == "" || args[0][0] != '-') {
		command = args[0]
		args = args[1:]
	}
	switch command {
	case "serve":
		c, err := config.Load(args)
		if err != nil {
			return err
		}
		return serve(c, log)
	case "backup":
		if len(args) != 1 {
			return errors.New("usage: draw backup OUT.sqlite")
		}
		c, err := config.Load(nil)
		if err != nil {
			return err
		}
		s, err := store.Open(c.DataDir)
		if err != nil {
			return err
		}
		defer s.Close()
		return s.Backup(args[0])
	case "import-excalidash":
		f := flag.NewFlagSet(command, flag.ContinueOnError)
		var o importer.Options
		var dataDir string
		f.StringVar(&o.DB, "db", "", "ExcaliDash SQLite database")
		f.StringVar(&o.Uploads, "uploads", "", "ExcaliDash uploads directory")
		f.StringVar(&o.Owner, "owner", "", "destination owner email")
		f.BoolVar(&o.CreateOwner, "create-owner", false, "create owner for later verified login")
		f.BoolVar(&o.DryRun, "dry-run", false, "validate and print plan")
		f.StringVar(&dataDir, "data-dir", "", "destination DRAW_DATA_DIR override")
		if err := f.Parse(args); err != nil {
			return err
		}
		if o.DB == "" || o.Owner == "" || f.NArg() != 0 {
			return errors.New("usage: draw import-excalidash --db dev.db --uploads DIR --owner EMAIL [--create-owner] [--dry-run]")
		}
		c, err := config.Load(nil)
		if err != nil {
			return err
		}
		if dataDir != "" {
			c.DataDir = dataDir
		}
		s, err := store.Open(c.DataDir)
		if err != nil {
			return err
		}
		defer s.Close()
		return importer.Run(s, o, os.Stdout)
	default:
		return fmt.Errorf("unknown command %q", command)
	}
}
func serve(c config.Config, log *slog.Logger) error {
	s, err := store.Open(c.DataDir)
	if err != nil {
		return err
	}
	defer s.Close()
	initCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	a, err := auth.New(initCtx, s, c)
	cancel()
	if err != nil {
		return err
	}
	hub := ws.New(s, c)
	app := &api.Server{Store: s, Auth: a, Config: c, Hub: hub, Log: log}
	files, err := fs.Sub(web.Files, "dist")
	if err != nil {
		return err
	}
	server := &http.Server{Addr: c.Listen, Handler: app.Handler(files), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 1 << 20}
	listener, err := net.Listen("tcp", c.Listen)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	jobsCtx, stopJobs := context.WithCancel(context.Background())
	jobsDone := make(chan struct{})
	go func() {
		defer close(jobsDone)
		s.Jobs(jobsCtx, c.TrashRetentionDays, hub.Kick, func(err error) { log.Error("cleanup failed", "error", err) })
	}()
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	log.Info("listening", "address", listener.Addr().String(), "dev_login", c.DevLogin)
	select {
	case <-ctx.Done():
	case err = <-done:
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	stopJobs()
	// Shutdown does not drain hijacked WebSockets; close those explicitly with 1001.
	closed := make(chan struct{})
	go func() { hub.Close(); close(closed) }()
	shutdownErr := server.Shutdown(shutdownCtx)
	if shutdownErr != nil {
		_ = server.Close()
	}
	<-closed
	<-jobsDone
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return shutdownErr
}
