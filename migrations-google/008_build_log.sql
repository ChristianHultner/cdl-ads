CREATE TABLE google_build_log (
  id bigserial PRIMARY KEY,
  started_at timestamptz DEFAULT now(),
  finished_at timestamptz,
  mode text CHECK (mode IN ('DRY_RUN', 'EXECUTE')),
  spec_file text,
  campaign text,
  ok boolean,
  operations int,
  campaign_resource text,
  report jsonb,
  lines jsonb,
  error text
);
