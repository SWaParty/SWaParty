CREATE TABLE IF NOT EXISTS rooms (
  id UUID PRIMARY KEY,
  hash VARCHAR(16) NOT NULL UNIQUE,
  title VARCHAR(160) NOT NULL,
  notice TEXT,
  host_user_id VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'open',
  max_members INTEGER NOT NULL DEFAULT 8,
  host_only_control BOOLEAN NOT NULL DEFAULT TRUE,
  allow_chat BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT NOT NULL,
  closed_at BIGINT,
  host_last_seen_at BIGINT,
  host_disconnected_at BIGINT,
  expires_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_rooms_host_created
  ON rooms(host_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rooms_status_created
  ON rooms(status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_one_live_host
  ON rooms(host_user_id)
  WHERE status IN ('open', 'host_disconnected');

CREATE INDEX IF NOT EXISTS idx_rooms_hash_status
  ON rooms(hash, status);

CREATE INDEX IF NOT EXISTS idx_rooms_lifecycle_cleanup
  ON rooms(status, host_disconnected_at, expires_at);

CREATE TABLE IF NOT EXISTS room_members (
  id UUID PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id VARCHAR(128) NOT NULL,
  display_name_snapshot VARCHAR(160),
  avatar_url_snapshot TEXT,
  role VARCHAR(16) NOT NULL DEFAULT 'member',
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  joined_at BIGINT NOT NULL,
  removed_at BIGINT,
  UNIQUE(room_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_room_members_room_status
  ON room_members(room_id, status, joined_at);

CREATE INDEX IF NOT EXISTS idx_room_members_user_status
  ON room_members(user_id, status, joined_at DESC);

CREATE TABLE IF NOT EXISTS room_member_sessions (
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id VARCHAR(128) NOT NULL,
  client_id VARCHAR(128) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  joined_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  left_at BIGINT,
  PRIMARY KEY (room_id, user_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_room_member_sessions_active
  ON room_member_sessions(room_id, user_id, status, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS room_playback_state (
  room_id UUID PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  media_id VARCHAR(128),
  media_key VARCHAR(2048),
  media_title_snapshot VARCHAR(240),
  media_duration_sec DOUBLE PRECISION,
  source_type VARCHAR(32),
  current_time_sec DOUBLE PRECISION NOT NULL DEFAULT 0,
  paused BOOLEAN NOT NULL DEFAULT TRUE,
  playback_rate DOUBLE PRECISION NOT NULL DEFAULT 1,
  revision BIGINT NOT NULL DEFAULT 0,
  updated_by VARCHAR(128),
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS room_messages (
  id UUID PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  media_id VARCHAR(128),
  media_key VARCHAR(2048),
  video_time_sec DOUBLE PRECISION,
  sender_user_id VARCHAR(128) NOT NULL,
  sender_name_snapshot VARCHAR(160),
  sender_avatar_url_snapshot TEXT,
  body TEXT NOT NULL,
  kind VARCHAR(24) NOT NULL DEFAULT 'chat',
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_room_messages_room_created
  ON room_messages(room_id, created_at);

CREATE INDEX IF NOT EXISTS idx_room_messages_room_media_time
  ON room_messages(room_id, media_key, video_time_sec);

CREATE TABLE IF NOT EXISTS room_activity_logs (
  id UUID PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  actor_user_id VARCHAR(128),
  kind VARCHAR(48) NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_room_activity_logs_room_created
  ON room_activity_logs(room_id, created_at DESC);

CREATE TABLE IF NOT EXISTS room_invites (
  id UUID PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  sender_user_id VARCHAR(128) NOT NULL,
  receiver_user_id VARCHAR(128) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  message_snapshot TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  UNIQUE(room_id, receiver_user_id, status)
);

CREATE INDEX IF NOT EXISTS idx_room_invites_receiver_status
  ON room_invites(receiver_user_id, status, created_at DESC);
