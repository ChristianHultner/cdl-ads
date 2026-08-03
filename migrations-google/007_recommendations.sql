-- engine INSERTs DRAFT only; state transitions happen exclusively in UI / push layer. Evidence and action are jsonb: the card's substance travels with the row.
CREATE TABLE IF NOT EXISTS google_recommendations (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  run_id text NOT NULL,
  rec_type text NOT NULL CHECK (rec_type IN
    ('NEGATE_TERM','NEGATE_NGRAM','PROMOTE_TERM','BUDGET_RAISE',
     'RANK_INVESTIGATE','TARGET_ADJUST','ASSET_RETIRE','ASSET_ADD',
     'BID_STRATEGY_MIGRATE')),
  customer_id text NOT NULL REFERENCES google_accounts(customer_id),
  campaign_id bigint,
  ad_group_id bigint,
  entity_key text NOT NULL,
  state text NOT NULL DEFAULT 'DRAFT' CHECK (state IN
    ('DRAFT','APPROVED','REJECTED','PUSHED','SUPERSEDED','EXPIRED')),
  action jsonb NOT NULL,
  evidence jsonb NOT NULL,
  why_line text NOT NULL,
  decided_at timestamptz,
  decided_note text
);
CREATE INDEX IF NOT EXISTS idx_grec_state_created
  ON google_recommendations (state, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_grec_open ON google_recommendations
  (rec_type, customer_id, coalesce(campaign_id,0), coalesce(ad_group_id,0), entity_key)
  WHERE state IN ('DRAFT','APPROVED');
