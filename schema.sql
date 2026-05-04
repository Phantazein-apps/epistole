CREATE TABLE IF NOT EXISTS folder_state (
  folder       TEXT PRIMARY KEY,
  last_uid     INTEGER NOT NULL DEFAULT 0,
  uidvalidity  INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT,
  message_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS emails (
  id                   TEXT PRIMARY KEY,
  folder               TEXT NOT NULL,
  uid                  INTEGER NOT NULL,
  message_id           TEXT,
  in_reply_to          TEXT,
  subject              TEXT,
  sender               TEXT,
  recipients           TEXT,
  date_iso             TEXT,
  has_attachments      INTEGER DEFAULT 0,
  attachment_filenames TEXT,
  snippet              TEXT,
  indexed_at           TEXT
);

CREATE TABLE IF NOT EXISTS sync_jobs (
  job_id      TEXT PRIMARY KEY,
  status      TEXT NOT NULL,
  started_at  TEXT,
  finished_at TEXT,
  folders     TEXT,
  full_sync   INTEGER DEFAULT 0,
  error       TEXT
);

CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);
CREATE INDEX IF NOT EXISTS idx_emails_in_reply_to ON emails(in_reply_to);
CREATE INDEX IF NOT EXISTS idx_emails_folder ON emails(folder);
CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date_iso);
