import { json } from '../../_lib/http';
import { requireSessionUser } from '../../_lib/media';

function clampPercent(value) {
  const next = Number(value);
  if (!Number.isFinite(next)) return 0;
  return Math.max(0, Math.min(100, next));
}

function getProgressByJob(rows) {
  const progressByJob = {};
  for (const row of rows || []) {
    const jobType = String(row?.job_type || '').trim();
    if (!jobType) continue;
    const status = String(row?.status || '').trim();
    if (status === 'done') {
      progressByJob[jobType] = 100;
      continue;
    }
    if (status === 'cancelled') {
      progressByJob[jobType] = 0;
      continue;
    }
    progressByJob[jobType] = clampPercent(row?.progress_percent);
  }
  return progressByJob;
}

function getAggregateProgress(progressByJob) {
  const values = Object.values(progressByJob || {});
  if (!values.length) return 0;
  const total = values.reduce((sum, value) => sum + clampPercent(value), 0);
  return clampPercent(total / values.length);
}

async function clearActiveUpload(env, userId, mediaId) {
  await env.DB
    .prepare('UPDATE user_media_quota SET active_upload_media_id = NULL WHERE user_id = ? AND active_upload_media_id = ?')
    .bind(userId, mediaId)
    .run();
}

async function clearActiveTranscode(env, userId, mediaId) {
  await env.DB
    .prepare('UPDATE user_media_quota SET active_transcode_media_id = NULL WHERE user_id = ? AND active_transcode_media_id = ?')
    .bind(userId, mediaId)
    .run();
}

