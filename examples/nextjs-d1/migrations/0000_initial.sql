-- Recommended indexes for Zanzo
CREATE TABLE IF NOT EXISTS zanzo_tuples (
  subject TEXT NOT NULL,
  relation TEXT NOT NULL,
  object TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_zanzo_unique_tuple ON zanzo_tuples (subject, relation, object);
CREATE INDEX idx_zanzo_subject_relation ON zanzo_tuples (subject, relation);
CREATE INDEX idx_zanzo_object_relation ON zanzo_tuples (object, relation);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  workspace_id TEXT NOT NULL
);
