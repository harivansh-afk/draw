package config

import "testing"

func TestConfig(t *testing.T) {
	t.Setenv("DRAW_DATA_DIR", "/tmp/draw-config")
	t.Setenv("DRAW_LISTEN", "127.0.0.1:39991")
	c, err := Load([]string{"--listen=127.0.0.1:39992", "--base-url=https://draw.example", "--dev-login", "--max-room-bytes=1234"})
	if err != nil {
		t.Fatal(err)
	}
	if c.Listen != "127.0.0.1:39992" || c.RedirectURI != "https://draw.example/api/auth/oidc/callback" || c.SessionKeyFile != "/tmp/draw-config/session.key" || c.MaxRoomBytes != 1234 || !c.DevLogin {
		t.Fatal(c)
	}
	for _, args := range [][]string{{"--base-url=https://example/path"}, {"--max-file-bytes=0"}, {"--room-history=0"}, {"unexpected"}} {
		if _, err = Load(args); err == nil {
			t.Fatal(args)
		}
	}
	t.Setenv("DRAW_TRUST_PROXY", "invalid")
	if _, err = Load(nil); err == nil {
		t.Fatal("invalid boolean accepted")
	}
}
