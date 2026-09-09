package config

import (
	"flag"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Config struct {
	Listen, DataDir, BaseURL, Issuer, ClientID, ClientSecret, RedirectURI, AllowedEmails, SessionKeyFile string
	OpenSignup, DevLogin, TrustProxy                                                                     bool
	MaxRoomBytes, MaxFileBytes                                                                           int64
	TrashRetentionDays, RoomHistory                                                                      int
}

func Load(args []string) (Config, error) {
	var c Config
	fs := flag.NewFlagSet("draw", flag.ContinueOnError)
	str := func(p *string, flagName, env, def string) {
		v, ok := os.LookupEnv(env)
		if !ok {
			v = def
		}
		fs.StringVar(p, flagName, v, env)
	}
	var envErr error
	boolean := func(p *bool, name, env string) {
		v := os.Getenv(env)
		b := false
		if v != "" {
			var e error
			b, e = strconv.ParseBool(v)
			if e != nil {
				envErr = fmt.Errorf("%s: %w", env, e)
			}
		}
		fs.BoolVar(p, name, b, env)
	}
	integer := func(p *int64, name, env string, def int64) {
		v := def
		if s := os.Getenv(env); s != "" {
			var e error
			v, e = strconv.ParseInt(s, 10, 64)
			if e != nil {
				envErr = fmt.Errorf("%s: %w", env, e)
			}
		}
		fs.Int64Var(p, name, v, env)
	}
	str(&c.Listen, "listen", "DRAW_LISTEN", "127.0.0.1:34729")
	str(&c.DataDir, "data-dir", "DRAW_DATA_DIR", "./data")
	str(&c.BaseURL, "base-url", "DRAW_BASE_URL", "http://localhost:34729")
	str(&c.Issuer, "oidc-issuer-url", "OIDC_ISSUER_URL", "https://accounts.google.com")
	str(&c.ClientID, "oidc-client-id", "OIDC_CLIENT_ID", "")
	str(&c.ClientSecret, "oidc-client-secret", "OIDC_CLIENT_SECRET", "")
	str(&c.RedirectURI, "oidc-redirect-uri", "OIDC_REDIRECT_URI", "")
	str(&c.AllowedEmails, "allowed-emails", "DRAW_ALLOWED_EMAILS", "")
	str(&c.SessionKeyFile, "session-key-file", "DRAW_SESSION_KEY_FILE", "")
	boolean(&c.OpenSignup, "open-signup", "DRAW_OPEN_SIGNUP")
	boolean(&c.DevLogin, "dev-login", "DRAW_DEV_LOGIN")
	boolean(&c.TrustProxy, "trust-proxy", "DRAW_TRUST_PROXY")
	integer(&c.MaxRoomBytes, "max-room-bytes", "DRAW_MAX_ROOM_BYTES", 8388608)
	integer(&c.MaxFileBytes, "max-file-bytes", "DRAW_MAX_FILE_BYTES", 6291456)
	var retention, history int64
	integer(&retention, "trash-retention-days", "DRAW_TRASH_RETENTION_DAYS", 30)
	integer(&history, "room-history", "DRAW_ROOM_HISTORY", 20)
	if err := fs.Parse(args); err != nil {
		return c, err
	}
	if envErr != nil {
		return c, envErr
	}
	if fs.NArg() != 0 {
		return c, fmt.Errorf("unexpected arguments: %v", fs.Args())
	}
	c.TrashRetentionDays = int(retention)
	c.RoomHistory = int(history)
	c.BaseURL = strings.TrimRight(c.BaseURL, "/")
	u, err := url.Parse(c.BaseURL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return c, fmt.Errorf("base-url must be an http(s) origin")
	}
	if c.MaxRoomBytes < 1 || c.MaxFileBytes < 1 || retention < 1 || history < 1 {
		return c, fmt.Errorf("limits and retention must be positive")
	}
	if c.RedirectURI == "" {
		c.RedirectURI = c.BaseURL + "/api/auth/oidc/callback"
	}
	if c.SessionKeyFile == "" {
		c.SessionKeyFile = filepath.Join(c.DataDir, "session.key")
	}
	return c, nil
}
