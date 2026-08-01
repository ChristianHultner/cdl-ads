-- 022_replace_product_ad_rec_type.sql
-- Extend recommendations rec_type CHECK to include REPLACE_PRODUCT_AD.
-- Existing values preserved verbatim (last set from 015):
--   NEGATE_TERM, PROMOTE_TERM, PROMOTE_ASIN, BID_ADJUST, CREATE_STRUCTURE,
--   CREATIVE_KEYWORD, CREATIVE_TARGET, BUDGET_ADJUST, PAUSE_CAMPAIGN

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
      'CREATIVE_TARGET'::text,
      'BUDGET_ADJUST'::text,
      'PAUSE_CAMPAIGN'::text,
      'REPLACE_PRODUCT_AD'::text
    ]));
