-- whatsapp-bot schema (PLAN 4.2). One database: `whatsapp-bot`.
-- Timestamps are ISO-8601 UTC strings written by the Worker (see src/lib/time.ts).

CREATE TABLE people (
  id INTEGER PRIMARY KEY,
  wa_id TEXT NOT NULL UNIQUE,           -- phone in Meta format (e.g. 34600000000)
  profile_name TEXT,                    -- from webhook contacts[].profile.name
  display_name TEXT,                    -- "com vols que et digui?"
  created_at TEXT NOT NULL,
  last_inbound_at TEXT,                 -- drives 24h-window checks in the inbox
  gdpr_deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE flow_instances (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id),
  flow_type TEXT NOT NULL,              -- 'curs-sardanes', 'gdpr-erase', future flows...
  status TEXT NOT NULL,                 -- 'active' | 'completed' | 'abandoned' | 'declined'
  step TEXT,                            -- current step key while active
  data_json TEXT NOT NULL DEFAULT '{}', -- collected answers (queryable via json_extract)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  wa_message_id TEXT UNIQUE,            -- UNIQUE = webhook retry dedupe (INSERT OR IGNORE)
  person_id INTEGER NOT NULL REFERENCES people(id),
  direction TEXT NOT NULL,             -- 'in' | 'out'
  msg_type TEXT NOT NULL,              -- text | interactive | list_reply | button_reply | unsupported | status...
  body_json TEXT NOT NULL,             -- full payload for transcript rendering
  status TEXT,                         -- outbound delivery status: sent|delivered|read|failed
  error_json TEXT,                     -- Meta error payload when a send/status fails
  flow_instance_id INTEGER,            -- attribution via context.id when applicable
  ai_meta_json TEXT,                   -- model, latency, tokens when AI fallback produced it
  created_at TEXT NOT NULL
);

CREATE TABLE kb_entries (              -- DYNAMIC knowledge (editable in inbox admin)
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  content_md TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE settings (                -- key/value config
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Indexes ----------------------------------------------------------------
-- Transcript rendering + last-message lookups per person, newest last.
CREATE INDEX idx_messages_person_created ON messages (person_id, created_at);
-- context.id -> outbound message -> flow_instance_id routing.
CREATE INDEX idx_messages_flow_instance ON messages (flow_instance_id);
-- "the active flow for this person" + reporting by flow type/status.
CREATE INDEX idx_flow_person_status ON flow_instances (person_id, status);
CREATE INDEX idx_flow_type_status ON flow_instances (flow_type, status);

-- Seed -------------------------------------------------------------------
INSERT INTO settings (key, value, updated_at) VALUES
  ('course_status', 'exploring', datetime('now')),
  ('course_status_note', '', datetime('now'));
