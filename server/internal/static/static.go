package static

import (
	"io/fs"
	"net/http"
	"path"
	"strings"
)

func Handler(files fs.FS) http.Handler {
	fileServer := http.FileServer(http.FS(files))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && r.Method != "HEAD" {
			http.Error(w, "method not allowed", 405)
			return
		}
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name == "" {
			name = "index.html"
		}
		info, err := fs.Stat(files, name)
		if err != nil || info.IsDir() {
			name = "index.html"
		}
		if strings.HasPrefix(name, "assets/") || strings.HasPrefix(name, "fonts/") || strings.HasPrefix(name, "locales/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		if name == "index.html" {
			b, err := fs.ReadFile(files, name)
			if err != nil {
				http.Error(w, "frontend unavailable", 500)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(200)
			if r.Method != "HEAD" {
				_, _ = w.Write(b)
			}
			return
		}
		clone := r.Clone(r.Context())
		clone.URL.Path = "/" + name
		fileServer.ServeHTTP(w, clone)
	})
}
