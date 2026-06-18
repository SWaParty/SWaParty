import { json, readJson } from '../../../_lib/http';
import { publishRealtimeEvent } from '../../../_lib/realtime';
import { currentTimestamp, mediaError, requireSessionUser } from '../../../_lib/media';

const RENDITION_JOBS = {
  480: { jobType: 'base_480p', queueLevel: 1 },
  720: { jobType: 'enhance_720p', queueLevel: 2 },
  1080: { jobType: 'enhance_1080p', queueLevel: 3 },
};

function estimateWork(durationSec, sourceHeight, targetHeight) {
  const duration = Math.max(1, Number(durationSec || 1));
  const source = Number(sourceHeight || 0);
  const sourceFactor = source >= 2160 ? 6 : (source >= 1080 ? 1.8 : 1);
  const targetFactor = targetHeight >= 1080 ? 2.4 : (targetHeight >= 720 ? 1.6 : 1);
  return duration * sourceFactor * targetFactor;
}

export async function onRequestPost(context) {
  const { env, params, request } = context;
  if (!env.DB) return mediaError('DB binding is missing', 500, 'missing_db_binding');

  const session = await requireSessionUser(context);
  if (!session) return mediaError('Unauthorized', 401, 'unauthorized');

  const mediaId = String(params?.id || '').trim();
  if (!mediaId) return mediaError('Invalid media id', 400, 'invalid_media_id');

  const body = await readJson(request);
  if (!body) return mediaError('Invalid JSON body', 400, 'invalid_json');

  const targetHeight = Math.floor(Number(body.height || 0));
  const target = RENDITION_JOBS[targetHeight];
  if (!target) return mediaError('Unsupported rendition height', 400, 'unsupported_rendition_height');

  const media = await env.DB
    .prepare(
      `SELECT id, user_id, duration_sec, source_height, transcode_status, deleted_at
       FROM media_items
       WHERE id = ? AND user_id = ?
       LIMIT 1`,
    )
    .bind(mediaId, session.user_id)
    .first();

  if (!media || media.deleted_at) return mediaError('Media item not found', 404, 'media_not_found');

  const sourceHeight = Math.max(0, Number(media.source_height || 0));
  if (!sourceHeight) return mediaError('Source resolution is not available yet', 409, 'source_resolution_missing');
  if (sourceHeight < targetHeight) return mediaError('Target rendition exceeds source resolution', 400, 'rendition_exceeds_source');

  const readyRendition = await env.DB
    .prepare(
      `SELECT id, status
       FROM media_renditions
       WHERE media_id = ? AND height = ? AND status = 'ready'
       LIMIT 1`,
    )
    .bind(mediaId, targetHeight)
    .first();

  if (readyRendition) {
    return json({ ok: true, mediaId, height: targetHeight, status: 'ready', queued: false });
  }

  const existingJob = await env.DB
    .prepare(
      `SELECT id, status
       FROM transcode_jobs
       WHERE media_id = ? AND user_id = ? AND job_type = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .bind(mediaId, session.user_id, target.jobType)
    .first();

  if (existingJob && (existingJob.status === 'queued' || existingJob.status === 'processing')) {
    return json({ ok: true, mediaId, height: targetHeight, status: existingJob.status, queued: false });
  }

  const now = currentTimestamp();
  const jobId = existingJob && existingJob.status !== 'done' ? existingJob.id : crypto.randomUUID();
  await env.DB.batch([
    existingJob && existingJob.status !== 'done'
      ? env.DB
        .prepare(
          `UPDATE transcode_jobs
           SET status = 'queued',
               queue_level = ?,
               estimated_work = ?,
               progress_percent = 0,
               attempts = 0,
               locked_by = NULL,
               locked_until = NULL,
               error_message = NULL,
               started_at = NULL,
               finished_at = NULL,
               progress_updated_at = NULL,
               last_promoted_at = NULL
           WHERE id = ? AND media_id = ? AND user_id = ?`,
        )
        .bind(target.queueLevel, estimateWork(media.duration_sec, sourceHeight, targetHeight), jobId, mediaId, session.user_id)
      : env.DB
        .prepare(
          `INSERT INTO transcode_jobs
             (id, media_id, user_id, job_type, queue_level, status, estimated_work, progress_percent, attempts, created_at)
           VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, 0, ?)`,
        )
        .bind(
          jobId,
          mediaId,
          session.user_id,
          target.jobType,
          target.queueLevel,
          estimateWork(media.duration_sec, sourceHeight, targetHeight),
          now,
        ),
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
      .bind(crypto.randomUUID(), mediaId, targetHeight, `${targetHeight}p`, now, now),
    env.DB
      .prepare(
        `UPDATE media_items
         SET transcode_status = 'queued',
             processing_mode = 'full_quality',
             updated_at = ?
         WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
      )
      .bind(now, mediaId, session.user_id),
  ]);

  await publishRealtimeEvent(env, {
    type: 'media.updated',
    targets: [session.user_id],
    payload: {
      mediaId,
      reason: 'rendition_queued',
      height: targetHeight,
      transcodeStatus: 'queued',
    },
  }, { timeoutMs: 1500 });

  return json({
    ok: true,
    mediaId,
    height: targetHeight,
    jobId,
    status: 'queued',
    queued: true,
  });
}
