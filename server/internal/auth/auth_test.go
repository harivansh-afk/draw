package auth

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"git.harivan.sh/harivansh-afk/draw/server/internal/config"
	"git.harivan.sh/harivansh-afk/draw/server/internal/store"
)

func TestOIDCFlow(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	var issuer, nonce string
	verified := true
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			_ = json.NewEncoder(w).Encode(map[string]any{"issuer": issuer, "authorization_endpoint": issuer + "/authorize", "token_endpoint": issuer + "/token", "jwks_uri": issuer + "/keys", "response_types_supported": []string{"code"}, "subject_types_supported": []string{"public"}, "id_token_signing_alg_values_supported": []string{"RS256"}})
		case "/keys":
			_ = json.NewEncoder(w).Encode(map[string]any{"keys": []any{map[string]any{"kty": "RSA", "kid": "test", "use": "sig", "alg": "RS256", "n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()), "e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes())}}})
		case "/token":
			header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","kid":"test","typ":"JWT"}`))
			claims, _ := json.Marshal(map[string]any{"iss": issuer, "sub": "subject", "aud": "client", "exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(), "nonce": nonce, "email": "owner@example.com", "email_verified": verified, "name": "Owner", "picture": "https://example.com/avatar.png"})
			unsigned := header + "." + base64.RawURLEncoding.EncodeToString(claims)
			hash := sha256.Sum256([]byte(unsigned))
			sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, hash[:])
			if err != nil {
				t.Error(err)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "test", "token_type": "Bearer", "id_token": unsigned + "." + base64.RawURLEncoding.EncodeToString(sig)})
		default:
			http.NotFound(w, r)
		}
	}))
	defer provider.Close()
	issuer = provider.URL
	c, err := config.Load(nil)
	if err != nil {
		t.Fatal(err)
	}
	c.DataDir = t.TempDir()
	c.SessionKeyFile = c.DataDir + "/session.key"
	c.Issuer = issuer
	c.ClientID = "client"
	c.ClientSecret = "secret"
	c.BaseURL = "https://draw.example"
	c.RedirectURI = c.BaseURL + "/api/auth/oidc/callback"
	s, err := store.Open(c.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	a, err := New(context.Background(), s, c)
	if err != nil {
		t.Fatal(err)
	}
	start := func() (*http.Cookie, string) {
		rr := httptest.NewRecorder()
		a.Start(rr, httptest.NewRequest("GET", "/api/auth/oidc/start?next=/s/123", nil))
		if rr.Code != 302 {
			t.Fatal(rr.Code)
		}
		u, err := url.Parse(rr.Header().Get("Location"))
		if err != nil {
			t.Fatal(err)
		}
		if u.Query().Get("scope") != "openid email profile" {
			t.Fatal(u.String())
		}
		nonce = u.Query().Get("nonce")
		return rr.Result().Cookies()[0], u.Query().Get("state")
	}
	callback := func(cookie *http.Cookie, state string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/api/auth/oidc/callback?code=code&state="+url.QueryEscape(state), nil)
		req.AddCookie(cookie)
		rr := httptest.NewRecorder()
		a.Callback(rr, req)
		return rr
	}
	cookie, state := start()
	rr := callback(cookie, state)
	if rr.Header().Get("Location") != "/s/123" {
		t.Fatal(rr.Header())
	}
	found := false
	for _, c := range rr.Result().Cookies() {
		if c.Name == CookieName {
			found = true
			if !c.Secure || !c.HttpOnly {
				t.Fatal(c)
			}
		}
	}
	if !found {
		t.Fatal("no session")
	}
	var user store.User
	err = s.DB.QueryRow("SELECT id,email,name,avatar_url FROM users").Scan(&user.ID, &user.Email, &user.Name, &user.AvatarURL)
	if err != nil || user.Email != "owner@example.com" {
		t.Fatal(user, err)
	}
	cookie, state = start()
	if rr = callback(cookie, state+"wrong"); rr.Header().Get("Location") != "/login?error=oidc" {
		t.Fatal(rr.Header())
	}
	cookie, state = start()
	nonce = "wrong"
	if rr = callback(cookie, state); rr.Header().Get("Location") != "/login?error=oidc" {
		t.Fatal(rr.Header())
	}
	cookie, state = start()
	verified = false
	if rr = callback(cookie, state); rr.Header().Get("Location") != "/login?error=not_allowed" {
		t.Fatal(rr.Header())
	}
	cookie, state = start()
	cookie.Value += "tampered"
	if rr = callback(cookie, state); rr.Header().Get("Location") != "/login?error=oidc" {
		t.Fatal(rr.Header())
	}
	info, err := os.Stat(c.SessionKeyFile)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal(info, err)
	}
}
func TestFirstUserAndAllowlist(t *testing.T) {
	c, err := config.Load(nil)
	if err != nil {
		t.Fatal(err)
	}
	c.DataDir = t.TempDir()
	c.SessionKeyFile = c.DataDir + "/session.key"
	c.DevLogin = true
	c.ClientID = ""
	c.ClientSecret = ""
	s, err := store.Open(c.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	a, err := New(context.Background(), s, c)
	if err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, email := range []string{"a@example.com", "b@example.com"} {
		wg.Add(1)
		go func() { defer wg.Done(); _, err := a.Login("issuer", email, email, email, ""); results <- err }()
	}
	wg.Wait()
	close(results)
	success := 0
	for err := range results {
		if err == nil {
			success++
		} else if err != ErrNotAllowed {
			t.Fatal(err)
		}
	}
	if success != 1 {
		t.Fatal(success)
	}
	var email string
	s.DB.QueryRow("SELECT value FROM settings WHERE key='first_user_email'").Scan(&email)
	a2, err := New(context.Background(), s, c)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a2.Login("issuer", email, email, "Updated", ""); err != nil {
		t.Fatal(err)
	}
	a2.Config.AllowedEmails = " allowed@example.com "
	if _, err = a2.Login("issuer", "allowed", "ALLOWED@example.com", "Allowed", ""); err != nil {
		t.Fatal(err)
	}
	if _, err = a2.Login("issuer", "other", "other@example.com", "Other", ""); err != ErrNotAllowed {
		t.Fatal(err)
	}
	a2.Config.OpenSignup = true
	if _, err = a2.Login("issuer", "other", "other@example.com", "Other", ""); err != nil {
		t.Fatal(err)
	}
}
func TestSafeNextCSRF(t *testing.T) {
	for _, s := range []string{"https://evil.example", "//evil.example", "/\\evil.example", "javascript:bad", "/\r\nevil"} {
		if SafeNext(s) != "/" {
			t.Fatal(s)
		}
	}
	if SafeNext("/local#room=test") != "/local#room=test" {
		t.Fatal("valid path rejected")
	}
	for _, method := range []string{"POST", "PUT", "PATCH", "DELETE"} {
		for _, origin := range []string{"", "https://evil.example", "https://draw.example"} {
			r := httptest.NewRequest(method, "/", strings.NewReader(""))
			r.Header.Set("Origin", origin)
			if CSRF(r, "https://draw.example") != (origin == "https://draw.example") {
				t.Fatal(method, origin)
			}
		}
	}
}
