CREATE TABLE amazon_advertised_product_daily (
 profile_id text NOT NULL,
 ad_id text NOT NULL,
 ad_group_id text NOT NULL,
 campaign_id text NOT NULL,
 asin text,
 date date NOT NULL,
 impressions bigint, clicks bigint, cost numeric,
 purchases_14d bigint, sales_14d numeric,
 raw jsonb NOT NULL,
 landed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (profile_id, ad_id, date)
);
