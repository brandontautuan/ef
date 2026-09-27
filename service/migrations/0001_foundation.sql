-- Shared foundation: anonymous players, cookie sessions, server-recorded scan
-- results, the shared leaderboard, and idempotency records.
-- Times are UTC milliseconds since the Unix epoch.

CREATE TABLE players (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Only a SHA-256 hash of the cookie token is stored.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  renewed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE INDEX sessions_player ON sessions(player_id);

-- Completed, server-computed results only. No images, landmarks, or native
-- frame scores are stored. match_id is reserved for the planned 1v1 flow.
CREATE TABLE scan_results (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id),
  match_id TEXT,
  capture_mode TEXT NOT NULL CHECK (capture_mode IN ('live', 'upload')),
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  tier TEXT NOT NULL,
  model_version TEXT NOT NULL,
  display_map_version TEXT NOT NULL,
  frame_count INTEGER NOT NULL CHECK (frame_count >= 1),
  created_at INTEGER NOT NULL
);
CREATE INDEX scan_results_player ON scan_results(player_id, created_at DESC);

-- Best published result per player and scoring cohort.
CREATE TABLE leaderboard_entries (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id),
  result_id TEXT NOT NULL REFERENCES scan_results(id),
  display_name TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  tier TEXT NOT NULL,
  model_version TEXT NOT NULL,
  display_map_version TEXT NOT NULL,
  capture_mode TEXT NOT NULL,
  achieved_at INTEGER NOT NULL,
  published_at INTEGER NOT NULL,
  UNIQUE (player_id, model_version, display_map_version, capture_mode)
);
CREATE INDEX leaderboard_rank ON leaderboard_entries(model_version, display_map_version, capture_mode, score DESC, achieved_at ASC, id ASC);

CREATE TABLE request_deduplication (
  player_id TEXT NOT NULL REFERENCES players(id),
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  resource_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, operation, idempotency_key)
);
CREATE INDEX request_deduplication_expiry ON request_deduplication(expires_at);
