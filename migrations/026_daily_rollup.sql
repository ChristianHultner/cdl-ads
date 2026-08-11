CREATE TABLE daily_rollup (
  profile_id  bigint  NOT NULL,
  date        date    NOT NULL,
  currency    text    NOT NULL,
  spend       numeric NOT NULL DEFAULT 0,
  sales       numeric NOT NULL DEFAULT 0,
  orders      int     NOT NULL DEFAULT 0,
  clicks      int     NOT NULL DEFAULT 0,
  impressions bigint  NOT NULL DEFAULT 0,
  acos        numeric,
  computed_at timestamptz DEFAULT now(),
  PRIMARY KEY (profile_id, date)
);
