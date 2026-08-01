CREATE TABLE b0_hc_candidates (
  b0_asin      text PRIMARY KEY,
  amazon_title text,
  hc_isbn13    text,
  hc_title     text,
  confidence   numeric,
  method       text,
  matched_via  text,
  status       text NOT NULL DEFAULT 'PROPOSED'
                 CHECK (status IN ('PROPOSED','CONFIRMED','REJECTED','NO_MATCH')),
  decided_at   timestamptz,
  created_at   timestamptz DEFAULT now()
);
