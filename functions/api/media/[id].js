import { json, readJson } from '../../_lib/http';
import { publishRealtimeEvent } from '../../_lib/realtime';
import {
  currentTimestamp,
  mediaError,
  normalizeMediaTitle,
  requireSessionUser,
} from '../../_lib/media';
import { abortR2MultipartUpload, getMediaPresignConfig } from '../../_lib/r2Presign';

function getMediaId(context) {
  return String(context.params?.id || '').trim();
}

async function requireOwnedMedia(env, userId, mediaId) {
  return env.DB
    .prepare(
      `SELECT id, user_id, title, starred, starred_at, original_size_bytes, hls_size_bytes,
              thumbnail_size_bytes, total_size_bytes, duration_sec, original_r2_key,
              thumbnail_r2_key, hls_master_key, current_upload_session_id, deleted_at
       FROM media_items
       WHERE id = ? AND user_id = ?
       LIMIT 1`,
    )
    .bind(mediaId, userId)
    .first();
}

async function abortMediaMultipartUploads(env, userId, mediaId) {
  const presignConfig = getMediaPresignConfig(env);
  if (!presignConfig) return;

  const sessions = await env.DB
    .prepare(
      `SELECT id, provider_upload_id, object_key
       FROM media_upload_sessions
       WHERE media_id = ?
         AND user_id = ?
         AND provider = 'r2_multipart'
         AND status IN ('uploading', 'completing', 'failed')
         AND provider_upload_id IS NOT NULL
         AND object_key IS NOT NULL`,
    )
    .bind(mediaId, userId)
    .all();

  const rows = sessions?.results || [];
  for (const row of rows) {
    try {
      await abortR2MultipartUpload({
        config: presignConfig,
        objectKey: String(row.object_key),
        uploadId: String(row.provider_upload_id),
      });
    } catch {
      // R2 may already have expired or aborted the multipart upload.
    }
  }
}

