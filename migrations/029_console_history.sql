-- display-only truth layer, never joined to daily_rollup, never read by rules
CREATE TABLE console_history (
  market       text        NOT NULL,
  currency     text        NOT NULL,
  year         int         NOT NULL,
  month        int         NOT NULL,
  spend        numeric     NOT NULL,
  sales        numeric     NOT NULL,
  orders       bigint      NOT NULL,
  units        bigint      NOT NULL,
  source       text        NOT NULL DEFAULT 'console-monthly-export',
  imported_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (market, year, month)
);
