CREATE TABLE activity(id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, actor_id TEXT REFERENCES users(id) ON DELETE SET NULL, kind TEXT NOT NULL, scene_id TEXT, scene_name TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', at TEXT NOT NULL);
CREATE INDEX activity_owner ON activity(owner_id, at);
CREATE INDEX activity_scene ON activity(scene_id, at);
