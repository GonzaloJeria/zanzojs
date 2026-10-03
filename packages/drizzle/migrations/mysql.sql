-- ZanzoJS Universal Tuple Table — MySQL
--   mysql -u root -p your_database < mysql.sql
-- Drizzle definition: import { zanzoTuples } from '@zanzojs/drizzle/mysql';

CREATE TABLE IF NOT EXISTS zanzo_tuples (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  object     VARCHAR(255) NOT NULL,
  relation   VARCHAR(255) NOT NULL,
  subject    VARCHAR(255) NOT NULL,
  expires_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_zanzo_unique ON zanzo_tuples (object, relation, subject);
CREATE INDEX idx_zanzo_subject_relation ON zanzo_tuples (subject, relation);
