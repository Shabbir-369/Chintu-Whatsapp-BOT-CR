-- 001_init.sql
-- Full schema for Not Your Type (Chintu) WhatsApp Bot
-- Follows Section 13.2 of the blueprint exactly.

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ─────────────────────────────────────────
-- IDENTITY
-- ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS people (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name    TEXT,
  push_name       TEXT,
  is_owner        BOOLEAN NOT NULL DEFAULT FALSE,
  language_pref   TEXT NOT NULL DEFAULT 'hinglish',
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS person_identities (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id   UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  jid         TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL CHECK (kind IN ('phone','lid')),
  phone       TEXT
);

CREATE TABLE IF NOT EXISTS owner_identities (
  jid         TEXT PRIMARY KEY,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- ACCESS
-- ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dm_access (
  person_id             UUID PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','revoked')),
  requested_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at            TIMESTAMPTZ,
  owner_notified_at     TIMESTAMPTZ,
  first_message_preview TEXT
);

CREATE TABLE IF NOT EXISTS approvals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code              TEXT UNIQUE NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('dm','name','group','message','other')),
  subject_person_id UUID REFERENCES people(id) ON DELETE SET NULL,
  payload           JSONB NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved','rejected','expired')),
  card_message_id   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at        TIMESTAMPTZ,
  decided_value     TEXT
);

CREATE TABLE IF NOT EXISTS name_claims (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id     UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  source        TEXT NOT NULL CHECK (source IN ('pushname','context','self_claim','owner')),
  claimed_name  TEXT NOT NULL,
  evidence      JSONB NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at    TIMESTAMPTZ
);

