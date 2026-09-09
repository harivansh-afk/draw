-- Keep provenance after scene deletion so a repeated migration does not resurrect it.
CREATE TABLE imports(source_id TEXT PRIMARY KEY, scene_id TEXT NOT NULL, imported_at TEXT NOT NULL);
