CREATE TABLE amazon_targets (
  target_id text NOT NULL,
  profile_id bigint NOT NULL REFERENCES amazon_profiles(profile_id),
  campaign_id text NOT NULL,
  ad_group_id text NOT NULL,
  state text NOT NULL,
  expression_type text,
  expression jsonb NOT NULL,
  resolved_asin text,
  bid numeric,
  raw jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (target_id, profile_id)
);
CREATE INDEX ix_targets_asin ON amazon_targets (profile_id, resolved_asin)
  WHERE resolved_asin IS NOT NULL;

CREATE TABLE amazon_keywords (
  keyword_id text NOT NULL,
  profile_id bigint NOT NULL REFERENCES amazon_profiles(profile_id),
  campaign_id text NOT NULL,
  ad_group_id text NOT NULL,
  keyword_text text NOT NULL,
  match_type text NOT NULL,
  state text NOT NULL,
  bid numeric,
  raw jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (keyword_id, profile_id)
);
CREATE INDEX ix_keywords_text ON amazon_keywords
  (profile_id, lower(keyword_text));
