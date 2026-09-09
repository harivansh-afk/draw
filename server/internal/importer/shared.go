package importer

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/mail"
	"strings"
	"time"

	"git.harivan.sh/harivansh-afk/draw/server/internal/store"
)

type element struct {
	Version int64  `json:"version"`
	Type    string `json:"type"`
	FileID  string `json:"fileId"`
}

func (d *drawing) setElements(raw []byte) ([]element, error) {
	var elements []element
	if err := json.Unmarshal(raw, &elements); err != nil || elements == nil {
		return nil, errors.New("elements must be a JSON array")
	}
	for _, e := range elements {
		if e.Version < 0 || d.version > 9007199254740991-e.Version {
			return nil, errors.New("invalid scene version")
		}
		d.version += e.Version
	}
	d.elements, d.elementCount = raw, len(elements)
	return elements, nil
}

func (d *drawing) addFile(id, mime, dataURL string, f map[string]any) error {
	if !store.ValidFileID(id) {
		return fmt.Errorf("invalid file id %q", id)
	}
	if mime == "" {
		mime, _, _ = strings.Cut(strings.TrimPrefix(dataURL, "data:"), ";")
		mime, _, _ = strings.Cut(mime, ",")
	}
	created := f["created"]
	if created == nil {
		t, _ := time.Parse(time.RFC3339Nano, d.created)
		created = t.UnixMilli()
	}
	retrieved := f["lastRetrieved"]
	if retrieved == nil {
		retrieved = created
	}
	metadata, err := json.Marshal(map[string]any{"id": id, "mimeType": mime, "created": created, "lastRetrieved": retrieved})
	if err != nil {
		return err
	}
	d.metadata[id], d.files[id] = metadata, []byte(dataURL)
	return nil
}

func ownerEmail(value string) (string, error) {
	owner := strings.ToLower(strings.TrimSpace(value))
	email, err := mail.ParseAddress(owner)
	if err != nil || email.Address != owner {
		return "", errors.New("valid --owner email required")
	}
	return owner, nil
}

func lookupOwner(s *store.Store, owner string, create bool) (string, bool, error) {
	var uid string
	err := s.DB.QueryRow("SELECT id FROM users WHERE email=?", owner).Scan(&uid)
	missing := errors.Is(err, sql.ErrNoRows)
	if err != nil && !missing {
		return "", false, err
	}
	if missing && !create {
		return "", false, errors.New("owner must sign in first or use --create-owner")
	}
	return uid, missing, nil
}
