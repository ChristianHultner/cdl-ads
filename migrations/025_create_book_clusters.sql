CREATE TABLE book_clusters (
  isbn13       text        PRIMARY KEY,
  work_title   text,
  language     text        NOT NULL,
  cluster_name text        NOT NULL,
  assigned_by  text        NOT NULL DEFAULT 'draft_v2',
  assigned_at  timestamptz          DEFAULT now()
);