export async function onRequestPatch(context) {
  const { env, request } = context;
  if (!env.DB) return mediaError('DB binding is missing', 500, 'missing_db_binding');

  const session = await requireSessionUser(context);
  if (!session) return mediaError('Unauthorized', 401, 'unauthorized');

  const mediaId = getMediaId(context);
  if (!mediaId) return mediaError('Invalid media id', 400, 'invalid_media_id');

  const body = await readJson(request);
  if (!body) return mediaError('Invalid JSON body', 400, 'invalid_json');

  const media = await requireOwnedMedia(env, session.user_id, mediaId);
  if (!media) return mediaError('Media item not found', 404, 'media_not_found');
  if (media.deleted_at) return mediaError('Media item not found', 404, 'media_not_found');

  const hasTitle = Object.prototype.hasOwnProperty.call(body, 'title');
  const hasStarred = Object.prototype.hasOwnProperty.call(body, 'starred');
  if (!hasTitle && !hasStarred) {
    return mediaError('No supported media fields provided', 400, 'empty_media_update');
  }

  const now = currentTimestamp();
  const nextTitle = hasTitle ? normalizeMediaTitle(body.title, media.title) : media.title;
  const nextStarred = hasStarred ? (body.starred ? 1 : 0) : Number(media.starred || 0);
  const nextStarredAt = hasStarred
    ? (nextStarred ? Number(media.starred_at || now) : null)
    : (media.starred_at || null);

  await env.DB
    .prepare(
      `UPDATE media_items
       SET title = ?,
           starred = ?,
           starred_at = ?,
           updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .bind(nextTitle, nextStarred, nextStarredAt, now, mediaId, session.user_id)
    .run();
  await publishRealtimeEvent(env, {
    type: 'media.updated',
    targets: [session.user_id],
    payload: {
      mediaId,
      reason: 'metadata_updated',
    },
  }, { timeoutMs: 1500 });

  return json({
    ok: true,
    item: {
      id: mediaId,
      title: nextTitle,
      starred: Boolean(nextStarred),
      starredAt: nextStarredAt,
      updatedAt: now,
    },
  });
}

export async function onRequestDelete(context) {
  const { env } = context;
  if (!env.DB) return mediaError('DB binding is missing', 500, 'missing_db_binding');

  const session = await requireSessionUser(context);
  if (!session) return mediaError('Unauthorized', 401, 'unauthorized');

  const mediaId = getMediaId(context);
  if (!mediaId) return mediaError('Invalid media id', 400, 'invalid_media_id');

  const media = await requireOwnedMedia(env, session.user_id, mediaId);
  if (!media) return mediaError('Media item not found', 404, 'media_not_found');
  if (media.deleted_at) {
    await abortMediaMultipartUploads(env, session.user_id, mediaId);
    await env.DB
      .prepare(
        `UPDATE media_upload_sessions
         SET status = 'aborted',
             updated_at = ?
         WHERE media_id = ?
           AND user_id = ?
           AND provider = 'r2_multipart'
           AND status IN ('uploading', 'completing', 'failed')`,
      )
      .bind(currentTimestamp(), mediaId, session.user_id)
      .run();
    return json({
      ok: true,
      deletedId: mediaId,
      queued: false,
    });
  }

  const now = currentTimestamp();
  const totalSizeBytes = Math.max(0, Math.floor(Number(media.total_size_bytes || 0)));
  const durationSec = Math.max(0, Number(media.duration_sec || 0));
  const deleteJobId = crypto.randomUUID();
  const r2Prefix = `users/${session.user_id}/media/${mediaId}/`;
  await abortMediaMultipartUploads(env, session.user_id, mediaId);

  await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE media_items
         SET upload_status = 'deleted',
             playback_status = 'deleted',
             transcode_status = 'deleted',
             deleted_at = ?,
             updated_at = ?
         WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
      )
      .bind(now, now, mediaId, session.user_id),
    env.DB
      .prepare(
        `UPDATE transcode_jobs
         SET status = 'cancelled',
             locked_by = NULL,
             locked_until = NULL,
             finished_at = ?
         WHERE media_id = ?
           AND user_id = ?
           AND status IN ('queued', 'processing')`,
      )
      .bind(now, mediaId, session.user_id),
    env.DB
      .prepare(
        `UPDATE media_upload_sessions
         SET status = 'aborted',
             updated_at = ?
         WHERE media_id = ?
           AND user_id = ?
           AND provider = 'r2_multipart'
           AND status IN ('uploading', 'completing', 'failed')`,
      )
      .bind(now, mediaId, session.user_id),
    env.DB
      .prepare(
        `INSERT INTO media_delete_jobs
           (id, media_id, user_id, r2_prefix, status, attempts, created_at)
         VALUES (?, ?, ?, ?, 'queued', 0, ?)`,
      )
      .bind(deleteJobId, mediaId, session.user_id, r2Prefix, now),
    env.DB
      .prepare(
        `UPDATE user_media_quota
         SET used_storage_bytes = MAX(used_storage_bytes - ?, 0),
             used_duration_sec = MAX(used_duration_sec - ?, 0),
             active_upload_media_id = CASE
               WHEN active_upload_media_id = ? THEN NULL
               ELSE active_upload_media_id
             END,
             active_transcode_media_id = CASE
               WHEN active_transcode_media_id = ? THEN NULL
               ELSE active_transcode_media_id
             END,
             updated_at = ?
         WHERE user_id = ?`,
      )
      .bind(totalSizeBytes, durationSec, mediaId, mediaId, now, session.user_id),
  ]);
  await publishRealtimeEvent(env, {
    type: 'media.deleted',
    targets: [session.user_id],
    payload: {
      mediaId,
      reason: 'deleted',
    },
  }, { timeoutMs: 1500 });

  return json({
    ok: true,
    deletedId: mediaId,
    deleteJobId,
    queued: true,
  });
}
