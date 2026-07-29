-- 016_bid_recommendations.sql
-- Cache Amazon's per-entity suggested bid + range from the SP bid-recommendation API.
-- Primary key (profile_id, entity_kind, entity_id); upsert on refetch.

CREATE TABLE IF NOT EXISTS amazon_bid_recommendations (
  profile_id   bigint      NOT NULL,
  entity_kind  text        NOT NULL,
  entity_id    text        NOT NULL,
  ad_group_id  text,
  suggested    numeric,
  range_start  numeric,
  range_end    numeric,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, entity_kind, entity_id),
  CONSTRAINT amazon_bid_recommendations_entity_kind_check
    CHECK (entity_kind = ANY (ARRAY['TARGET', 'KEYWORD', 'AUTO_STRATEGY']))
);
