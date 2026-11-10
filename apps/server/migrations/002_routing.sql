-- Task Router (v2). Additive only: no existing table or row is changed.
CREATE TABLE routing_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  department_id TEXT NOT NULL REFERENCES departments(id),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('prompt','activity')),
  keywords TEXT NOT NULL DEFAULT '[]',       -- JSON array: prompt action words/phrases, or activity regexes
  context_words TEXT NOT NULL DEFAULT '[]',  -- JSON array: object nouns that qualify a generic verb
  priority INTEGER NOT NULL DEFAULT 50,
  enabled INTEGER NOT NULL DEFAULT 1,
  conditions TEXT NOT NULL DEFAULT '{}',     -- JSON: { activity?, scope }
  action TEXT NOT NULL DEFAULT '{}',         -- JSON: { mode, followUp[] }
  builtin INTEGER NOT NULL DEFAULT 0,
  last_triggered_at TEXT,
  last_source_event_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- One work item per routed request (or per session with activity but no observed prompt).
-- Prompt text is NEVER stored here: only the routing decision (rule ids + rule keywords) and the prompt length.
CREATE TABLE work_items (
  id TEXT PRIMARY KEY,
  source_event_id TEXT UNIQUE,              -- the prompt event that created it (dedup)
  session_id TEXT,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,  -- kanban task, when the session is linked to one
  title TEXT NOT NULL,
  intent TEXT NOT NULL,
  status TEXT NOT NULL,
  turn TEXT NOT NULL DEFAULT 'running' CHECK (turn IN ('running','ended')),
  current_department TEXT,
  decision TEXT NOT NULL DEFAULT '{}',
  prompt_length INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_event_at TEXT NOT NULL,
  closed_at TEXT, close_reason TEXT
);
CREATE INDEX idx_work_items_session ON work_items(session_id, created_at);
CREATE INDEX idx_work_items_status ON work_items(status, last_event_at);

-- Per-department responsibility for a work item. UNIQUE prevents duplicate assignments.
CREATE TABLE work_item_stages (
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  department_id TEXT NOT NULL REFERENCES departments(id),
  role TEXT NOT NULL CHECK (role IN ('coordinator','producer','verifier','support')),
  state TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  rule_id TEXT,
  approved INTEGER NOT NULL DEFAULT 1,
  activity_seen INTEGER NOT NULL DEFAULT 0,
  qa_result TEXT,                           -- passed | failed | interrupted (last observed verification)
  evidence TEXT NOT NULL DEFAULT '[]',      -- JSON array of { eventId, at, kind, result, summary }
  sort_order INTEGER NOT NULL DEFAULT 0,
  since TEXT NOT NULL, last_event_at TEXT,
  PRIMARY KEY (work_item_id, department_id)
);

-- Audit log of every routing decision, assignment, state change, override and error.
CREATE TABLE routing_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,                       -- decision | assign | state | evidence | override | close | error | settings | rule
  work_item_id TEXT, session_id TEXT, department_id TEXT,
  from_state TEXT, to_state TEXT, rule_id TEXT, source_event_id TEXT,
  actor TEXT NOT NULL DEFAULT 'router',     -- router | user
  summary TEXT NOT NULL
);
CREATE INDEX idx_routing_log_ts ON routing_log(ts);
CREATE INDEX idx_routing_log_item ON routing_log(work_item_id, ts);
