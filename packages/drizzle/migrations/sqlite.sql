-- ZanzoJS Universal Tuple Table — SQLite / Cloudflare D1
--   SQLite:        sqlite3 your.db < sqlite.sql
--   Cloudflare D1: wrangler d1 execute YOUR_DB --file=sqlite.sql
-- Drizzle definition: import { zanzoTuples } from '@zanzojs/drizzle/sqlite';

CREATE TABLE IF NOT EXISTS zanzo_tuples (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  object     TEXT NOT NULL,
  relation   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_zanzo_unique ON zanzo_tuples (object, relation, subject);
CREATE INDEX IF NOT EXISTS idx_zanzo_subject_relation ON zanzo_tuples (subject, relation);
