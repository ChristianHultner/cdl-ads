-- 015_rec_type_budget.sql
-- Extend recommendations rec_type CHECK to include BUDGET_ADJUST and PAUSE_CAMPAIGN.
-- Drop + recreate is the standard PG approach for CHECK constraint changes.

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
      'PAUSE_CAMPAIGN'::text
    ]));
