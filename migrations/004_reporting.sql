CREATE TABLE amazon_report_requests (
 report_id text PRIMARY KEY,
 profile_id bigint NOT NULL REFERENCES amazon_profiles(profile_id),
 report_type text NOT NULL,
 start_date date NOT NULL,
 end_date date NOT NULL,
 status text NOT NULL,
 requested_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 url_expiry timestamptz,
 error text
);

CREATE TABLE amazon_campaign_daily (
 profile_id bigint NOT NULL REFERENCES amazon_profiles(profile_id),
 campaign_id text NOT NULL,
 date date NOT NULL,
 impressions bigint NOT NULL DEFAULT 0,
 clicks bigint NOT NULL DEFAULT 0,
 cost numeric NOT NULL DEFAULT 0,
 purchases_14d bigint NOT NULL DEFAULT 0,
 sales_14d numeric NOT NULL DEFAULT 0,
 raw jsonb NOT NULL,
 landed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (profile_id, campaign_id, date)
);
