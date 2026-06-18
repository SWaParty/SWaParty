import { json, readJson } from '../../../_lib/http';
import {
  DEFAULT_MEDIA_DURATION_QUOTA_SEC,
  DEFAULT_MEDIA_STORAGE_QUOTA_BYTES,
  MEDIA_MULTIPART_MAX_CONCURRENCY,
  MEDIA_MULTIPART_PART_SIZE_BYTES,
  MAX_MEDIA_ORIGINAL_BYTES,
  createMediaId,
  currentTimestamp,
  getMultipartPartCount,
  mediaError,
  mediaOriginalKey,
  normalizeMediaCategory,
  normalizeMediaTitle,
  normalizeMimeType,
  requireSessionUser,
  sanitizeFilename,
} from '../../../_lib/media';
import {
  createMultipartUploadPartUrlMap,
  createR2MultipartUpload,
  getMediaPresignConfig,
} from '../../../_lib/r2Presign';

function normalizeProcessingMode(value) {
  return value === 'full_quality' ? 'full_quality' : 'fast_playable';
}

async function clearStaleActiveMediaTasks(env, userId, quota) {
  let activeUploadMediaId = quota?.active_upload_media_id || null;
  let activeTranscodeMediaId = quota?.active_transcode_media_id || null;
  const updates = [];

  if (activeUploadMediaId) {
    const activeUpload = await env.DB
      .prepare(
        `SELECT id, upload_status, deleted_at
         FROM media_items
         WHERE id = ? AND user_id = ?
         LIMIT 1`,
      )
      .bind(activeUploadMediaId, userId)
      .first();
    if (!activeUpload || activeUpload.deleted_at || String(activeUpload.upload_status || '') !== 'uploading') {
      activeUploadMediaId = null;
      updates.push('active_upload_media_id = NULL');
    }
  }

  if (activeTranscodeMediaId) {
    const activeTranscode = await env.DB
      .prepare(
        `SELECT id, upload_status, transcode_status, deleted_at
         FROM media_items
         WHERE id = ? AND user_id = ?
         LIMIT 1`,
      )
      .bind(activeTranscodeMediaId, userId)
      .first();
    if (
      !activeTranscode
      || activeTranscode.deleted_at
      || activeTranscode.upload_status !== 'uploaded'
      || !['queued', 'processing'].includes(String(activeTranscode.transcode_status || ''))
    ) {
      activeTranscodeMediaId = null;
      updates.push('active_transcode_media_id = NULL');
    }
  }

  if (updates.length) {
    await env.DB
      .prepare(`UPDATE user_media_quota SET ${updates.join(', ')}, updated_at = ? WHERE user_id = ?`)
      .bind(currentTimestamp(), userId)
      .run();
  }

  return {
    activeUploadMediaId,
    activeTranscodeMediaId,
  };
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return mediaError('DB binding is missing', 500, 'missing_db_binding');
  if (!env.MEDIA) return mediaError('MEDIA R2 binding is missing', 500, 'missing_media_binding');
  const presignConfig = getMediaPresignConfig(env);
  if (!presignConfig) {
    return mediaError('MEDIA presign config is missing', 500, 'missing_media_presign_config');
  }

  const session = await requireSessionUser(context);
  if (!session) return mediaError('Unauthorized', 401, 'unauthorized');

  const body = await readJson(request);
  if (!body) return mediaError('Invalid JSON body', 400, 'invalid_json');

  const originalFilename = sanitizeFilename(body.filename);
  const title = normalizeMediaTitle(body.title, originalFilename);
  const category = normalizeMediaCategory(body.category);
  const mimeType = normalizeMimeType(body.mimeType);
  const originalSizeBytes = Math.max(0, Math.floor(Number(body.sizeBytes || 0)));
  const durationSec = Number(body.durationSec);
  const safeDurationSec = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null;
  const sourceWidth = Math.max(0, Math.floor(Number(body.width || 0))) || null;
  const sourceHeight = Math.max(0, Math.floor(Number(body.height || 0))) || null;
  const processingMode = normalizeProcessingMode(body.processingMode);

  if (!mimeType.startsWith('video/')) {
    return mediaError('Unsupported media type', 400, 'media_type_not_allowed');
  }
  if (!originalSizeBytes || originalSizeBytes > MAX_MEDIA_ORIGINAL_BYTES) {
    return mediaError('Video file is too large', 400, 'media_file_too_large', {
      maxBytes: MAX_MEDIA_ORIGINAL_BYTES,
    });
  }

  const now = currentTimestamp();
  const quota = await env.DB
    .prepare(
      `SELECT user_id, max_storage_bytes, max_duration_sec, used_storage_bytes, used_duration_sec,
              active_upload_media_id, active_transcode_media_id
       FROM user_media_quota
       WHERE user_id = ?
       LIMIT 1`,
    )
    .bind(session.user_id)
    .first();

  const maxStorageBytes = Number(quota?.max_storage_bytes || DEFAULT_MEDIA_STORAGE_QUOTA_BYTES);
  const maxDurationSec = Number(quota?.max_duration_sec || DEFAULT_MEDIA_DURATION_QUOTA_SEC);
  const usedStorageBytes = Number(quota?.used_storage_bytes || 0);
  const usedDurationSec = Number(quota?.used_duration_sec || 0);

  const activeTasks = await clearStaleActiveMediaTasks(env, session.user_id, quota);
  const activeMediaTaskId = activeTasks.activeUploadMediaId || activeTasks.activeTranscodeMediaId || null;
  if (activeMediaTaskId) {
    return mediaError('Another media upload or processing task is active', 409, 'active_media_task_exists', {
      activeMediaTaskId,
    });
  }
  if (usedStorageBytes + originalSizeBytes > maxStorageBytes) {
    return mediaError('Storage quota exceeded', 409, 'storage_quota_exceeded', {
      usedStorageBytes,
      maxStorageBytes,
    });
  }
  if (safeDurationSec !== null && usedDurationSec + safeDurationSec > maxDurationSec) {
    return mediaError('Duration quota exceeded', 409, 'duration_quota_exceeded', {
      usedDurationSec,
      maxDurationSec,
    });
  }

  const mediaId = createMediaId();
  const uploadSessionId = crypto.randomUUID();
  const originalR2Key = mediaOriginalKey({
    userId: session.user_id,
    mediaId,
    filename: originalFilename,
    mimeType,
  });
  const partsTotal = getMultipartPartCount(originalSizeBytes, MEDIA_MULTIPART_PART_SIZE_BYTES);
  let multipartUpload;
  try {
    multipartUpload = await createR2MultipartUpload({
      config: presignConfig,
      objectKey: originalR2Key,
      contentType: mimeType || 'application/octet-stream',
      cacheControl: 'public, max-age=31536000, immutable',
    });
  } catch (error) {
    return mediaError('R2 multipart upload could not be created', 500, 'r2_create_multipart_failed', {
      detail: String(error?.message || error || '').slice(0, 240),
    });
  }

  const batch = [
    env.DB
      .prepare(
        `INSERT INTO media_items
          (id, user_id, title, category, source_type, upload_status, original_r2_key, original_filename,
           mime_type, source_width, source_height, duration_sec, original_size_bytes, total_size_bytes, processing_mode,
           upload_provider, current_upload_session_id,
           upload_part_size_bytes, upload_parts_total, upload_parts_uploaded, upload_bytes_received,
           upload_started_at, upload_updated_at, playback_status, transcode_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'upload', 'uploading', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'r2_multipart', ?, ?, ?, 0, 0, ?, ?, 'not_ready', 'none', ?, ?)`,
      )
      .bind(
        mediaId,
        session.user_id,
        title,
        category,
        originalR2Key,
        originalFilename,
        mimeType,
        sourceWidth,
        sourceHeight,
        safeDurationSec,
        originalSizeBytes,
        originalSizeBytes,
        processingMode,
        uploadSessionId,
        MEDIA_MULTIPART_PART_SIZE_BYTES,
        partsTotal,
        now,
        now,
        now,
        now,
      ),
    env.DB
      .prepare(
        `INSERT INTO media_upload_sessions
          (id, media_id, user_id, provider, provider_upload_id, object_key, status, part_size_bytes,
           parts_total, parts_uploaded, bytes_total, bytes_uploaded, expires_at, created_at, started_at, updated_at)
         VALUES (?, ?, ?, 'r2_multipart', ?, ?, 'uploading', ?, ?, 0, ?, 0, ?, ?, ?, ?)`,
      )
      .bind(
        uploadSessionId,
        mediaId,
        session.user_id,
        multipartUpload.uploadId,
        originalR2Key,
        MEDIA_MULTIPART_PART_SIZE_BYTES,
        partsTotal,
        originalSizeBytes,
        now + 86400,
        now,
        now,
        now,
      ),
  ];

  if (quota) {
    batch.push(
      env.DB
        .prepare('UPDATE user_media_quota SET active_upload_media_id = ?, updated_at = ? WHERE user_id = ?')
        .bind(mediaId, now, session.user_id),
    );
  } else {
    batch.push(
      env.DB
        .prepare(
          `INSERT INTO user_media_quota
            (user_id, max_storage_bytes, max_duration_sec, used_storage_bytes, used_duration_sec,
             active_upload_media_id, active_transcode_media_id, updated_at)
           VALUES (?, ?, ?, 0, 0, ?, ?, ?)`,
        )
        .bind(session.user_id, DEFAULT_MEDIA_STORAGE_QUOTA_BYTES, DEFAULT_MEDIA_DURATION_QUOTA_SEC, mediaId, null, now),
    );
  }

  await env.DB.batch(batch);

  const signedPartUrls = await createMultipartUploadPartUrlMap({
    config: presignConfig,
    objectKey: originalR2Key,
    uploadId: multipartUpload.uploadId,
    partsTotal,
    excludePartNumbers: [],
  });

  return json({
    ok: true,
    mediaId,
    upload: {
      uploadSessionId,
      partSizeBytes: MEDIA_MULTIPART_PART_SIZE_BYTES,
      partsTotal,
      maxConcurrency: MEDIA_MULTIPART_MAX_CONCURRENCY,
      confirmPartUrlTemplate: `/api/media/uploads/${encodeURIComponent(mediaId)}/parts/{partNumber}`,
      signedPartUrls,
    },
  });
}
