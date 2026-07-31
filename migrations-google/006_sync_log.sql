CREATE TABLE IF NOT EXISTS google_sync_log (
  id              bigserial   PRIMARY KEY,
  run_started_at  timestamptz NOT NULL,
  run_finished_at timestamptz,
  step            text        NOT NULL,
  ok              boolean,
  detail          text,
  rows_reported   bigint
);
CREATE INDEX IF NOT EXISTS idx_gsl_started ON google_sync_log (run_started_at);
