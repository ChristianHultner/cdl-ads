-- Vercel cron log; independent of the Google lane and the launchd scripts.
CREATE TABLE amazon_sync_log (
  id bigserial PRIMARY KEY,
  run_started_at timestamptz NOT NULL DEFAULT now(),
  run_finished_at timestamptz,
  step text NOT NULL,
  ok boolean,
  rows_reported int,
  detail text
);
