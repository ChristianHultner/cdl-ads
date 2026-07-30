-- 004_campaign_daily.sql
-- campaign-day grain, ALL campaign types. IS family
-- nullable: Google reports it only for Search/Shopping; NULL
-- means not-reported, never zero. IS values are Google-modelled
-- estimates: recommendation triggers only, banned from
-- arithmetic (plan §5.6).

CREATE TABLE IF NOT EXISTS google_campaign_daily (
  customer_id                         text             NOT NULL REFERENCES google_accounts(customer_id),
  date                                date             NOT NULL,
  campaign_id                         bigint           NOT NULL,
  impressions                         bigint           NOT NULL DEFAULT 0,
  clicks                              bigint           NOT NULL DEFAULT 0,
  cost_micros                         bigint           NOT NULL DEFAULT 0,
  conversions                         double precision NOT NULL DEFAULT 0,
  conversions_value                   double precision NOT NULL DEFAULT 0,
  search_impression_share             double precision,
  search_budget_lost_impression_share double precision,
  search_rank_lost_impression_share   double precision,
  first_synced_at                     timestamptz      NOT NULL DEFAULT now(),
  last_synced_at                      timestamptz,
  PRIMARY KEY (customer_id, date, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_gcd_date     ON google_campaign_daily (date);
CREATE INDEX IF NOT EXISTS idx_gcd_campaign ON google_campaign_daily (campaign_id);
