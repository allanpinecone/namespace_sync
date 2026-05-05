-- Pinecone Vector Migrator schema

CREATE TABLE IF NOT EXISTS connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label TEXT NOT NULL,
  -- libsodium secretbox: nonce || ciphertext, both base64-encoded
  api_key_ciphertext TEXT NOT NULL,
  api_key_fingerprint TEXT NOT NULL,
  ephemeral BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS connections_fingerprint_idx ON connections(api_key_fingerprint);

CREATE TABLE IF NOT EXISTS namespace_cache (
  connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  index_name TEXT NOT NULL,
  namespaces JSONB NOT NULL,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, index_name)
);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('copy', 'sync')),
  status TEXT NOT NULL DEFAULT 'pending',
  source_connection_id UUID NOT NULL REFERENCES connections(id),
  target_connection_id UUID NOT NULL REFERENCES connections(id),
  source_index TEXT NOT NULL,
  target_index TEXT NOT NULL,
  namespaces TEXT[] NOT NULL,
  mapping JSONB NOT NULL,
  concurrency JSONB NOT NULL,
  metadata_filter JSONB,
  dry_run BOOLEAN NOT NULL DEFAULT FALSE,
  -- Sync-specific config; null for copy jobs
  poll_interval_ms INTEGER,
  tombstone_guard JSONB,
  version_field JSONB,
  -- Tracking
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error TEXT
);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status);
CREATE INDEX IF NOT EXISTS jobs_kind_idx ON jobs(kind);
CREATE INDEX IF NOT EXISTS jobs_created_at_idx ON jobs(created_at DESC);

CREATE TABLE IF NOT EXISTS namespace_progress (
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL,
  target_namespace TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  total_records BIGINT NOT NULL DEFAULT 0,
  processed_records BIGINT NOT NULL DEFAULT 0,
  copied_records BIGINT NOT NULL DEFAULT 0,
  failed_records BIGINT NOT NULL DEFAULT 0,
  pagination_token TEXT,
  ru_consumed BIGINT NOT NULL DEFAULT 0,
  wu_consumed BIGINT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, namespace)
);

CREATE TABLE IF NOT EXISTS sync_state (
  job_id UUID PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  last_poll_at TIMESTAMPTZ,
  last_poll_duration_ms INTEGER,
  poll_passes BIGINT NOT NULL DEFAULT 0,
  inserts_applied BIGINT NOT NULL DEFAULT 0,
  deletes_applied BIGINT NOT NULL DEFAULT 0,
  updates_applied BIGINT NOT NULL DEFAULT 0,
  pending_ops BIGINT NOT NULL DEFAULT 0,
  awaiting_delete_confirmation BOOLEAN NOT NULL DEFAULT FALSE,
  pending_delete_count BIGINT NOT NULL DEFAULT 0,
  paused BOOLEAN NOT NULL DEFAULT FALSE,
  cutover_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS verification_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL,
  sample_size INTEGER NOT NULL,
  matched INTEGER NOT NULL DEFAULT 0,
  mismatched INTEGER NOT NULL DEFAULT 0,
  missing INTEGER NOT NULL DEFAULT 0,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verification_runs_job_idx ON verification_runs(job_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID REFERENCES jobs(id) ON DELETE CASCADE,
  actor TEXT,
  event_type TEXT NOT NULL,
  message TEXT,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_job_idx ON audit_log(job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_event_idx ON audit_log(event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS saved_selections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  index_name TEXT NOT NULL,
  name TEXT NOT NULL,
  namespaces TEXT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, index_name, name)
);

-- ─── Idempotent migrations ────────────────────────────────────────────────────
-- These run after the CREATE TABLE statements so existing databases pick up
-- new columns without dropping data. New deployments execute them as no-ops.

-- "Skip already-present" copy mode (jobs.copy_options.skipExisting = 'never' | 'id' | 'hash').
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS copy_options JSONB;

-- Tracks records the worker skipped because the target already had them
-- (only populated when copy_options.skipExisting != 'never').
ALTER TABLE namespace_progress
  ADD COLUMN IF NOT EXISTS skipped_records BIGINT NOT NULL DEFAULT 0;
