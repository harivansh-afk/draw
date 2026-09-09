package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/mail"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"git.harivan.sh/harivansh-afk/draw/server/internal/config"
	crypt "git.harivan.sh/harivansh-afk/draw/server/internal/crypto"
	"git.harivan.sh/harivansh-afk/draw/server/internal/store"
	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

const CookieName = "draw_session"

var ErrNotAllowed = errors.New("account not allowed")

type identityKey struct{}
type Identity struct {
	User        *store.User
	SessionHash string
}

func Current(r *http.Request) Identity { v, _ := r.Context().Value(identityKey{}).(Identity); return v }

type Auth struct {
	Store    *store.Store
	Config   config.Config
	key      []byte
	oauth    *oauth2.Config
	verifier *oidc.IDTokenVerifier
}

func New(ctx context.Context, s *store.Store, c config.Config) (*Auth, error) {
	key, err := readKey(c.SessionKeyFile)
	if err != nil {
		return nil, err
	}
	a := &Auth{Store: s, Config: c, key: key}
	if c.ClientID == "" || c.ClientSecret == "" {
		if c.DevLogin {
			return a, nil
		}
		return nil, errors.New("OIDC_CLIENT_ID and OIDC_CLIENT_SECRET are required")
	}
	provider, err := oidc.NewProvider(ctx, c.Issuer)
	if err != nil {
		return nil, fmt.Errorf("OIDC discovery: %w", err)
	}
	a.oauth = &oauth2.Config{ClientID: c.ClientID, ClientSecret: c.ClientSecret, RedirectURL: c.RedirectURI, Endpoint: provider.Endpoint(), Scopes: []string{oidc.ScopeOpenID, "email", "profile"}}
	a.verifier = provider.Verifier(&oidc.Config{ClientID: c.ClientID})
	return a, nil
}
func readKey(path string) ([]byte, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err == nil {
		b := make([]byte, 32)
		if _, err = rand.Read(b); err == nil {
			_, err = f.Write(b)
		}
		closeErr := f.Close()
		if err != nil {
			return nil, err
		}
		if closeErr != nil {
			return nil, closeErr
		}
	} else if !os.IsExist(err) {
		return nil, err
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(b) != 32 {
		return nil, errors.New("session key must contain exactly 32 bytes")
	}
	return b, nil
}
func Hash(token string) string { h := sha256.Sum256([]byte(token)); return hex.EncodeToString(h[:]) }
func (a *Auth) cookie(w http.ResponseWriter, name, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{Name: name, Value: value, Path: "/", HttpOnly: true, Secure: strings.HasPrefix(a.Config.BaseURL, "https://"), SameSite: http.SameSiteLaxMode, MaxAge: maxAge, Expires: time.Now().Add(time.Duration(maxAge) * time.Second)})
}
func (a *Auth) Identify(w http.ResponseWriter, r *http.Request) (*http.Request, error) {
	c, err := r.Cookie(CookieName)
	if err != nil {
		return r, nil
	}
	token, err := base64.RawURLEncoding.DecodeString(c.Value)
	if err != nil || len(token) != 32 {
		return r, nil
	}
	hash := Hash(c.Value)
	var u store.User
	err = a.Store.DB.QueryRow("SELECT u.id,u.email,u.name,u.avatar_url FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?", hash, store.Now()).Scan(&u.ID, &u.Email, &u.Name, &u.AvatarURL)
	if errors.Is(err, sql.ErrNoRows) {
		return r, nil
	}
	if err != nil {
		return r, err
	}
	_, err = a.Store.DB.Exec("UPDATE sessions SET expires_at=?,last_seen_at=? WHERE token_hash=?", store.Before(time.Now().Add(30*24*time.Hour)), store.Now(), hash)
	if err != nil {
		return r, err
	}
	a.cookie(w, CookieName, c.Value, 30*86400)
	return r.WithContext(context.WithValue(r.Context(), identityKey{}, Identity{&u, hash})), nil
}
func (a *Auth) Login(issuer, subject, email, name, avatar string) (store.User, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	parsed, err := mail.ParseAddress(email)
	if err != nil || parsed.Address != email {
		return store.User{}, ErrNotAllowed
	}
	a.Store.Mutation.Lock()
	defer a.Store.Mutation.Unlock()
	tx, err := a.Store.DB.Begin()
	if err != nil {
		return store.User{}, err
	}
	defer tx.Rollback()
	allowed := a.Config.OpenSignup
	if !allowed {
		if strings.TrimSpace(a.Config.AllowedEmails) != "" {
			for _, v := range strings.Split(a.Config.AllowedEmails, ",") {
				if strings.EqualFold(strings.TrimSpace(v), email) {
					allowed = true
				}
			}
		} else {
			if _, err = tx.Exec("INSERT OR IGNORE INTO settings(key,value) VALUES('first_user_email',?)", email); err != nil {
				return store.User{}, err
			}
			var first string
			if err = tx.QueryRow("SELECT value FROM settings WHERE key='first_user_email'").Scan(&first); err != nil {
				return store.User{}, err
			}
			allowed = first == email
		}
	}
	if !allowed {
		return store.User{}, ErrNotAllowed
	}
	var u store.User
	err = tx.QueryRow("SELECT id,email,name,avatar_url FROM users WHERE issuer=? AND subject=?", issuer, subject).Scan(&u.ID, &u.Email, &u.Name, &u.AvatarURL)
	if errors.Is(err, sql.ErrNoRows) {
		// Only importer placeholders can be claimed by a verified login with the same email.
		err = tx.QueryRow("SELECT id FROM users WHERE issuer='draw:import' AND email=?", email).Scan(&u.ID)
		if errors.Is(err, sql.ErrNoRows) {
			u.ID = crypt.ID()
			_, err = tx.Exec("INSERT INTO users VALUES(?,?,?,?,?,?,?,?)", u.ID, issuer, subject, email, name, avatar, store.Now(), store.Now())
		} else if err == nil {
			_, err = tx.Exec("UPDATE users SET issuer=?,subject=?,name=?,avatar_url=?,last_login_at=? WHERE id=?", issuer, subject, name, avatar, store.Now(), u.ID)
		}
	} else if err == nil {
		_, err = tx.Exec("UPDATE users SET email=?,name=?,avatar_url=?,last_login_at=? WHERE id=?", email, name, avatar, store.Now(), u.ID)
	}
	if err != nil {
		return u, fmt.Errorf("save user: %w", err)
	}
	u.Email = email
	u.Name = name
	u.AvatarURL = avatar
	return u, tx.Commit()
}
func (a *Auth) Session(w http.ResponseWriter, u store.User) error {
	token := crypt.Token()
	now := store.Now()
	_, err := a.Store.DB.Exec("INSERT INTO sessions VALUES(?,?,?,?,?)", Hash(token), u.ID, now, store.Before(time.Now().Add(30*24*time.Hour)), now)
	if err == nil {
		a.cookie(w, CookieName, token, 30*86400)
	}
	return err
}
func (a *Auth) Logout(w http.ResponseWriter, r *http.Request) error {
	if c, err := r.Cookie(CookieName); err == nil {
		if _, err = a.Store.DB.Exec("DELETE FROM sessions WHERE token_hash=?", Hash(c.Value)); err != nil {
			return err
		}
	}
	a.cookie(w, CookieName, "", -1)
	return nil
}
func CSRF(r *http.Request, origin string) bool {
	switch r.Method {
	case "POST", "PUT", "PATCH", "DELETE":
		site := r.Header.Get("Sec-Fetch-Site")
		return site == "same-origin" || site == "none" || r.Header.Get("Origin") == origin
	}
	return true
}
func SafeNext(next string) string {
	u, err := url.Parse(next)
	if err != nil || !strings.HasPrefix(next, "/") || strings.HasPrefix(next, "//") || strings.ContainsAny(next, "\\\r\n") || u.IsAbs() || u.Host != "" {
		return "/"
	}
	return next
}

