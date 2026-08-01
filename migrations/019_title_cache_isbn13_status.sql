-- 019_title_cache_isbn13_status.sql
-- Adds isbn13 (the EAN-13 actually sent to cdl-books API) and status
-- (fine-grained cache disposition) to title_cache.
--
-- status values:
--   'found'               – API returned found:true
--   'not_in_catalog'      – ISBN-10 converted correctly; API returned found:false (real miss)
--   'no_isbn_bridge'      – B0-shaped Kindle ASIN; cannot convert to ISBN-13; never queried
--   'unrecognized_shape'  – ASIN matched neither ISBN-10 nor B0 pattern
--
ALTER TABLE title_cache
  ADD COLUMN IF NOT EXISTS isbn13 text,
  ADD COLUMN IF NOT EXISTS status text;
