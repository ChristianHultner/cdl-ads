-- 011_terminal_statuses.sql
-- Extends the recommendations.status CHECK to add terminal statuses SKIPPED and HELD.
-- Existing values preserved verbatim: 'DRAFT','APPROVED','REJECTED','PUSHED'

ALTER TABLE recommendations
  DROP CONSTRAINT IF EXISTS recommendations_status_check;

ALTER TABLE recommendations
  ADD CONSTRAINT recommendations_status_check
  CHECK (status IN ('DRAFT','APPROVED','REJECTED','PUSHED','SKIPPED','HELD'));
