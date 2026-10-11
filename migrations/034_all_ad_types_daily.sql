CREATE TABLE amazon_campaign_daily_other (
  profile_id bigint NOT NULL REFERENCES amazon_profiles(profile_id),
  ad_product text NOT NULL CHECK (ad_product IN ('SB','SD')),
  campaign_id text NOT NULL,
  date date NOT NULL,
  impressions bigint NOT NULL DEFAULT 0,
  clicks bigint NOT NULL DEFAULT 0,
  cost numeric NOT NULL DEFAULT 0,
  purchases bigint NOT NULL DEFAULT 0,
  sales numeric NOT NULL DEFAULT 0,
  raw jsonb NOT NULL,
  landed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, ad_product, campaign_id, date)
);

-- 029 already introduced source; retain all historical values and normalize
-- the legacy export label instead of attempting to add the column twice.
ALTER TABLE console_history ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'console_export';
ALTER TABLE console_history ALTER COLUMN source SET DEFAULT 'console_export';
UPDATE console_history SET source='console_export' WHERE source='console-monthly-export';
