CREATE TABLE IF NOT EXISTS google_ad_groups (
  ad_group_id   bigint PRIMARY KEY,
  campaign_id   bigint NOT NULL REFERENCES google_campaigns(campaign_id),
  customer_id   text   NOT NULL REFERENCES google_accounts(customer_id),
  name          text   NOT NULL,
  status        text   NOT NULL,
  type          text,
  first_synced_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at  timestamptz,
  raw           jsonb
);

CREATE TABLE IF NOT EXISTS google_keywords (
  ad_group_id      bigint  NOT NULL REFERENCES google_ad_groups(ad_group_id),
  criterion_id     bigint  NOT NULL,
  text             text    NOT NULL,
  match_type       text    NOT NULL,
  status           text    NOT NULL,
  negative         boolean NOT NULL DEFAULT false,
  cpc_bid_micros   bigint,
  first_synced_at  timestamptz NOT NULL DEFAULT now(),
  last_synced_at   timestamptz,
  raw              jsonb,
  PRIMARY KEY (ad_group_id, criterion_id)
);
