package store

type Room struct {
	Rev, SceneVersion int64
	IV, Ciphertext    []byte
}

// A zero revision selects the latest persisted room rather than a history entry.
func (s *Store) Room(id string, revision int64) (Room, error) {
	var row Scanner
	if revision == 0 {
		row = s.DB.QueryRow("SELECT rev,scene_version,iv,ciphertext FROM rooms WHERE id=?", id)
	} else {
		row = s.DB.QueryRow("SELECT rev,scene_version,iv,ciphertext FROM room_versions WHERE room_id=? AND rev=?", id, revision)
	}
	var room Room
	err := row.Scan(&room.Rev, &room.SceneVersion, &room.IV, &room.Ciphertext)
	return room, err
}
