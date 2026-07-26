ALTER TABLE recommendations
DROP CONSTRAINT recommendations_rec_type_check;
ALTER TABLE recommendations
ADD CONSTRAINT recommendations_rec_type_check
CHECK (rec_type IN ('NEGATE_TERM', 'PROMOTE_TERM', 'PROMOTE_ASIN', 'BID_ADJUST', 'CREATE_STRUCTURE'));
