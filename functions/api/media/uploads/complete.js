import { json, readJson } from '../../../_lib/http';
import {
  currentTimestamp,
  isBrowserPlayableMime,
  mediaError,
  normalizeMimeType,
  requireSessionUser,
} from '../../../_lib/media';
import { completeR2MultipartUpload, getMediaPresignConfig } from '../../../_lib/r2Presign';

const JOB_LEVELS = {
  probe: 0,
  thumbnail: 0,
  base_480p: 1,
  enhance_720p: 2,
  enhance_1080p: 3,
};

const DEFER_1080P_SOURCE_HEIGHT = 1440;
const DEFER_1080P_DURATION_SEC = 20 * 60;

const RENDITION_JOBS = {
  base_480p: { height: 480, label: '480p' },
  enhance_720p: { height: 720, label: '720p' },
  enhance_1080p: { height: 1080, label: '1080p' },
};

function estimateWork(durationSec, sourceHeight, targetHeight = 480) {
  const duration = Math.max(1, Number(durationSec || 1));
  const source = Number(sourceHeight || 0);
  const sourceFactor = source >= 2160 ? 6 : (source >= 1080 ? 1.8 : 1);
  const targetFactor = targetHeight >= 1080 ? 2.4 : (targetHeight >= 720 ? 1.6 : 1);
  return duration * sourceFactor * targetFactor;
}

function normalizeProcessingMode(value) {
  return value === 'full_quality' ? 'full_quality' : 'fast_playable';
}

function shouldDeferAutomatic1080Job({ sourceHeight, durationSec, processingMode }) {
  const height = Number(sourceHeight || 0);
  const duration = Number(durationSec || 0);
  return processingMode === 'full_quality'
    && height > DEFER_1080P_SOURCE_HEIGHT
    && duration >= DEFER_1080P_DURATION_SEC;
}

