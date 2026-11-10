-- AI Office schema v1. All ids are TEXT (uuid or stable hash). Timestamps are ISO-8601 UTC strings.
CREATE TABLE profile (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL DEFAULT 'Me', created_at TEXT NOT NULL
);
CREATE TABLE departments (
  id TEXT PRIMARY KEY CHECK (id IN ('planning','video','dev','qa')),
  name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE role_definitions (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  department_id TEXT NOT NULL REFERENCES departments(id),
  subagent_types TEXT NOT NULL DEFAULT '[]', -- JSON array of Claude Code subagent types mapped to this role
  enabled INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('video','app','general')),
  description TEXT NOT NULL DEFAULT '',
  folder_path TEXT, repo_path TEXT,
  aspect_ratio TEXT, output_resolution TEXT, target_duration_s REAL, frame_rate REAL,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_projects_kind ON projects(kind, archived);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,               -- Claude Code session_id (or manual/demo id)
  source_type TEXT NOT NULL CHECK (source_type IN ('observed','orchestrated','manual','demo')),
  parent_session_id TEXT, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  cwd_label TEXT, started_at TEXT NOT NULL, last_event_at TEXT NOT NULL,
  ended_at TEXT, end_reason TEXT
);
CREATE INDEX idx_sessions_last ON sessions(last_event_at);
CREATE TABLE agents (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
  role_id TEXT REFERENCES role_definitions(id) ON DELETE SET NULL,
  department_id TEXT NOT NULL REFERENCES departments(id),
  origin TEXT NOT NULL CHECK (origin IN ('observed','orchestrated','manual','demo','roster')),
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  parent_session_id TEXT, claude_agent_id TEXT,
  created_at TEXT NOT NULL, last_event_at TEXT, ended_at TEXT
);
CREATE INDEX idx_agents_session ON agents(session_id);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'backlog'
    CHECK (status IN ('backlog','planned','in_progress','qa','revision','blocked','completed')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  department_id TEXT REFERENCES departments(id),
  deadline TEXT, version INTEGER NOT NULL DEFAULT 1,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  requires_evidence_for_qa INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
);
CREATE INDEX idx_tasks_project_status ON tasks(project_id, status);
CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);
CREATE TABLE task_assignments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  department_id TEXT REFERENCES departments(id),
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  assigned_at TEXT NOT NULL, released_at TEXT
);
CREATE INDEX idx_assign_task ON task_assignments(task_id);
CREATE TABLE workflow_transitions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_status TEXT NOT NULL, to_status TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'user', -- 'user' | 'suggestion-confirmed' | 'orchestrator'
  note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE INDEX idx_transitions_task ON workflow_transitions(task_id, created_at);
CREATE TABLE events (
  event_id TEXT PRIMARY KEY,           -- unique => deduplication
  ts TEXT NOT NULL, received_at TEXT NOT NULL,
  source_type TEXT NOT NULL, session_id TEXT, parent_session_id TEXT, agent_id TEXT,
  project_id TEXT, task_id TEXT, department_id TEXT,
  event_type TEXT NOT NULL, status TEXT NOT NULL,
  summary TEXT NOT NULL, safe_metadata TEXT NOT NULL DEFAULT '{}', correlation_id TEXT
);
CREATE INDEX idx_events_ts ON events(ts);
CREATE INDEX idx_events_session ON events(session_id, ts);
CREATE INDEX idx_events_task ON events(task_id, ts);
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('video','subtitle','thumbnail','code','test-result','build-result','report','other')),
  label TEXT NOT NULL, path TEXT, task_version INTEGER NOT NULL DEFAULT 1,
  metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX idx_artifacts_task ON artifacts(task_id);
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('task-completion','claude-permission','other')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  summary TEXT NOT NULL, session_id TEXT, requested_at TEXT NOT NULL, decided_at TEXT, decision_note TEXT
);
CREATE INDEX idx_approvals_status ON approvals(status);
CREATE TABLE notifications (
  id TEXT PRIMARY KEY, level TEXT NOT NULL CHECK (level IN ('info','success','warning','error','attention')),
  title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', ref_type TEXT, ref_id TEXT,
  created_at TEXT NOT NULL, read_at TEXT
);
CREATE INDEX idx_notifications_unread ON notifications(read_at, created_at);
CREATE TABLE integration_settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE execution_jobs (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ffmpeg','test','build','claude-managed')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  progress REAL, command_label TEXT NOT NULL, exit_code INTEGER,
  started_at TEXT, finished_at TEXT, log_tail TEXT NOT NULL DEFAULT ''
);
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
);
