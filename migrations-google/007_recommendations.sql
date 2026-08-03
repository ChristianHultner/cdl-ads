-- engine INSERTs DRAFT only; state transitions happen in UI/push layer.
CREATE TABLE IF NOT EXISTS google_recommendations (
  id               bigserial       PRIMARY KEY,
  created_at       timestamptz     NOT NULL DEFAULT now(),
  updated_at       timestamptz     NOT NULL DEFAULT now(),

  -- entity
  customer_id      text            NOT NULL REFERENCES google_accounts(customer_id),
  entity_type      text            NOT NULL
                   CHECK (entity_type IN ('campaign', 'ad_group', 'account')),
  entity_id        text            NOT NULL,   -- campaign_id / ad_group_id / customer_id as text

  -- recommendation
  rec_type         text            NOT NULL,   -- e.g. 'TARGET_CPA' | 'BUDGET' | 'BID_MODIFIER'
  direction        text            NOT NULL
                   CHECK (direction IN ('RAISE', 'LOWER', 'HOLD')),
  state            text            NOT NULL DEFAULT 'DRAFT'
                   CHECK (state IN ('DRAFT', 'OPEN', 'APPLIED', 'DISMISSED', 'REJECTED')),

  -- engine signal
  four_state       text            NOT NULL
                   CHECK (four_state IN ('ACT', 'WATCH', 'NEUTRAL', 'INSUFFICIENT')),
  confidence       numeric(7,6)    NOT NULL
                   CHECK (confidence >= 0 AND confidence <= 1),
  point_estimate   numeric(12,9)   NOT NULL
                   CHECK (point_estimate >= 0),

  -- monetary values (EUR)
  current_value    numeric(14,6)   NOT NULL,
  proposed_value   numeric(14,6)   NOT NULL,

  -- posterior parameters (audit / reproducibility)
  n_clicks         integer         NOT NULL CHECK (n_clicks >= 0),
  n_conversions    integer         NOT NULL CHECK (n_conversions >= 0),
  alpha_param      numeric(14,6)   NOT NULL CHECK (alpha_param > 0),
  beta_param       numeric(14,6)   NOT NULL CHECK (beta_param > 0),

  -- optional
  note             text,
  expires_at       timestamptz,
  raw              jsonb
);

CREATE INDEX IF NOT EXISTS idx_grec_customer_entity
  ON google_recommendations (customer_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_grec_state_created
  ON google_recommendations (state, created_at);

-- One open recommendation per entity (customer + entity_type + entity_id).
CREATE UNIQUE INDEX IF NOT EXISTS uq_grec_open
  ON google_recommendations (customer_id, entity_type, entity_id)
  WHERE state = 'OPEN';
