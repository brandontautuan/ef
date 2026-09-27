-- Comments on mogs, each with its own Up Mog / Down Mog counter.

-- Denormalized active-comment count shown on post cards.
ALTER TABLE social_posts ADD COLUMN comment_count INTEGER NOT NULL DEFAULT 0 CHECK (comment_count >= 0);

-- The body and author snapshot are nullable only so a deleted comment can
-- become a minimal tombstone (keeps idempotent retries and ownership checks).
CREATE TABLE social_comments (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  post_id TEXT NOT NULL REFERENCES social_posts(id),
  author_player_id TEXT NOT NULL REFERENCES players(id),
  author_label TEXT,
  body TEXT,
  up_count INTEGER NOT NULL DEFAULT 0 CHECK (up_count >= 0),
  down_count INTEGER NOT NULL DEFAULT 0 CHECK (down_count >= 0),
  mog_score INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  CHECK (mog_score = up_count - down_count),
  CHECK (deleted_at IS NOT NULL OR (author_label IS NOT NULL AND body IS NOT NULL))
);
CREATE INDEX social_comments_post ON social_comments(post_id, seq) WHERE deleted_at IS NULL;
CREATE INDEX social_comments_author ON social_comments(author_player_id, created_at);

-- Same desired-state model as post votes: a removed vote stays as value 0.
CREATE TABLE social_comment_votes (
  comment_id TEXT NOT NULL REFERENCES social_comments(id),
  player_id TEXT NOT NULL REFERENCES players(id),
  value INTEGER NOT NULL CHECK (value IN (-1, 0, 1)),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (comment_id, player_id)
);
CREATE INDEX social_comment_votes_player ON social_comment_votes(player_id, comment_id);
CREATE INDEX social_comment_votes_comment ON social_comment_votes(comment_id, value);
