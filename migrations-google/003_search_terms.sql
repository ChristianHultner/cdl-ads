-- no FK on campaign_id/ad_group_id — historical terms may reference
-- structure not present; FLAG via joins, never block ingestion.

CREATE TABLE IF NOT EXISTS google_search_term_daily (
  customer_id          text             NOT NULL REFERENCES google_accounts(customer_id),
  date                 date             NOT NULL,
  campaign_id          bigint           NOT NULL,
  ad_group_id          bigint           NOT NULL,
  search_term          text             NOT NULL,
  match_type           text,
  impressions          bigint           NOT NULL DEFAULT 0,
  clicks               bigint           NOT NULL DEFAULT 0,
  cost_micros          bigint           NOT NULL DEFAULT 0,
  conversions          double precision NOT NULL DEFAULT 0,
  conversions_value    double precision NOT NULL DEFAULT 0,
  first_synced_at      timestamptz      NOT NULL DEFAULT now(),
  last_synced_at       timestamptz,
  PRIMARY KEY (customer_id, date, campaign_id, ad_group_id, search_term)
);

CREATE INDEX IF NOT EXISTS idx_gstd_term ON google_search_term_daily (search_term);
CREATE INDEX IF NOT EXISTS idx_gstd_date ON google_search_term_daily (date);
