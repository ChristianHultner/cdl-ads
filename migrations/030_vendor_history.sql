-- Ruling: vendor sell-in becomes a second display-only truth layer beside console_history.
-- Source file ~/console-exports/vendor-history-ES.csv — 13 pre-aggregated monthly rows (header: market,currency,year,month,units,net_revenue,source), extracted from Amazon EU SARL vendor invoices, verified against printed invoice totals to the cent.
-- SELL-IN semantics: Amazon's replenishment purchasing, NOT customer sell-through — batched and lagged (Dec 2025 sell-out echoes into Jan 2026's 2,109 units).
-- Doctrine rules: never joined to daily_rollup, console_history, or any other table; never read by generation/grading/watchdog rules; monthly rows readable only at quarterly-or-coarser grain for trend judgments.
-- Anchors: 2025-12 = 4,968 units / 42,816.18 EUR; 2026-07 = 873 / 7,650.21.
CREATE TABLE vendor_history (
  market       text        NOT NULL,
  currency     text        NOT NULL,
  year         int         NOT NULL,
  month        int         NOT NULL,
  units        bigint      NOT NULL,
  net_revenue  numeric     NOT NULL,
  source       text        NOT NULL,
  imported_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (market, year, month)
);
