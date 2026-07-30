-- keying decision — all tables keyed on Google
-- customer_id (string, no dashes); sole target account
-- 2199803274; MCC 4712198242 is credential path only.
CREATE TABLE IF NOT EXISTS google_migrations (
  id serial PRIMARY KEY,
  filename text UNIQUE NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS google_accounts (
  customer_id text PRIMARY KEY,
  descriptive_name text,
  currency_code text,
  time_zone text,
  is_manager boolean NOT NULL DEFAULT false,
  first_synced_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz
);
CREATE TABLE IF NOT EXISTS google_campaigns (
  campaign_id bigint PRIMARY KEY,
  customer_id text NOT NULL REFERENCES google_accounts(customer_id),
  name text NOT NULL,
  status text NOT NULL,
  advertising_channel_type text NOT NULL,
  bidding_strategy_type text,
  budget_micros bigint,
  start_date date,
  end_date date,
  first_synced_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz,
  raw jsonb
);
