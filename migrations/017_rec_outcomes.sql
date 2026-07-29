CREATE TABLE rec_outcomes (
  rec_id      bigint      NOT NULL REFERENCES recommendations(id),
  horizon     text        NOT NULL CHECK (horizon IN ('t7','t14','t30')),
  captured_at timestamptz NOT NULL DEFAULT now(),
  metrics     jsonb       NOT NULL,
  PRIMARY KEY (rec_id, horizon));