function buildTranscodeJobs({ mediaId, userId, durationSec, sourceHeight, processingMode, now }) {
  const height = Number(sourceHeight || 0);
  const jobs = [
    { jobType: 'probe', queueLevel: JOB_LEVELS.probe, estimatedWork: Math.max(1, Number(durationSec || 1)) },
    { jobType: 'thumbnail', queueLevel: JOB_LEVELS.thumbnail, estimatedWork: Math.max(1, Number(durationSec || 1)) },
  ];

  if (!height || height >= 480) {
    jobs.push({
      jobType: 'base_480p',
      queueLevel: JOB_LEVELS.base_480p,
      estimatedWork: estimateWork(durationSec, sourceHeight, 480),
    });
  }

  if (processingMode === 'full_quality') {
    if (height >= 720) {
      jobs.push({
        jobType: 'enhance_720p',
        queueLevel: JOB_LEVELS.enhance_720p,
        estimatedWork: estimateWork(durationSec, sourceHeight, 720),
      });
    }
    if (
      height >= 1080
      && !shouldDeferAutomatic1080Job({ sourceHeight, durationSec, processingMode })
    ) {
      jobs.push({
        jobType: 'enhance_1080p',
        queueLevel: JOB_LEVELS.enhance_1080p,
        estimatedWork: estimateWork(durationSec, sourceHeight, 1080),
      });
    }
  }

  return jobs.map((job) => ({
    ...job,
    id: crypto.randomUUID(),
    mediaId,
    userId,
    now,
  }));
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

  const mediaId = String(body.mediaId || '').trim();
  if (!mediaId) return mediaError('Invalid media id', 400, 'invalid_media_id');

  const media = await env.DB
    .prepare(
      `SELECT id, user_id, upload_status, original_r2_key, mime_type, original_size_bytes, duration_sec,
              source_width, source_height, processing_mode,
              current_upload_session_id
       FROM media_items
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL
       LIMIT 1`,
    )
    .bind(mediaId, session.user_id)
    .first();

  if (!media) return mediaError('Media item not found', 404, 'media_not_found');
  if (media.upload_status !== 'uploading') return mediaError('Media item is not completing upload', 409, 'invalid_upload_status');
  if (!media.original_r2_key) return mediaError('Media item is missing R2 key', 409, 'missing_original_key');
  if (!media.current_upload_session_id) return mediaError('Media item is missing upload session', 409, 'missing_upload_session');

  const uploadSession = await env.DB
    .prepare(
      `SELECT id, provider_upload_id, object_key, status, parts_total, bytes_total
       FROM media_upload_sessions
       WHERE id = ? AND media_id = ? AND user_id = ?
       LIMIT 1`,
    )
    .bind(media.current_upload_session_id, mediaId, session.user_id)
    .first();
  if (!uploadSession) return mediaError('Upload session not found', 404, 'upload_session_not_found');

  const uploadedPartsRows = await env.DB
    .prepare(
      `SELECT part_number, etag
       FROM media_upload_parts
       WHERE upload_session_id = ?
         AND status = 'uploaded'
       ORDER BY part_number ASC`,
    )
    .bind(uploadSession.id)
    .all();
  const uploadedParts = (uploadedPartsRows?.results || []).map((row) => ({
    partNumber: Number(row.part_number || 0),
    etag: String(row.etag || ''),
  })).filter((part) => part.partNumber > 0 && part.etag);

  const expectedPartsTotal = Math.max(0, Number(uploadSession.parts_total || 0));
  if (!uploadedParts.length || uploadedParts.length !== expectedPartsTotal) {
    return mediaError('Uploaded parts are incomplete', 409, 'multipart_upload_incomplete', {
      expectedPartsTotal,
      uploadedPartsCount: uploadedParts.length,
    });
  }

  await env.DB
    .prepare(
      `UPDATE media_upload_sessions
       SET status = 'completing',
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(currentTimestamp(), uploadSession.id)
    .run();
  await env.DB
    .prepare(
      `UPDATE media_items
       SET upload_updated_at = ?,
           updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .bind(currentTimestamp(), currentTimestamp(), mediaId, session.user_id)
    .run();

  try {
    await completeR2MultipartUpload({
      config: presignConfig,
      objectKey: String(uploadSession.object_key),
      uploadId: String(uploadSession.provider_upload_id),
      parts: uploadedParts,
    });
  } catch (error) {
    const now = currentTimestamp();
    await env.DB.batch([
      env.DB
        .prepare(
          `UPDATE media_upload_sessions
           SET status = 'failed',
               error_message = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .bind(String(error?.message || error || '').slice(0, 500), now, uploadSession.id),
      env.DB
        .prepare(
          `UPDATE media_items
           SET upload_status = 'failed',
               upload_error_message = ?,
               upload_updated_at = ?,
               updated_at = ?
           WHERE id = ? AND user_id = ?`,
        )
        .bind(String(error?.message || error || '').slice(0, 500), now, now, mediaId, session.user_id),
      env.DB
        .prepare(
          `UPDATE user_media_quota
           SET active_upload_media_id = CASE
                 WHEN active_upload_media_id = ? THEN NULL
                 ELSE active_upload_media_id
               END,
               updated_at = ?
           WHERE user_id = ?`,
        )
        .bind(mediaId, now, session.user_id),
    ]);
    return mediaError('R2 multipart upload could not be completed', 500, 'r2_complete_multipart_failed', {
      detail: String(error?.message || error || '').slice(0, 240),
    });
  }
  const object = await env.MEDIA.head(media.original_r2_key);
  if (!object) return mediaError('Uploaded object was not found', 409, 'uploaded_object_missing');

  const expectedSize = Number(media.original_size_bytes || 0);
  const actualSize = Number(object.size || 0);
  if (expectedSize && actualSize && expectedSize !== actualSize) {
    return mediaError('Uploaded object size does not match initialized size', 409, 'media_size_mismatch', {
      expectedSizeBytes: expectedSize,
      actualSizeBytes: actualSize,
    });
  }

  const width = Math.max(0, Math.floor(Number(body.width || 0)))
    || Math.max(0, Math.floor(Number(media.source_width || 0)))
    || null;
  const height = Math.max(0, Math.floor(Number(body.height || 0)))
    || Math.max(0, Math.floor(Number(media.source_height || 0)))
    || null;
  const durationInput = Number(body.durationSec);
  const durationSec = Number.isFinite(durationInput) && durationInput > 0
    ? durationInput
    : (Number(media.duration_sec || 0) || null);
  const mimeType = normalizeMimeType(body.mimeType || media.mime_type);
  const browserPlayable = isBrowserPlayableMime(mimeType) ? 1 : 0;
  const playbackStatus = browserPlayable ? 'mp4_ready' : 'not_ready';
  const processingMode = normalizeProcessingMode(body.processingMode || media.processing_mode);
  const now = currentTimestamp();
  const transcodeJobs = buildTranscodeJobs({
    mediaId,
    userId: session.user_id,
    durationSec,
    sourceHeight: height,
    processingMode,
    now,
  });
  const transcodeStatus = transcodeJobs.length > 0 ? 'queued' : 'none';

  const batch = [
    env.DB
      .prepare(
        `UPDATE media_items
         SET upload_status = 'uploaded',
             current_upload_session_id = NULL,
             original_etag = ?,
             mime_type = ?,
             source_width = ?,
             source_height = ?,
             duration_sec = ?,
             original_size_bytes = ?,
             total_size_bytes = ?,
             browser_playable = ?,
             playback_status = ?,
             transcode_status = ?,
             processing_mode = ?,
             upload_parts_uploaded = ?,
             upload_bytes_received = ?,
             upload_completed_at = ?,
             upload_updated_at = ?,
             upload_error_message = NULL,
             updated_at = ?
         WHERE id = ? AND user_id = ?`,
      )
      .bind(
        object.etag || '',
        mimeType,
        width,
        height,
        durationSec,
        actualSize || expectedSize,
        actualSize || expectedSize,
        browserPlayable,
        playbackStatus,
        transcodeStatus,
        processingMode,
        uploadedParts.length,
        actualSize || expectedSize,
        now,
        now,
        now,
        mediaId,
        session.user_id,
      ),
    env.DB
      .prepare(
        `UPDATE user_media_quota
         SET used_storage_bytes = used_storage_bytes + ?,
             used_duration_sec = used_duration_sec + ?,
             active_upload_media_id = NULL,
             active_transcode_media_id = ?,
             updated_at = ?
         WHERE user_id = ?`,
      )
      .bind(actualSize || expectedSize, durationSec || 0, transcodeJobs.length > 0 ? mediaId : null, now, session.user_id),
    env.DB
      .prepare(
        `UPDATE media_upload_sessions
         SET status = 'completed',
             parts_uploaded = ?,
             bytes_uploaded = ?,
             completed_at = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(uploadedParts.length, actualSize || expectedSize, now, now, uploadSession.id),
  ];

  transcodeJobs.forEach((job) => {
    batch.push(
      env.DB
        .prepare(
          `INSERT INTO transcode_jobs
             (id, media_id, user_id, job_type, queue_level, status, estimated_work, progress_percent, attempts, created_at)
           VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, 0, ?)`,
        )
        .bind(job.id, job.mediaId, job.userId, job.jobType, job.queueLevel, job.estimatedWork, job.now),
    );

    const rendition = RENDITION_JOBS[job.jobType];
    if (rendition) {
      batch.push(
        env.DB
          .prepare(
            `INSERT INTO media_renditions
               (id, media_id, height, label, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'queued', ?, ?)
             ON CONFLICT(media_id, height) DO UPDATE SET
               status = CASE
                 WHEN media_renditions.status = 'ready' THEN media_renditions.status
                 ELSE 'queued'
               END,
               updated_at = excluded.updated_at`,
          )
          .bind(crypto.randomUUID(), job.mediaId, rendition.height, rendition.label, job.now, job.now),
      );
    }
  });

  await env.DB.batch(batch);

  return json({
    ok: true,
    mediaId,
    playbackStatus,
    transcodeStatus,
    browserPlayable: Boolean(browserPlayable),
  });
}
