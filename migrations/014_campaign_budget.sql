-- 014_campaign_budget.sql
-- Surface campaign budget fields synced from Amazon Ads v3 API raw response.
-- raw->'budget' shape: {"budget": <number>, "budgetType": "DAILY"}

ALTER TABLE amazon_campaigns
  ADD COLUMN IF NOT EXISTS budget_amount numeric,
  ADD COLUMN IF NOT EXISTS budget_type text;
