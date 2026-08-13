-- The catalogue's dynamic half. Everything a static site cannot do — per-pack votes (the landing
-- page) and per-preset engagement (the app) — lives here, keyed by a salted-IP voter hash and
-- nothing else. Every table below is idempotent-by-key: the PRIMARY KEY is the dedupe, so a repeat
-- action is a no-op, not an inflation. Comments are the one exception (free text), gated separately
-- by Turnstile at the endpoint.

-- One row per (pack, voter). The primary key is what enforces one vote each; there is no
-- separate dedupe pass and no way to vote twice.
CREATE TABLE IF NOT EXISTS votes (
  pack_id    TEXT    NOT NULL,
  voter      TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (pack_id, voter)
);
CREATE INDEX IF NOT EXISTS votes_by_pack ON votes (pack_id);

-- INSTALLS — adoption. One per (preset, voter): counting how many distinct people added it.
CREATE TABLE IF NOT EXISTS installs (
  preset_id  TEXT    NOT NULL,
  voter      TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (preset_id, voter)
);
CREATE INDEX IF NOT EXISTS installs_by_preset ON installs (preset_id);

-- RATINGS — quality. One upsertable star (1..5) per (preset, voter); the average drives "Top".
CREATE TABLE IF NOT EXISTS ratings (
  preset_id  TEXT    NOT NULL,
  voter      TEXT    NOT NULL,
  stars      INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (preset_id, voter)
);
CREATE INDEX IF NOT EXISTS ratings_by_preset ON ratings (preset_id);

-- HEARTS — affinity ("Favorite"). A one-per-(preset, voter) toggle: INSERT to set, DELETE to clear.
CREATE TABLE IF NOT EXISTS hearts (
  preset_id  TEXT    NOT NULL,
  voter      TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (preset_id, voter)
);
CREATE INDEX IF NOT EXISTS hearts_by_preset ON hearts (preset_id);

-- COMMENTS — depth-1 threaded. A reply stores the TOP-LEVEL comment's id in parent_id (deeper
-- replies flatten to it, keeping reply_to_name for "@who" context). helpful_count and reply_count
-- are denormalised and updated atomically. voter is the author's salted-IP hash, for self-delete
-- and rate-limiting. status soft-hides without deleting (moderation + tombstones).
CREATE TABLE IF NOT EXISTS comments (
  id            TEXT    PRIMARY KEY,
  preset_id     TEXT    NOT NULL,
  parent_id     TEXT,                          -- NULL for a top-level comment
  author        TEXT,                          -- display name, or NULL for anonymous
  body          TEXT    NOT NULL,
  rating        INTEGER,                        -- 1..5 when the comment is also a review
  reply_to_name TEXT,                          -- "@name" a flattened deep reply was answering
  status        TEXT    NOT NULL DEFAULT 'visible',  -- visible | hidden | removed
  helpful_count INTEGER NOT NULL DEFAULT 0,
  reply_count   INTEGER NOT NULL DEFAULT 0,
  voter         TEXT    NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_by_preset ON comments (preset_id, created_at);
CREATE INDEX IF NOT EXISTS comments_by_parent  ON comments (parent_id);

-- COMMENT_HELPFUL — a one-per-(comment, voter) "Helpful" toggle, same idempotent pattern as hearts.
CREATE TABLE IF NOT EXISTS comment_helpful (
  comment_id TEXT    NOT NULL,
  voter      TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (comment_id, voter)
);

-- FEEDBACK — a log of in-app bug reports / ideas, for rate-limiting and a record beside the GitHub
-- issue each one opens. The report body itself lives in the issue, not here.
CREATE TABLE IF NOT EXISTS feedback (
  id         TEXT    PRIMARY KEY,
  voter      TEXT    NOT NULL,
  kind       TEXT    NOT NULL,   -- bug | idea
  issue      INTEGER,             -- the GitHub issue number, once filed
  email      TEXT,                -- reporter's contact, kept PRIVATE here (never in the public issue)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS feedback_by_voter ON feedback (voter, created_at);