type flow struct {
	State, Nonce, Next string
	Expires            int64
}

func (a *Auth) sign(b []byte) string {
	m := hmac.New(sha256.New, a.key)
	m.Write(b)
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}
func (a *Auth) Start(w http.ResponseWriter, r *http.Request) {
	if a.oauth == nil {
		http.Redirect(w, r, "/login?error=oidc", 302)
		return
	}
	f := flow{crypt.Token(), crypt.Token(), SafeNext(r.URL.Query().Get("next")), time.Now().Add(10 * time.Minute).Unix()}
	b, _ := json.Marshal(f)
	encoded := base64.RawURLEncoding.EncodeToString(b)
	a.cookie(w, "draw_oidc", encoded+"."+a.sign([]byte(encoded)), 600)
	http.Redirect(w, r, a.oauth.AuthCodeURL(f.State, oidc.Nonce(f.Nonce)), 302)
}
func (a *Auth) Callback(w http.ResponseWriter, r *http.Request) {
	fail := func(reason string) { http.Redirect(w, r, "/login?error="+reason, 302) }
	c, err := r.Cookie("draw_oidc")
	a.cookie(w, "draw_oidc", "", -1)
	if err != nil || a.oauth == nil {
		fail("oidc")
		return
	}
	parts := strings.Split(c.Value, ".")
	if len(parts) != 2 || !hmac.Equal([]byte(parts[1]), []byte(a.sign([]byte(parts[0])))) {
		fail("oidc")
		return
	}
	b, err := base64.RawURLEncoding.DecodeString(parts[0])
	var f flow
	if err != nil || json.Unmarshal(b, &f) != nil || f.Expires < time.Now().Unix() || f.State == "" || !hmac.Equal([]byte(f.State), []byte(r.URL.Query().Get("state"))) {
		fail("oidc")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	tok, err := a.oauth.Exchange(ctx, r.URL.Query().Get("code"))
	if err != nil {
		fail("oidc")
		return
	}
	raw, ok := tok.Extra("id_token").(string)
	if !ok {
		fail("oidc")
		return
	}
	id, err := a.verifier.Verify(ctx, raw)
	if err != nil || id.Nonce != f.Nonce {
		fail("oidc")
		return
	}
	var claims struct {
		Email         string
		EmailVerified bool `json:"email_verified"`
		Name, Picture string
	}
	if id.Claims(&claims) != nil || !claims.EmailVerified {
		fail("not_allowed")
		return
	}
	u, err := a.Login(id.Issuer, id.Subject, claims.Email, claims.Name, claims.Picture)
	if errors.Is(err, ErrNotAllowed) {
		fail("not_allowed")
		return
	}
	if err != nil {
		fail("oidc")
		return
	}
	if err = a.Session(w, u); err != nil {
		fail("oidc")
		return
	}
	http.Redirect(w, r, SafeNext(f.Next), 302)
}
