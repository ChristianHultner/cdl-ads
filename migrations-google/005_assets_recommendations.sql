CREATE TABLE IF NOT EXISTS google_asset_daily (
  customer_id   text             NOT NULL REFERENCES google_accounts(customer_id),
  date          date             NOT NULL,
  campaign_id   bigint           NOT NULL,
  ad_group_id   bigint           NOT NULL,
  asset_id      bigint           NOT NULL,
  field_type    text             NOT NULL, -- HEADLINE / DESCRIPTION / ...
  asset_text    text,                      -- null for non-text assets
  impressions   bigint           NOT NULL DEFAULT 0,
  clicks        bigint           NOT NULL DEFAULT 0,
  cost_micros   bigint           NOT NULL DEFAULT 0,
  conversions   double precision NOT NULL DEFAULT 0,
  first_synced_at timestamptz    NOT NULL DEFAULT now(),
  last_synced_at  timestamptz,
  PRIMARY KEY (customer_id, date, ad_group_id, asset_id, field_type)
);
CREATE INDEX IF NOT EXISTS idx_gad_date ON google_asset_daily (date);

CREATE TABLE IF NOT EXISTS google_recommendation_snapshots (
  id            bigserial   PRIMARY KEY,
  snapshot_at   timestamptz NOT NULL DEFAULT now(),
  customer_id   text        NOT NULL REFERENCES google_accounts(customer_id),
  resource_name text        NOT NULL,
  type          text        NOT NULL,
  campaign_id   bigint,
  dismissed     boolean,
  raw           jsonb       NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_grs_at ON google_recommendation_snapshots (snapshot_at);
-- header: D9 — Google recommendations are EVIDENCE ONLY, pulled
-- read-only, never applied via API. Snapshot semantics: each run
-- INSERTS a full new set (point-in-time), no upsert.