-- ─────────────────────────────────────────
-- GROUPS AND CHAT
-- ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS groups (
  jid               TEXT PRIMARY KEY,
  subject           TEXT NOT NULL,
  member_count      INT NOT NULL DEFAULT 0,
  enabled           BOOLEAN NOT NULL DEFAULT FALSE,
  mode              TEXT NOT NULL DEFAULT 'ambient' CHECK (mode IN ('ambient','trigger','mute')),
  kind              TEXT NOT NULL DEFAULT 'unofficial_class',
  enabled_at        TIMESTAMPTZ,
  last_activity_at  TIMESTAMPTZ,
  last_bot_at       TIMESTAMPTZ,
  last_morning_date DATE,
  settings          JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS group_members (
  group_jid     TEXT NOT NULL REFERENCES groups(jid) ON DELETE CASCADE,
  person_id     UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'member',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_jid, person_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id                  BIGSERIAL PRIMARY KEY,
  wa_id               TEXT NOT NULL,
  chat_jid            TEXT NOT NULL,
  sender_person_id    UUID REFERENCES people(id) ON DELETE SET NULL,
  from_bot            BOOLEAN NOT NULL DEFAULT FALSE,
  text                TEXT,
  quoted_wa_id        TEXT,
  mentions            JSONB NOT NULL DEFAULT '[]',
  kind                TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','sticker','image','audio','reaction','other')),
  sent_at             TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chat_jid, wa_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_sent ON messages (chat_jid, sent_at DESC);

-- ─────────────────────────────────────────
-- MEMORY
-- ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS person_profiles (
  person_id             UUID PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  familiarity           INT NOT NULL DEFAULT 0,
  humour_style          TEXT,
  teasing_tolerance     INT NOT NULL DEFAULT 3,
  habits                JSONB NOT NULL DEFAULT '[]',
  interests             JSONB NOT NULL DEFAULT '[]',
  sensitive_flags       JSONB NOT NULL DEFAULT '{}',
  relationship_to_owner TEXT NOT NULL DEFAULT 'neutral',
  fake_name_count       INT NOT NULL DEFAULT 0,
  last_roasted_at       TIMESTAMPTZ,
  last_joke             TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS person_facts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id         UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  fact              TEXT NOT NULL,
  confidence        REAL NOT NULL DEFAULT 1.0,
  scope             TEXT NOT NULL DEFAULT 'public' CHECK (scope IN ('public','dm')),
  source_message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  superseded_by     UUID REFERENCES person_facts(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS group_profiles (
  group_jid     TEXT PRIMARY KEY REFERENCES groups(jid) ON DELETE CASCADE,
  running_jokes JSONB NOT NULL DEFAULT '[]',
  rules         JSONB NOT NULL DEFAULT '{}',
  topics        JSONB NOT NULL DEFAULT '{}',
  mood          TEXT NOT NULL DEFAULT 'calm',
  summary_last  TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS memories (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope           TEXT NOT NULL CHECK (scope IN ('person','group','global')),
  person_id       UUID REFERENCES people(id) ON DELETE CASCADE,
  group_jid       TEXT REFERENCES groups(jid) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('episode','fact','daily_summary','joke','promise')),
  text            TEXT NOT NULL,
  importance      SMALLINT NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  strength        REAL NOT NULL DEFAULT 1.0,
  confidence      REAL NOT NULL DEFAULT 1.0,
  emotional_weight REAL NOT NULL DEFAULT 0.0,
  visibility      TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','dm')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  superseded_by   UUID REFERENCES memories(id) ON DELETE SET NULL,
  archived_at     TIMESTAMPTZ,
  tsv             TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', text)) STORED
);

CREATE INDEX IF NOT EXISTS idx_memories_tsv ON memories USING GIN (tsv);
CREATE INDEX IF NOT EXISTS idx_memories_text_trgm ON memories USING GIN (text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_memories_person ON memories (person_id);
CREATE INDEX IF NOT EXISTS idx_memories_group ON memories (group_jid);

CREATE TABLE IF NOT EXISTS commitments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_jid   TEXT REFERENCES groups(jid) ON DELETE SET NULL,
  person_id   UUID REFERENCES people(id) ON DELETE SET NULL,
  text        TEXT NOT NULL,
  due_at      TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','cancelled')),
  created_by  UUID REFERENCES people(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- POD
-- ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pod_accounts (
  person_id             UUID PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  enc_credentials       JSONB NOT NULL,
  linked_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_ok_at            TIMESTAMPTZ,
  fail_count            INT NOT NULL DEFAULT 0,
  attempts_window_start TIMESTAMPTZ,
  attempts_in_window    INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pod_sessions (
  person_id   UUID PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  enc_session JSONB NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS pod_link_sessions (
  person_id    UUID PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  step         TEXT NOT NULL DEFAULT 'consent' CHECK (step IN ('consent','email','password')),
  enc_partial  JSONB,
  expires_at   TIMESTAMPTZ NOT NULL
);

-- ─────────────────────────────────────────
-- CLASS DATA
-- ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS timetable_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  weekday         SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  slot            TEXT NOT NULL,
  start_time      TIME NOT NULL,
  end_time        TIME NOT NULL,
  code            TEXT NOT NULL,
  subject         TEXT NOT NULL,
  short           TEXT NOT NULL,
  faculty         TEXT NOT NULL,
  room            TEXT NOT NULL,
  batch           TEXT,
  parallel_group  TEXT,
  effective_from  DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to    DATE
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date_from   DATE NOT NULL,
  date_to     DATE NOT NULL,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('exam','holiday','break','event')),
  notes       TEXT
);

CREATE TABLE IF NOT EXISTS day_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date        DATE NOT NULL,
  group_jid   TEXT REFERENCES groups(jid) ON DELETE SET NULL,
  text        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notices (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source      TEXT NOT NULL CHECK (source IN ('pod','owner')),
  source_id   TEXT,
  text        TEXT NOT NULL,
  posted_at   TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source, source_id)
);

-- ─────────────────────────────────────────
-- SCHEDULING AND STATS
-- ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jobs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        TEXT NOT NULL,
  run_at      TIMESTAMPTZ NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed','cancelled')),
  attempts    INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jobs_run_at ON jobs (run_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS daily_events (
  date        DATE NOT NULL,
  group_jid   TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('morning','starter','evening')),
  count       INT NOT NULL DEFAULT 0,
  PRIMARY KEY (date, group_jid, kind)
);

CREATE TABLE IF NOT EXISTS mass_bunk_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_jid     TEXT NOT NULL REFERENCES groups(jid) ON DELETE CASCADE,
  target_date   DATE NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  linked_count  INT NOT NULL DEFAULT 0,
  unknown_count INT NOT NULL DEFAULT 0,
  yellow_count  INT NOT NULL DEFAULT 0,
  red_count     INT NOT NULL DEFAULT 0,
  summary       JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS mass_bunk_results (
  run_id      UUID NOT NULL REFERENCES mass_bunk_runs(id) ON DELETE CASCADE,
  person_id   UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  worst_course TEXT,
  before_pct  REAL,
  after_pct   REAL,
  zone        TEXT,
  warned_at   TIMESTAMPTZ,
  PRIMARY KEY (run_id, person_id)
);

CREATE TABLE IF NOT EXISTS usage_counters (
  date    DATE NOT NULL,
  key     TEXT NOT NULL,
  value   INT NOT NULL DEFAULT 0,
  PRIMARY KEY (date, key)
);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id              BIGSERIAL PRIMARY KEY,
  at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_person_id UUID REFERENCES people(id) ON DELETE SET NULL,
  action          TEXT NOT NULL,
  detail          JSONB NOT NULL DEFAULT '{}'
);

-- Additional indexes
CREATE INDEX IF NOT EXISTS idx_person_identities_person ON person_identities (person_id);
CREATE INDEX IF NOT EXISTS idx_name_claims_person ON name_claims (person_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals (status) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_person_facts_person ON person_facts (person_id);
CREATE INDEX IF NOT EXISTS idx_group_members_person ON group_members (person_id);
CREATE INDEX IF NOT EXISTS idx_timetable_weekday ON timetable_entries (weekday, effective_from);
CREATE INDEX IF NOT EXISTS idx_calendar_events_date ON calendar_events (date_from, date_to);
CREATE INDEX IF NOT EXISTS idx_day_notes_date ON day_notes (date);
CREATE INDEX IF NOT EXISTS idx_mass_bunk_results_date ON mass_bunk_runs (target_date);
CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log (at DESC);
