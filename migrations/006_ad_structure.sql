CREATE TABLE amazon_ad_groups (
 ad_group_id text NOT NULL,
 profile_id bigint NOT NULL REFERENCES amazon_profiles(profile_id),
 campaign_id text NOT NULL,
 name text NOT NULL,
 state text NOT NULL,
 default_bid numeric,
 raw jsonb NOT NULL,
 synced_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (ad_group_id, profile_id)
);

CREATE TABLE amazon_product_ads (
 ad_id text NOT NULL,
 profile_id bigint NOT NULL REFERENCES amazon_profiles(profile_id),
 campaign_id text NOT NULL,
 ad_group_id text NOT NULL,
 asin text,
 sku text,
 state text NOT NULL,
 raw jsonb NOT NULL,
 synced_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (ad_id, profile_id)
);
