CREATE TABLE engine_parameters (
 key text NOT NULL,
 scope text NOT NULL DEFAULT 'GLOBAL',
 value numeric NOT NULL,
 description text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (key, scope)
);

INSERT INTO engine_parameters (key, scope, value, description) VALUES
 ('target_acos','GLOBAL',0.30,'ACOS ceiling; spend above this gets flagged'),
 ('negate_min_spend','GLOBAL',5,'min spend (profile currency) before negation eligible'),
 ('negate_min_clicks','GLOBAL',20,'min clicks with zero orders before negation eligible'),
 ('negate_window_days','GLOBAL',60,'trailing evaluation window for negation'),
 ('negate_attribution_buffer_days','GLOBAL',14,'exclude most recent N days (attribution lag)'),
 ('harvest_min_orders','GLOBAL',2,'min orders for query -> exact-match promotion'),
 ('promote_asin_min_orders','GLOBAL',3,'min orders for ASIN -> explicit product target');

CREATE TABLE recommendations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 rec_type text NOT NULL CHECK (rec_type IN
 ('NEGATE_TERM','PROMOTE_TERM','PROMOTE_ASIN','BID_ADJUST')),
 profile_id bigint NOT NULL REFERENCES amazon_profiles(profile_id),
 campaign_id text,
 target_text text NOT NULL,
 proposal text NOT NULL,
 evidence jsonb NOT NULL,
 status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN
 ('DRAFT','APPROVED','REJECTED','PUSHED')),
 created_at timestamptz NOT NULL DEFAULT now(),
 ruled_at timestamptz,
 pushed_at timestamptz
);

CREATE TABLE amazon_search_term_daily (
 profile_id bigint NOT NULL REFERENCES amazon_profiles(profile_id),
 campaign_id text NOT NULL,
 ad_group_id text NOT NULL,
 keyword_id text NOT NULL DEFAULT '-',
 search_term text NOT NULL,
 match_type text,
 date date NOT NULL,
 impressions bigint NOT NULL DEFAULT 0,
 clicks bigint NOT NULL DEFAULT 0,
 cost numeric NOT NULL DEFAULT 0,
 purchases_14d bigint NOT NULL DEFAULT 0,
 sales_14d numeric NOT NULL DEFAULT 0,
 raw jsonb NOT NULL,
 landed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (profile_id, campaign_id, ad_group_id, keyword_id,
 search_term, date)
);
