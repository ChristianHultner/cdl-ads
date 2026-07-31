CREATE TABLE watchdog_status (
  id         int         PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  checked_at timestamptz NOT NULL,
  verdict    text        NOT NULL,
  details    jsonb       NOT NULL DEFAULT '[]'
);