export async function onRequestGet(context) {
  const { env } = context;
  if (!env.DB) return json({ ok: false, error: 'DB binding is missing' }, { status: 500 });

  const session = await requireSessionUser(context);
  if (!session) return json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const quota = await env.DB
    .prepare(
      `SELECT active_upload_media_id, active_transcode_media_id
       FROM user_media_quota
       WHERE user_id = ?
       LIMIT 1`,
    )
    .bind(session.user_id)
    .first();

  const activeUploadMediaId = String(quota?.active_upload_media_id || '').trim();
  const activeTranscodeMediaId = String(quota?.active_transcode_media_id || '').trim();

  if (activeUploadMediaId) {
    const uploadMedia = await env.DB
      .prepare(
        `SELECT id, title, upload_status, processing_mode, source_height, browser_playable,
                original_size_bytes, upload_bytes_received, upload_parts_total, upload_parts_uploaded,
                current_upload_session_id, upload_updated_at
         FROM media_items
         WHERE id = ? AND user_id = ? AND deleted_at IS NULL
         LIMIT 1`,
      )
      .bind(activeUploadMediaId, session.user_id)
      .first();

    if (!uploadMedia) {
      await clearActiveUpload(env, session.user_id, activeUploadMediaId);
    } else if (String(uploadMedia.upload_status || '') === 'uploading') {
      let uploadSessionStatus = String(uploadMedia.upload_status || 'uploading');
      if (uploadMedia.current_upload_session_id) {
        const uploadSession = await env.DB
          .prepare(
            `SELECT status, bytes_total, bytes_uploaded, updated_at
             FROM media_upload_sessions
             WHERE id = ? AND media_id = ? AND user_id = ?
             LIMIT 1`,
          )
          .bind(uploadMedia.current_upload_session_id, activeUploadMediaId, session.user_id)
          .first();

        if (uploadSession) {
          uploadSessionStatus = String(uploadSession.status || uploadSessionStatus);
          const bytesTotal = Math.max(0, Number(uploadSession.bytes_total || uploadMedia.original_size_bytes || 0));
          const bytesUploaded = Math.max(0, Number(uploadSession.bytes_uploaded || uploadMedia.upload_bytes_received || 0));
          if (uploadSessionStatus === 'completing') {
            return json({
              ok: true,
              task: {
                mediaId: activeUploadMediaId,
                title: String(uploadMedia.title || '').trim() || 'Untitled video',
                phase: 'processing',
                uploadStatus: uploadMedia.upload_status || 'uploading',
                uploadSessionStatus,
                processingMode: uploadMedia.processing_mode || null,
                sourceHeight: uploadMedia.source_height || null,
                browserPlayable: Boolean(uploadMedia.browser_playable),
                progressPercent: 0,
                progressByJob: {},
              },
            });
          }
          return json({
            ok: true,
            task: {
              mediaId: activeUploadMediaId,
              title: String(uploadMedia.title || '').trim() || 'Untitled video',
              phase: 'uploading',
              uploadStatus: uploadMedia.upload_status || 'uploading',
              uploadSessionStatus,
              processingMode: uploadMedia.processing_mode || null,
              sourceHeight: uploadMedia.source_height || null,
              browserPlayable: Boolean(uploadMedia.browser_playable),
              uploadProgress: bytesTotal > 0 ? clampPercent((bytesUploaded / bytesTotal) * 100) : 0,
              uploadBytesReceived: bytesUploaded,
              uploadBytesTotal: bytesTotal,
              uploadPartsUploaded: Number(uploadMedia.upload_parts_uploaded || 0),
              uploadPartsTotal: Number(uploadMedia.upload_parts_total || 0),
              uploadedPartNumbers: [],
              uploadUpdatedAt: uploadSession.updated_at || uploadMedia.upload_updated_at || null,
              progressByJob: {},
            },
          });
        }
      }

      const bytesTotal = Math.max(0, Number(uploadMedia.original_size_bytes || 0));
      const bytesUploaded = Math.max(0, Number(uploadMedia.upload_bytes_received || 0));
      return json({
        ok: true,
        task: {
          mediaId: activeUploadMediaId,
          title: String(uploadMedia.title || '').trim() || 'Untitled video',
          phase: 'uploading',
          uploadStatus: uploadMedia.upload_status || 'uploading',
          uploadSessionStatus,
          processingMode: uploadMedia.processing_mode || null,
          sourceHeight: uploadMedia.source_height || null,
          browserPlayable: Boolean(uploadMedia.browser_playable),
          uploadProgress: bytesTotal > 0 ? clampPercent((bytesUploaded / bytesTotal) * 100) : 0,
          uploadBytesReceived: bytesUploaded,
          uploadBytesTotal: bytesTotal,
          uploadPartsUploaded: Number(uploadMedia.upload_parts_uploaded || 0),
          uploadPartsTotal: Number(uploadMedia.upload_parts_total || 0),
          uploadedPartNumbers: [],
          uploadUpdatedAt: uploadMedia.upload_updated_at || null,
          progressByJob: {},
        },
      });
    } else {
      await clearActiveUpload(env, session.user_id, activeUploadMediaId);
    }
  }

  const mediaId = activeTranscodeMediaId;
  if (!mediaId) return json({ ok: true, task: null });

  const media = await env.DB
    .prepare(
      `SELECT id, title, upload_status, transcode_status, processing_mode, source_height, browser_playable
       FROM media_items
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL
       LIMIT 1`,
    )
    .bind(mediaId, session.user_id)
    .first();

  if (!media) {
    await clearActiveTranscode(env, session.user_id, mediaId);
    return json({ ok: true, task: null });
  }

  const jobs = await env.DB
    .prepare(
      `SELECT job_type, status, progress_percent
       FROM transcode_jobs
       WHERE media_id = ? AND user_id = ?
         AND status IN ('queued', 'processing', 'done', 'failed')
       ORDER BY queue_level ASC, created_at ASC`,
    )
    .bind(mediaId, session.user_id)
    .all();

  const jobRows = jobs?.results || [];
  const hasActiveJobs = jobRows.some((row) => ['queued', 'processing'].includes(String(row?.status || '')));
  const hasFailedJobs = jobRows.some((row) => String(row?.status || '') === 'failed');

  if (media.upload_status !== 'uploaded') {
    await clearActiveTranscode(env, session.user_id, mediaId);
    return json({ ok: true, task: null });
  }

  if (!hasActiveJobs && !['queued', 'processing'].includes(String(media.transcode_status || ''))) {
    if (String(media.transcode_status || '') === 'failed' || hasFailedJobs) {
      await clearActiveTranscode(env, session.user_id, mediaId);
      return json({
        ok: true,
        task: {
          mediaId,
          title: String(media.title || '').trim() || 'Untitled video',
          phase: 'failed',
          uploadStatus: media.upload_status || 'uploaded',
          transcodeStatus: media.transcode_status || 'failed',
          processingMode: media.processing_mode || null,
          sourceHeight: media.source_height || null,
          browserPlayable: Boolean(media.browser_playable),
          progressPercent: getAggregateProgress(getProgressByJob(jobRows)),
          progressByJob: getProgressByJob(jobRows),
        },
      });
    }

    await clearActiveTranscode(env, session.user_id, mediaId);
    return json({ ok: true, task: null });
  }

  const progressByJob = getProgressByJob(jobRows);

  return json({
    ok: true,
    task: {
      mediaId,
      title: String(media.title || '').trim() || 'Untitled video',
      phase: 'processing',
      uploadStatus: media.upload_status || 'uploaded',
      transcodeStatus: media.transcode_status || 'queued',
      processingMode: media.processing_mode || null,
      sourceHeight: media.source_height || null,
      browserPlayable: Boolean(media.browser_playable),
      progressPercent: getAggregateProgress(progressByJob),
      progressByJob,
    },
  });
}
