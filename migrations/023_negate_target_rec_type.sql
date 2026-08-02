-- Admit NEGATE_TARGET: engine now generates it for ASIN-shaped negations
-- (first learned lesson from t7 grades — keyword negation cannot block
-- product-targeting traffic). Push road existed prior; generation is new.
ALTER TABLE recommendations DROP CONSTRAINT IF EXISTS recommendations_rec_type_check;
ALTER TABLE recommendations ADD CONSTRAINT recommendations_rec_type_check CHECK (rec_type = ANY (ARRAY['NEGATE_TERM'::text, 'PROMOTE_TERM'::text, 'PROMOTE_ASIN'::text, 'BID_ADJUST'::text, 'CREATE_STRUCTURE'::text, 'CREATIVE_KEYWORD'::text, 'CREATIVE_TARGET'::text, 'BUDGET_ADJUST'::text, 'PAUSE_CAMPAIGN'::text, 'REPLACE_PRODUCT_AD'::text, 'NEGATE_TARGET'::text]));
