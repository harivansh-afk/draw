-- Older thumbnails baked in the saving client's theme; regenerate from rooms.
UPDATE scenes SET thumbnail_updated_at = NULL;
