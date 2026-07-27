-- 013_creative_target_rec_type.sql
-- Extend recommendations rec_type CHECK to include CREATIVE_TARGET
-- Existing values preserved verbatim:
--   NEGATE_TERM, PROMOTE_TERM, PROMOTE_ASIN, BID_ADJUST, CREATE_STRUCTURE, CREATIVE_KEYWORD

ALTER TABLE recommendations
  DROP CONSTRAINT recommendations_rec_type_check;

ALTER TABLE recommendations
  ADD CONSTRAINT recommendations_rec_type_check
  CHECK (rec_type = ANY (ARRAY[
    'NEGATE_TERM'::text,
    'PROMOTE_TERM'::text,
    'PROMOTE_ASIN'::text,
    'BID_ADJUST'::text,
    'CREATE_STRUCTURE'::text,
    'CREATIVE_KEYWORD'::text,
    'CREATIVE_TARGET'::text
  ]));
