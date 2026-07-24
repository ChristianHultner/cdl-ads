CREATE TABLE amazon_campaigns (
 campaign_id text NOT NULL,
 profile_id bigint NOT NULL REFERENCES amazon_profiles(profile_id),
 name text NOT NULL,
 state text NOT NULL,
 campaign_type text NOT NULL DEFAULT 'sponsoredProducts',
 targeting_type text,
 start_date text,
 end_date text,
 budget_amount numeric,
 budget_type text,
 raw jsonb NOT NULL,
 synced_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (campaign_id, profile_id)
);
