-- Anonymous social system: publication history, posts, votes, post media.

-- Every result actually accepted into the shared leaderboard, kept even after
-- the current best-score row is replaced.
CREATE TABLE leaderboard_publications (
  result_id TEXT PRIMARY KEY REFERENCES scan_results(id),
  player_id TEXT NOT NULL REFERENCES players(id),
  display_name_snapshot TEXT,
  first_published_at INTEGER NOT NULL
);
CREATE INDEX leaderboard_publications_player ON leaderboard_publications(player_id, first_published_at DESC);

-- Backfill from currently referenced shared entries.
INSERT OR IGNORE INTO leaderboard_publications (result_id, player_id, display_name_snapshot, first_published_at)
  SELECT result_id, player_id, display_name, published_at FROM leaderboard_entries;

CREATE TABLE social_media (
  id TEXT PRIMARY KEY,
  owner_player_id TEXT NOT NULL REFERENCES players(id),
  relative_path TEXT NOT NULL,
  mime TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  created_at INTEGER NOT NULL,
  attached_post_id TEXT REFERENCES social_posts(id),
  delete_after INTEGER
);
CREATE INDEX social_media_cleanup ON social_media(delete_after);

-- Public snapshot columns are nullable only so a deleted post can become a
-- minimal tombstone; the CHECK requires them on every active post.
CREATE TABLE social_posts (
  feed_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  owner_player_id TEXT NOT NULL REFERENCES players(id),
  source_result_id TEXT NOT NULL UNIQUE REFERENCES scan_results(id),
  author_label TEXT,
  scan_score INTEGER CHECK (scan_score IS NULL OR scan_score BETWEEN 0 AND 100),
  tier TEXT,
  model_version TEXT,
  display_map_version TEXT,
  capture_mode TEXT,
  result_created_at INTEGER,
  caption TEXT,
  media_id TEXT REFERENCES social_media(id),
  up_count INTEGER NOT NULL DEFAULT 0 CHECK (up_count >= 0),
  down_count INTEGER NOT NULL DEFAULT 0 CHECK (down_count >= 0),
  mog_score INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  CHECK (mog_score = up_count - down_count),
  CHECK (deleted_at IS NOT NULL OR (
    author_label IS NOT NULL AND scan_score IS NOT NULL AND tier IS NOT NULL AND model_version IS NOT NULL
    AND display_map_version IS NOT NULL AND capture_mode IS NOT NULL AND result_created_at IS NOT NULL
  ))
);
CREATE INDEX social_posts_active_feed ON social_posts(feed_seq DESC) WHERE deleted_at IS NULL;
CREATE INDEX social_posts_owner ON social_posts(owner_player_id, feed_seq DESC) WHERE deleted_at IS NULL;

-- A removed vote stays as value 0 so its revision can reject stale writes.
CREATE TABLE social_votes (
  post_id TEXT NOT NULL REFERENCES social_posts(id),
  player_id TEXT NOT NULL REFERENCES players(id),
  value INTEGER NOT NULL CHECK (value IN (-1, 0, 1)),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, player_id)
);
CREATE INDEX social_votes_player ON social_votes(player_id, value, updated_at DESC, post_id);
CREATE INDEX social_votes_post ON social_votes(post_id, value);
