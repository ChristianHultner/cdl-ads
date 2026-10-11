ALTER TABLE experiments DROP CONSTRAINT experiments_status_check;
ALTER TABLE experiments ADD CONSTRAINT experiments_status_check
  CHECK (status IN ('PROPOSED','LIVE','SCALED','HELD','KILLED','RELEASED'));
