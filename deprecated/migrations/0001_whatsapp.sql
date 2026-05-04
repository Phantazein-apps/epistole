-- WhatsApp channel (BETA, read-only mirror).
-- Hermeneia remains the canonical WhatsApp MCP; it pushes events here via
-- /api/wa/push so Epistole can index them for unified semantic_search.
-- No writes, no sends, no command queue.

CREATE TABLE IF NOT EXISTS wa_accounts (
  id              TEXT PRIMARY KEY,        -- stable slug: "personal", "spain", "default"
  label           TEXT,
  phone           TEXT,
  connected_at    TEXT,
  last_seen_at    TEXT                     -- updated by /api/wa/heartbeat
);

CREATE TABLE IF NOT EXISTS wa_chats (
  jid               TEXT NOT NULL,
  account_id        TEXT NOT NULL,
  name              TEXT,
  last_message_time TEXT,
  unread_count      INTEGER DEFAULT 0,
  archived          INTEGER DEFAULT 0,
  parent_group_jid  TEXT,
  is_parent_group   INTEGER DEFAULT 0,
  PRIMARY KEY (jid, account_id)
);

CREATE TABLE IF NOT EXISTS wa_messages (
  id           TEXT NOT NULL,              -- whatsmeow message id
  chat_jid     TEXT NOT NULL,
  account_id   TEXT NOT NULL,
  sender       TEXT,                       -- full sender jid
  content      TEXT,
  timestamp    TEXT,                       -- ISO-8601
  is_from_me   INTEGER DEFAULT 0,
  media_type   TEXT,                       -- image | video | audio | document | sticker | null
  media_info   TEXT,                       -- JSON blob (URL, mediaKey, sha, filesize) — reserved
  filename     TEXT,
  indexed_at   TEXT,                       -- when this row was written on the Worker
  PRIMARY KEY (id, chat_jid, account_id)
);

CREATE TABLE IF NOT EXISTS wa_contacts (
  id            TEXT NOT NULL,
  account_id    TEXT NOT NULL,
  lid           TEXT,
  phone_jid     TEXT,
  name          TEXT,
  notify        TEXT,
  verified_name TEXT,
  PRIMARY KEY (id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_wa_messages_chat_ts ON wa_messages(account_id, chat_jid, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_wa_messages_ts      ON wa_messages(account_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_wa_messages_sender  ON wa_messages(account_id, sender);
CREATE INDEX IF NOT EXISTS idx_wa_chats_last       ON wa_chats(account_id, last_message_time DESC);
CREATE INDEX IF NOT EXISTS idx_wa_contacts_phone   ON wa_contacts(phone_jid);
CREATE INDEX IF NOT EXISTS idx_wa_contacts_name    ON wa_contacts(name);
