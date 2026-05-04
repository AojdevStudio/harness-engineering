export const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS workflow_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_path TEXT NOT NULL,
    config_json TEXT NOT NULL,
    prompt_template TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS issues_seen (
    issue_id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    title TEXT NOT NULL,
    state TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    issue_id TEXT NOT NULL,
    identifier TEXT NOT NULL,
    workspace_path TEXT,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    last_error TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS claims (
    issue_id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    state TEXT NOT NULL,
    run_id TEXT,
    claimed_at TEXT NOT NULL,
    released_at TEXT,
    FOREIGN KEY(run_id) REFERENCES runs(run_id)
  )`,
  `CREATE TABLE IF NOT EXISTS run_attempts (
    attempt_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    error TEXT,
    FOREIGN KEY(run_id) REFERENCES runs(run_id)
  )`,
  `CREATE TABLE IF NOT EXISTS runner_sessions (
    session_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    attempt_id TEXT,
    runner_kind TEXT NOT NULL,
    thread_id TEXT,
    turn_id TEXT,
    pid TEXT,
    started_at TEXT NOT NULL,
    last_event_at TEXT,
    FOREIGN KEY(run_id) REFERENCES runs(run_id)
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT,
    attempt_id TEXT,
    issue_id TEXT,
    identifier TEXT,
    level TEXT NOT NULL,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(run_id) REFERENCES runs(run_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_run_id_id ON events(run_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_events_issue_id_id ON events(issue_id, id)`,
  `CREATE TABLE IF NOT EXISTS retry_queue (
    issue_id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    due_at_ms INTEGER NOT NULL,
    error TEXT,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS evidence_artifacts (
    artifact_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    issue_id TEXT,
    kind TEXT NOT NULL,
    uri TEXT NOT NULL,
    label TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(run_id) REFERENCES runs(run_id)
  )`,
  `CREATE TABLE IF NOT EXISTS token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    session_id TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(run_id) REFERENCES runs(run_id)
  )`,
  `CREATE TABLE IF NOT EXISTS control_actions (
    action_id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    issue_id TEXT,
    run_id TEXT,
    status TEXT NOT NULL,
    requested_by TEXT,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    handled_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_retry_queue_due_at ON retry_queue(due_at_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status)`,
  `CREATE INDEX IF NOT EXISTS idx_claims_run_id ON claims(run_id)`,
] as const;
