-- One row per (pack, voter). The primary key is what enforces one vote each; there is no
-- separate dedupe pass and no way to vote twice.
CREATE TABLE IF NOT EXISTS votes (
  pack_id    TEXT    NOT NULL,
  voter      TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (pack_id, voter)
);
CREATE INDEX IF NOT EXISTS votes_by_pack ON votes (pack_id);
