PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  current_stage TEXT NOT NULL DEFAULT 'define',
  auto_run INTEGER NOT NULL DEFAULT 1,
  auto_approve INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_config (
  project_id TEXT PRIMARY KEY,
  research_question TEXT,
  design_json TEXT NOT NULL DEFAULT '{}',
  constraints_json TEXT NOT NULL DEFAULT '{}',
  benchmark_json TEXT NOT NULL DEFAULT '{}',
  validation_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS data_sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'json',
  url TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'GET',
  headers_json TEXT NOT NULL DEFAULT '{}',
  mapping_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  cadence_minutes INTEGER NOT NULL DEFAULT 60,
  last_fetched_at TEXT,
  last_status TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS raw_observations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source_id TEXT,
  observed_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  key TEXT NOT NULL,
  value_num REAL,
  value_text TEXT,
  payload_json TEXT,
  quality_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(source_id) REFERENCES data_sources(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_project_key_time ON raw_observations(project_id, key, observed_at);

CREATE TABLE IF NOT EXISTS definitions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  content_json TEXT NOT NULL,
  gate_json TEXT NOT NULL,
  ai_note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, version),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS measurements (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  measured_at TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  source_window_json TEXT NOT NULL,
  quality_json TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS design_candidates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  sigma REAL NOT NULL,
  tau REAL NOT NULL,
  alpha REAL NOT NULL,
  authority_k INTEGER NOT NULL,
  delay_d REAL NOT NULL,
  recovery_w REAL NOT NULL,
  adjust_m REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_candidates_project_status ON design_candidates(project_id, status);

CREATE TABLE IF NOT EXISTS simulation_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  research_cycle INTEGER NOT NULL DEFAULT 1,
  phase TEXT NOT NULL,
  seed INTEGER NOT NULL,
  n INTEGER NOT NULL,
  loss_mean REAL,
  loss_exceed_rate REAL,
  fp_rate REAL,
  fn_rate REAL,
  review_burden REAL,
  recovery_time REAL,
  regret REAL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(candidate_id) REFERENCES design_candidates(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_runs_candidate_phase ON simulation_runs(candidate_id, phase);

CREATE TABLE IF NOT EXISTS validations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  candidate_id TEXT,
  validation_type TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(candidate_id) REFERENCES design_candidates(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reviewer_observations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  participant_hash TEXT NOT NULL,
  ai_confidence REAL NOT NULL,
  ai_correct INTEGER NOT NULL,
  human_accept INTEGER NOT NULL,
  response_ms INTEGER NOT NULL,
  recovered INTEGER NOT NULL DEFAULT 0,
  recovery_ms INTEGER,
  context_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reviewer_models (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  model_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, version),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  candidate_id TEXT,
  decision TEXT NOT NULL,
  evidence_level TEXT NOT NULL,
  basis_json TEXT NOT NULL,
  automatic INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(candidate_id) REFERENCES design_candidates(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  priority INTEGER NOT NULL DEFAULT 100,
  payload_json TEXT NOT NULL DEFAULT '{}',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  run_after TEXT NOT NULL,
  locked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs(status, run_after, priority);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  content_markdown TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
