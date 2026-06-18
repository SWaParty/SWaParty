CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  avatar_url TEXT,
  locale TEXT NOT NULL DEFAULT 'en',
  status TEXT NOT NULL DEFAULT 'active',
  email_verified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_public_id ON users(public_id);
CREATE INDEX IF NOT EXISTS idx_users_display_name ON users(display_name);

CREATE TABLE IF NOT EXISTS signup_requests (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  display_name TEXT,
  preferred_locale TEXT,
  password_hash TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_expires_at INTEGER NOT NULL,
  requested_at INTEGER NOT NULL,
  consumed_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  request_ip TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_signup_requests_email_status
  ON signup_requests(email, status);

CREATE INDEX IF NOT EXISTS idx_signup_requests_expires_at
  ON signup_requests(token_expires_at);

-- Migration for existing databases:
-- ALTER TABLE users ADD COLUMN locale TEXT NOT NULL DEFAULT 'en';
-- ALTER TABLE signup_requests ADD COLUMN preferred_locale TEXT;

CREATE TABLE IF NOT EXISTS auth_credentials (
  user_id TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  password_algo TEXT NOT NULL DEFAULT 'pbkdf2_sha256',
  password_updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auth_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  provider_email TEXT,
  provider_email_verified INTEGER NOT NULL DEFAULT 0,
  linked_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_auth_identities_user_id ON auth_identities(user_id);

CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  ip TEXT,
  user_agent TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at);

CREATE TABLE IF NOT EXISTS password_reset_requests (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  code_expires_at INTEGER NOT NULL,
  requested_at INTEGER NOT NULL,
  consumed_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  request_ip TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_password_reset_requests_email_requested_at
  ON password_reset_requests(email, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_password_reset_requests_expires_at
  ON password_reset_requests(code_expires_at);

CREATE TABLE IF NOT EXISTS auth_mfa_totp (
  user_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  secret_ciphertext TEXT,
  secret_kid TEXT,
  enrolled_at INTEGER,
  last_verified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auth_mfa_recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  code_ciphertext TEXT,
  used_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, code_hash)
);

CREATE INDEX IF NOT EXISTS idx_auth_mfa_recovery_codes_user_id
  ON auth_mfa_recovery_codes(user_id);

CREATE TABLE IF NOT EXISTS auth_mfa_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT,
  purpose TEXT NOT NULL DEFAULT 'login',
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES user_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_auth_mfa_challenges_user_expires
  ON auth_mfa_challenges(user_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_auth_mfa_challenges_session_id
  ON auth_mfa_challenges(session_id);

CREATE TABLE IF NOT EXISTS auth_audit_logs (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  email TEXT,
  user_id TEXT,
  ip TEXT,
  user_agent TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_audit_logs_created_at ON auth_audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_auth_audit_logs_email ON auth_audit_logs(email);

CREATE TABLE IF NOT EXISTS email_change_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  new_email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_expires_at INTEGER NOT NULL,
  requested_at INTEGER NOT NULL,
  consumed_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  request_ip TEXT,
  user_agent TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_email_change_requests_user_id_status
  ON email_change_requests(user_id, status);

CREATE INDEX IF NOT EXISTS idx_email_change_requests_new_email_status
  ON email_change_requests(new_email, status);

CREATE INDEX IF NOT EXISTS idx_email_change_requests_expires_at
  ON email_change_requests(token_expires_at);

CREATE TABLE IF NOT EXISTS contact_invites (
  id TEXT PRIMARY KEY,
  sender_user_id TEXT NOT NULL,
  receiver_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected', 'canceled')),
  expires_at INTEGER NOT NULL,
  timeout_notified_at INTEGER,
  receiver_read_at INTEGER,
  receiver_dismissed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  responded_at INTEGER,
  FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (receiver_user_id) REFERENCES users(id) ON DELETE CASCADE,
  CHECK (sender_user_id <> receiver_user_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_invites_sender_status
  ON contact_invites(sender_user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_contact_invites_receiver_status
  ON contact_invites(receiver_user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_contact_invites_pending_expires
  ON contact_invites(status, expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_invites_unique_pending_pair
  ON contact_invites(sender_user_id, receiver_user_id)
  WHERE status = 'pending';

-- Migration for existing databases:
-- ALTER TABLE contact_invites ADD COLUMN expires_at INTEGER;
-- ALTER TABLE contact_invites ADD COLUMN timeout_notified_at INTEGER;
-- ALTER TABLE contact_invites ADD COLUMN receiver_read_at INTEGER;
-- ALTER TABLE contact_invites ADD COLUMN receiver_dismissed_at INTEGER;
-- UPDATE contact_invites
-- SET expires_at = created_at + 86400
-- WHERE expires_at IS NULL;
-- CREATE INDEX IF NOT EXISTS idx_contact_invites_pending_expires
--   ON contact_invites(status, expires_at);

CREATE TABLE IF NOT EXISTS quick_contacts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  contact_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (contact_user_id) REFERENCES users(id) ON DELETE CASCADE,
  CHECK (user_id <> contact_user_id),
  UNIQUE(user_id, contact_user_id)
);

CREATE INDEX IF NOT EXISTS idx_quick_contacts_user_created
  ON quick_contacts(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS contact_inbox_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('contact_removed', 'room_invite', 'watch_request')),
  reason TEXT NOT NULL DEFAULT 'generic',
  actor_user_id TEXT,
  message_locale TEXT NOT NULL DEFAULT 'en',
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_contact_inbox_messages_user_created
  ON contact_inbox_messages(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_contact_inbox_messages_actor_pending_watch
  ON contact_inbox_messages(actor_user_id, kind, reason, created_at);

-- Existing database quick rebuild for this table only:
-- WARNING: This deletes existing inbox notices/invites.
-- DROP TABLE IF EXISTS contact_inbox_messages;
-- CREATE TABLE IF NOT EXISTS contact_inbox_messages (
--   id TEXT PRIMARY KEY,
--   user_id TEXT NOT NULL,
--   kind TEXT NOT NULL CHECK (kind IN ('contact_removed', 'room_invite', 'watch_request')),
--   reason TEXT NOT NULL DEFAULT 'generic',
--   actor_user_id TEXT,
--   message_locale TEXT NOT NULL DEFAULT 'en',
--   message TEXT NOT NULL,
--   created_at INTEGER NOT NULL,
--   read_at INTEGER,
--   FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
--   FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
-- );
-- CREATE INDEX IF NOT EXISTS idx_contact_inbox_messages_user_created
--   ON contact_inbox_messages(user_id, created_at DESC);
-- CREATE INDEX IF NOT EXISTS idx_contact_inbox_messages_actor_pending_watch
--   ON contact_inbox_messages(actor_user_id, kind, reason, created_at);

-- =============================
-- Media pipeline tables
-- =============================

CREATE TABLE IF NOT EXISTS media_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT,
  source_type TEXT NOT NULL DEFAULT 'upload'
    CHECK (source_type IN ('upload', 'external_url')),
  upload_status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (upload_status IN ('waiting', 'uploading', 'completing', 'uploaded', 'failed', 'cancelled', 'deleted')),
  original_r2_key TEXT,
  original_filename TEXT,
  original_etag TEXT,
  upload_provider TEXT
    CHECK (upload_provider IS NULL OR upload_provider IN ('r2_multipart')),
  current_upload_session_id TEXT,
  upload_part_size_bytes INTEGER,
  upload_parts_total INTEGER NOT NULL DEFAULT 0,
  upload_parts_uploaded INTEGER NOT NULL DEFAULT 0,
  upload_bytes_received INTEGER NOT NULL DEFAULT 0,
  upload_error_message TEXT,
  upload_started_at INTEGER,
  upload_completed_at INTEGER,
  upload_updated_at INTEGER,
  thumbnail_r2_key TEXT,
  mime_type TEXT,
  source_width INTEGER,
  source_height INTEGER,
  duration_sec REAL,
  original_size_bytes INTEGER NOT NULL DEFAULT 0,
  hls_size_bytes INTEGER NOT NULL DEFAULT 0,
  thumbnail_size_bytes INTEGER NOT NULL DEFAULT 0,
  total_size_bytes INTEGER NOT NULL DEFAULT 0,
  browser_playable INTEGER NOT NULL DEFAULT 0 CHECK (browser_playable IN (0, 1)),
  starred INTEGER NOT NULL DEFAULT 0 CHECK (starred IN (0, 1)),
  starred_at INTEGER,
  playback_status TEXT NOT NULL DEFAULT 'not_ready'
    CHECK (playback_status IN ('not_ready', 'mp4_ready', 'playable_base', 'playable_hd', 'deleted')),
  transcode_status TEXT NOT NULL DEFAULT 'none'
    CHECK (transcode_status IN ('none', 'queued', 'processing', 'ready', 'failed', 'deleted')),
  processing_mode TEXT
    CHECK (processing_mode IS NULL OR processing_mode IN ('fast_playable', 'full_quality')),
  hls_master_key TEXT,
  external_url TEXT,
  external_embed_url TEXT,
  transcode_error_message TEXT,
  last_played_at INTEGER,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_media_items_user_created
  ON media_items(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_media_items_user_status
  ON media_items(user_id, playback_status, transcode_status);

CREATE INDEX IF NOT EXISTS idx_media_items_user_starred
  ON media_items(user_id, starred, starred_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_media_items_last_played
  ON media_items(last_played_at);

CREATE INDEX IF NOT EXISTS idx_media_items_user_deleted_created
  ON media_items(user_id, deleted_at, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_media_items_user_upload_status
  ON media_items(user_id, upload_status, upload_updated_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_media_items_upload_session
  ON media_items(current_upload_session_id);

CREATE TABLE IF NOT EXISTS media_delete_jobs (
  id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  r2_prefix TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_by TEXT,
  locked_until INTEGER,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  FOREIGN KEY (media_id) REFERENCES media_items(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_media_delete_jobs_claim
  ON media_delete_jobs(status, locked_until, created_at);

CREATE INDEX IF NOT EXISTS idx_media_delete_jobs_media_status
  ON media_delete_jobs(media_id, status);

-- Migration for existing databases:
-- Rebuild media_items once with the current definition above, then recreate
-- these indexes:
--   idx_media_items_user_created
--   idx_media_items_user_status
--   idx_media_items_user_starred
--   idx_media_items_last_played
--   idx_media_items_user_deleted_created
--   idx_media_items_user_upload_status
--   idx_media_items_upload_session
-- Legacy single-request upload deployments should remove any code or queries
-- that depend on user_media_quota.active_media_task_id before using this
-- multipart-oriented schema.

CREATE TABLE IF NOT EXISTS media_categories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, normalized_name)
);

CREATE INDEX IF NOT EXISTS idx_media_categories_user_sort
  ON media_categories(user_id, sort_order, created_at);

CREATE TABLE IF NOT EXISTS media_renditions (
  id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL,
  height INTEGER NOT NULL,
  label TEXT NOT NULL,
  playlist_r2_key TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'ready', 'failed', 'cancelled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (media_id) REFERENCES media_items(id) ON DELETE CASCADE,
  UNIQUE(media_id, height)
);

CREATE INDEX IF NOT EXISTS idx_media_renditions_media_status
  ON media_renditions(media_id, status);

CREATE TABLE IF NOT EXISTS media_upload_sessions (
  id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'r2_multipart'
    CHECK (provider IN ('r2_multipart')),
  provider_upload_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploading'
    CHECK (status IN ('uploading', 'completing', 'completed', 'aborted', 'failed', 'expired')),
  part_size_bytes INTEGER NOT NULL,
  parts_total INTEGER NOT NULL DEFAULT 0,
  parts_uploaded INTEGER NOT NULL DEFAULT 0,
  bytes_total INTEGER NOT NULL DEFAULT 0,
  bytes_uploaded INTEGER NOT NULL DEFAULT 0,
  last_part_number INTEGER,
  error_message TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (media_id) REFERENCES media_items(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_media_upload_sessions_provider_upload_id
  ON media_upload_sessions(provider, provider_upload_id);

CREATE INDEX IF NOT EXISTS idx_media_upload_sessions_media_status
  ON media_upload_sessions(media_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_media_upload_sessions_user_status
  ON media_upload_sessions(user_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS media_upload_parts (
  id TEXT PRIMARY KEY,
  upload_session_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  part_number INTEGER NOT NULL,
  part_size_bytes INTEGER NOT NULL DEFAULT 0,
  etag TEXT,
  checksum_sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('uploaded', 'replaced', 'failed')),
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (upload_session_id) REFERENCES media_upload_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (media_id) REFERENCES media_items(id) ON DELETE CASCADE,
  UNIQUE(upload_session_id, part_number)
);

CREATE INDEX IF NOT EXISTS idx_media_upload_parts_media
  ON media_upload_parts(media_id, part_number);

CREATE TABLE IF NOT EXISTS transcode_jobs (
  id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  job_type TEXT NOT NULL
    CHECK (job_type IN ('probe', 'thumbnail', 'base_480p', 'enhance_720p', 'enhance_1080p')),
  queue_level INTEGER NOT NULL DEFAULT 0 CHECK (queue_level IN (0, 1, 2, 3)),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'done', 'failed', 'cancelled')),
  estimated_work REAL NOT NULL DEFAULT 0,
  progress_percent REAL NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_by TEXT,
  locked_until INTEGER,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  progress_updated_at INTEGER,
  started_at INTEGER,
  finished_at INTEGER,
  last_promoted_at INTEGER,
  FOREIGN KEY (media_id) REFERENCES media_items(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_transcode_jobs_claim
  ON transcode_jobs(status, queue_level, locked_until, estimated_work, created_at);

CREATE INDEX IF NOT EXISTS idx_transcode_jobs_media_status
  ON transcode_jobs(media_id, status);

CREATE INDEX IF NOT EXISTS idx_transcode_jobs_user_status
  ON transcode_jobs(user_id, status);

-- Migration for existing databases:
-- ALTER TABLE transcode_jobs ADD COLUMN progress_percent REAL NOT NULL DEFAULT 0;
-- ALTER TABLE transcode_jobs ADD COLUMN progress_updated_at INTEGER;

CREATE TABLE IF NOT EXISTS user_media_quota (
  user_id TEXT PRIMARY KEY,
  max_storage_bytes INTEGER NOT NULL DEFAULT 2147483648,
  max_duration_sec INTEGER NOT NULL DEFAULT 7200,
  used_storage_bytes INTEGER NOT NULL DEFAULT 0,
  used_duration_sec REAL NOT NULL DEFAULT 0,
  active_upload_media_id TEXT,
  active_transcode_media_id TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_media_quota_active_upload
  ON user_media_quota(active_upload_media_id);

CREATE INDEX IF NOT EXISTS idx_user_media_quota_active_transcode
  ON user_media_quota(active_transcode_media_id);










-- =============================
-- DEV ONLY: Reset all data
-- =============================
-- WARNING: This section will permanently delete all business data.
-- Never run in production.
--
-- Usage:
-- 1) Keep this block only for local/dev reset.
-- 2) For Cloudflare dashboard console, run only the DELETE FROM statements below.
--    Do not run BEGIN IMMEDIATE TRANSACTION, COMMIT or SAVEPOINT statements there.
-- 3) For local SQLite/D1-compatible clients, keep the transaction wrapper for consistency.

BEGIN IMMEDIATE TRANSACTION;
PRAGMA foreign_keys = OFF;

-- Media pipeline data.
DELETE FROM media_delete_jobs;
DELETE FROM transcode_jobs;
DELETE FROM media_upload_parts;
DELETE FROM media_upload_sessions;
DELETE FROM media_renditions;
DELETE FROM media_items;
DELETE FROM media_categories;
DELETE FROM user_media_quota;

-- Contact and invitation data.
-- Covers contact removal notices, room invites and pending watch requests.
DELETE FROM contact_inbox_messages;
DELETE FROM quick_contacts;
DELETE FROM contact_invites;

-- Authentication and account data.
DELETE FROM auth_audit_logs;
DELETE FROM auth_mfa_challenges;
DELETE FROM auth_mfa_recovery_codes;
DELETE FROM auth_mfa_totp;
DELETE FROM email_change_requests;
DELETE FROM password_reset_requests;
DELETE FROM user_sessions;
DELETE FROM auth_identities;
DELETE FROM auth_credentials;
DELETE FROM signup_requests;
DELETE FROM users;

PRAGMA foreign_keys = ON;
COMMIT;

-- Optional maintenance after large cleanup:
-- VACUUM;
