-- 020_watchdog_alert_tracking.sql
-- bite 3: per-row columns for re-escalation logic.
--   last_alert_sent_at  — when the last WhatsApp alert was sent (any direction).
--   last_details        — details payload at time of last ALERT send; used to
--                         detect condition-c: new/changed problem while already red.
ALTER TABLE watchdog_status
  ADD COLUMN IF NOT EXISTS last_alert_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_details        jsonb;
