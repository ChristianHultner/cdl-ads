-- Business ruling per profile, native currency.
-- NULL = revenue-based GP (labeled), never derive or convert.
ALTER TABLE amazon_profiles ADD COLUMN gp_per_order numeric NULL;
