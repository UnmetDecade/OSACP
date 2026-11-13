-- Artifact file names.
--
-- The artifact channel stores bytes and digests; the original name is needed to present a file
-- (download filename, task file list) instead of an opaque artifact id. The name is metadata only:
-- storage is still keyed by artifact_id and the digest is still recomputed by the server.
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS name TEXT;
