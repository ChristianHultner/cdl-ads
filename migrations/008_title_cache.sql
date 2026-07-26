CREATE TABLE title_cache (
 asin text PRIMARY KEY,
 title text,
 cover_url text,
 found boolean NOT NULL DEFAULT false,
 source text NOT NULL DEFAULT 'cdl-books',
 fetched_at timestamptz NOT NULL DEFAULT now()
);
