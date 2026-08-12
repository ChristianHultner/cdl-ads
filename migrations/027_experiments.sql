CREATE TABLE experiments (
  id               serial      PRIMARY KEY,
  name             text        NOT NULL,
  hypothesis       text        NOT NULL,
  market           text        NOT NULL,
  structure_ref    jsonb,
  budget_daily     numeric,
  started_at       timestamptz,
  horizon_days     int         NOT NULL DEFAULT 30,
  success_criteria text        NOT NULL,
  kill_criteria    text        NOT NULL,
  status           text        NOT NULL DEFAULT 'PROPOSED'
                   CHECK (status IN ('PROPOSED','LIVE','SCALED','HELD','KILLED')),
  verdict_note     text,
  created_at       timestamptz DEFAULT now()
);
