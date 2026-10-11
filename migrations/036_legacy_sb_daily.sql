ALTER TABLE amazon_campaign_daily_other DROP CONSTRAINT amazon_campaign_daily_other_ad_product_check;
ALTER TABLE amazon_campaign_daily_other ADD CONSTRAINT amazon_campaign_daily_other_ad_product_check
  CHECK (ad_product IN ('SB','SB_LEGACY','SD'));
-- The ruled v2 metric set does not collect impressions/clicks; unknown is not zero.
ALTER TABLE amazon_campaign_daily_other ALTER COLUMN impressions DROP NOT NULL;
ALTER TABLE amazon_campaign_daily_other ALTER COLUMN clicks DROP NOT NULL;
