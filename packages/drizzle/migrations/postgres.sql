-- ZanzoJS Universal Tuple Table — PostgreSQL
--   psql -d your_database -f postgres.sql
-- Drizzle definition: import { zanzoTuples } from '@zanzojs/drizzle/pg';

CREATE TABLE IF NOT EXISTS zanzo_tuples (
  id         SERIAL PRIMARY KEY,
  object     TEXT NOT NULL,
  relation   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_zanzo_unique ON zanzo_tuples (object, relation, subject);
CREATE INDEX IF NOT EXISTS idx_zanzo_subject_relation ON zanzo_tuples (subject, relation);
