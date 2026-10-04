-- AUDA schema. Authoritative. Applied idempotently at boot.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS identity (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  user_name TEXT,
  persona TEXT,
  presence TEXT NOT NULL DEFAULT 'available',
  narration TEXT,
  presence_subject TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  icon TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  space_id TEXT REFERENCES spaces(id),
  title TEXT,
  channel TEXT NOT NULL DEFAULT 'web',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL,            -- user | auda | system
  content TEXT NOT NULL,
  objects_json TEXT NOT NULL DEFAULT '[]', -- inline objects: [{type,id}]
  channel TEXT NOT NULL DEFAULT 'web',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_conv ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS responsibilities (
  id TEXT PRIMARY KEY,
  space_id TEXT REFERENCES spaces(id),
  title TEXT NOT NULL,
  description TEXT,
  playbook TEXT NOT NULL,
  state TEXT NOT NULL,           -- DRAFT|WATCHING|HANDLING|NEEDS_USER|PAUSED|ENDED
  config_json TEXT NOT NULL DEFAULT '{}',
  origin_json TEXT NOT NULL DEFAULT '{}',
  status_line TEXT,
  last_triggered_at INTEGER,
  last_outcome TEXT,
  trigger_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  space_id TEXT REFERENCES spaces(id),
  responsibility_id TEXT REFERENCES responsibilities(id),
  parent_task_id TEXT REFERENCES tasks(id),
  title TEXT NOT NULL,
  goal TEXT,
  origin_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL,
  playbook TEXT NOT NULL,
  input_json TEXT NOT NULL DEFAULT '{}',
  checkpoint_json TEXT NOT NULL DEFAULT '{}',
  current_step INTEGER NOT NULL DEFAULT 0,
  step_count INTEGER NOT NULL DEFAULT 0,
  now_line TEXT,                 -- concise operational reasoning shown to the user
  next_event_at INTEGER,
  waiting_on TEXT,
  attention TEXT,                -- null | approval | decision | problem
  priority INTEGER NOT NULL DEFAULT 2,
  result_summary TEXT,
  error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 4,
  cost_micro INTEGER NOT NULL DEFAULT 0,
  deadline_at INTEGER,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_state ON tasks(state, next_event_at);
CREATE INDEX IF NOT EXISTS tasks_resp ON tasks(responsibility_id, created_at);

CREATE TABLE IF NOT EXISTS task_steps (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  idx INTEGER NOT NULL,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', -- pending|running|done|waiting|failed|skipped
  tool TEXT,
  narration TEXT,
  output_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  ended_at INTEGER,
  UNIQUE(task_id, idx)
);

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  attempt INTEGER NOT NULL,
  state TEXT NOT NULL,           -- running|ended|abandoned
  worker_id TEXT NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS runs_live ON task_runs(state, lease_expires_at);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,      -- responsibility | task | system
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,            -- cron | once | interval | fuzzy
  spec TEXT NOT NULL,
  description TEXT,
  next_run_at INTEGER,
  window_end INTEGER,
  last_run_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS schedules_due ON schedules(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  responsibility_id TEXT NOT NULL REFERENCES responsibilities(id),
  event_pattern TEXT NOT NULL,
  filter_json TEXT NOT NULL DEFAULT '{}',
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_fired_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS watchers (
  id TEXT PRIMARY KEY,
  responsibility_id TEXT NOT NULL REFERENCES responsibilities(id),
  kind TEXT NOT NULL,            -- disk | url | github_ci
  config_json TEXT NOT NULL DEFAULT '{}',
  interval_sec INTEGER NOT NULL,
  state_json TEXT NOT NULL DEFAULT '{}',
  description TEXT,
  last_value TEXT,
  last_checked_at INTEGER,
  next_check_at INTEGER,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  subject_type TEXT,
  subject_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_time ON events(created_at);

CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  space_id TEXT,
  task_id TEXT,
  responsibility_id TEXT,
  kind TEXT NOT NULL,            -- observe|reason|act|wait|approval|recover|complete|problem|memory|system|user
  title TEXT NOT NULL,
  detail TEXT,
  raw_json TEXT
);
CREATE INDEX IF NOT EXISTS activity_ts ON activity(ts);
CREATE INDEX IF NOT EXISTS activity_task ON activity(task_id, ts);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,            -- identity|preference|episodic|project|operational|semantic|relationship|procedural|working
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL,          -- chat|task|consolidation|user|system
  source_ref TEXT,
  confidence REAL NOT NULL DEFAULT 0.8,
  scope TEXT NOT NULL DEFAULT 'global', -- global|space|responsibility
  space_id TEXT,
  responsibility_id TEXT,
  weight TEXT NOT NULL DEFAULT 'mentioned', -- mentioned|established|defining
  pinned INTEGER NOT NULL DEFAULT 0,
  sensitivity TEXT NOT NULL DEFAULT 'normal', -- normal|personal|secret
  expires_at INTEGER,
  reinforced INTEGER NOT NULL DEFAULT 1,
  last_used_at INTEGER,
  superseded_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, title, content);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  responsibility_id TEXT,
  space_id TEXT,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  why TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL,           -- connected|disconnected|error|degraded
  config_json TEXT NOT NULL DEFAULT '{}',
  credential_ref TEXT,
  detail TEXT,
  error TEXT,
  breaker_json TEXT NOT NULL DEFAULT '{}',
  last_ok_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  capability TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'global',
  scope_id TEXT,
  level TEXT NOT NULL,           -- autonomous|rule|approval|deny
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  compiled_json TEXT NOT NULL,
  interpretation TEXT NOT NULL,
  state TEXT NOT NULL,           -- draft|active|disabled
  space_id TEXT,
  origin TEXT,
  hits INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  activated_at INTEGER
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  step_idx INTEGER NOT NULL,
  capability TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  recommendation TEXT,
  impact TEXT,
  if_yes TEXT,
  if_no TEXT,
  approve_label TEXT,
  reject_label TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  actions_json TEXT NOT NULL DEFAULT '[]', -- exact actions covered: [{capability, inputHash, describe}]
  state TEXT NOT NULL,           -- pending|approved|rejected|expired
  decided_at INTEGER,
  decision_channel TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS approvals_state ON approvals(state);

CREATE TABLE IF NOT EXISTS computers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  driver TEXT NOT NULL,
  state TEXT NOT NULL,
  controller TEXT NOT NULL DEFAULT 'auda', -- auda|human
  config_json TEXT NOT NULL DEFAULT '{}',
  last_health_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS computer_sessions (
  id TEXT PRIMARY KEY,
  computer_id TEXT NOT NULL,
  kind TEXT NOT NULL,            -- browser|terminal
  state TEXT NOT NULL,           -- running|crashed|recovering|stopped
  detail TEXT,
  crash_count INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL,           -- fyi|completed|attention|approval|blocked|urgent|watching
  title TEXT NOT NULL,
  body TEXT,
  subject_type TEXT,
  subject_id TEXT,
  delivered INTEGER NOT NULL DEFAULT 1,
  suppressed_reason TEXT,
  read_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,           -- auda|user|system
  capability TEXT NOT NULL,
  target TEXT,
  task_id TEXT,
  decision TEXT NOT NULL,        -- autonomous|rule:<id>|approved:<id>|denied|rejected
  result TEXT NOT NULL,          -- ok|error|blocked|deduplicated
  idempotency_key TEXT,
  external_id TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit_log(ts);

CREATE TABLE IF NOT EXISTS actions (
  idempotency_key TEXT PRIMARY KEY,
  task_id TEXT,
  capability TEXT NOT NULL,
  state TEXT NOT NULL,           -- started|done|failed
  external_id TEXT,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS model_calls (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  role TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micro INTEGER NOT NULL DEFAULT 0,
  task_id TEXT,
  purpose TEXT,
  ok INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'offline', -- online|offline|revoked
  platform TEXT,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

-- Apps (e.g. the Android client) that are allowed to control AUDA.
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS pairings (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT,
  code TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  state TEXT NOT NULL,           -- pending|approved|rejected|claimed|expired
  client_id TEXT,
  token TEXT,                    -- held only until the app collects it
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- ─── Organization ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,            -- owner|admin|member
  password_hash TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  disabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT
);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_by TEXT
);

-- ─── Plugins (external apps over OAuth / API keys / MCP) ─────────────────────
CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,            -- openapi|mcp
  preset TEXT,
  description TEXT,
  icon TEXT,
  config_json TEXT NOT NULL,     -- auth + base url + tools (no secrets)
  client_secret_ref TEXT,        -- OAuth client secret (secret broker)
  created_by TEXT,
  visibility TEXT NOT NULL DEFAULT 'org',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_connections (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  state TEXT NOT NULL,           -- connected|expired|error
  token_ref TEXT,                -- secret broker: access token
  refresh_ref TEXT,              -- secret broker: refresh token
  expires_at INTEGER,
  account TEXT,
  scopes TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(plugin_id, user_id)
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  verifier TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  return_to TEXT,
  created_at INTEGER NOT NULL
);

-- ─── Custom agents, knowledge and learning ───────────────────────────────────
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  emoji TEXT,
  color TEXT,
  description TEXT,
  instructions TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',   -- plugins, tools, model, autonomy, sources, study schedule
  visibility TEXT NOT NULL DEFAULT 'private', -- private|org
  template TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS kb_documents (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL,          -- upload|url|note|lesson|skill|task
  source_ref TEXT,
  kind TEXT NOT NULL DEFAULT 'doc',  -- doc|lesson|skill
  chars INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  helpful INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'ready', -- ready|error|indexing
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kb_chunks (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  text TEXT NOT NULL,
  vector BLOB,
  embedder TEXT,
  uses INTEGER NOT NULL DEFAULT 0,
  helpful INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS kb_chunks_agent ON kb_chunks(agent_id);
CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(chunk_id UNINDEXED, agent_id UNINDEXED, text);
CREATE TABLE IF NOT EXISTS agent_feedback (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  user_id TEXT,
  rating INTEGER NOT NULL,       -- +1 / -1
  comment TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS retrievals (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  query TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  features_json TEXT NOT NULL,
  label REAL,                    -- 1 used/helpful, 0 not; null = unknown yet
  trained INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS retrievals_task ON retrievals(task_id);
