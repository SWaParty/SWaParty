/* global Buffer, process */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const JOB_LEVELS = {
  probe: 0,
  thumbnail: 0,
  base_480p: 1,
  enhance_720p: 2,
  enhance_1080p: 3,
};

const RENDITION_TARGETS = {
  base_480p: { height: 480, label: '480p', level: 1 },
  enhance_720p: { height: 720, label: '720p', level: 2 },
  enhance_1080p: { height: 1080, label: '1080p', level: 3 },
};
const DEFER_1080P_SOURCE_HEIGHT = 1440;
const DEFER_1080P_DURATION_SEC = 20 * 60;
const PROGRESS_PUBLISH_MIN_INTERVAL_MS = 1500;
const PROGRESS_PUBLISH_MIN_DELTA = 2;
const FFMPEG_PROGRESS_MAX_BEFORE_FINALIZE = 95;

const config = {
  cloudflareAccountId: requiredEnv('CLOUDFLARE_ACCOUNT_ID'),
  d1DatabaseId: requiredEnv('CLOUDFLARE_D1_DATABASE_ID'),
  cloudflareApiToken: requiredEnv('CLOUDFLARE_API_TOKEN'),
  r2AccountId: process.env.R2_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || '',
  r2AccessKeyId: requiredEnv('R2_ACCESS_KEY_ID'),
  r2SecretAccessKey: requiredEnv('R2_SECRET_ACCESS_KEY'),
  r2BucketName: requiredEnv('R2_BUCKET_NAME'),
  r2Endpoint: normalizeR2Endpoint(process.env.R2_S3_ENDPOINT || process.env.R2_ENDPOINT),
  workerId: process.env.WORKER_ID || `media-worker-${Math.random().toString(16).slice(2)}`,
  pollIntervalMs: numberEnv('POLL_INTERVAL_MS', 5000),
  claimBatchSize: numberEnv('CLAIM_BATCH_SIZE', 4),
  maxConcurrentFfmpeg: Math.max(1, numberEnv('MAX_CONCURRENT_FFMPEG', 1)),
  jobLockSec: numberEnv('JOB_LOCK_SEC', 1800),
  jobMaxAttempts: numberEnv('JOB_MAX_ATTEMPTS', 3),
  agingSeconds: numberEnv('AGING_SECONDS', 3600),
  tmpDir: process.env.TMP_DIR || '/tmp/swaparty-media-transcoder',
  originalCacheDir: path.join(process.env.TMP_DIR || '/tmp/swaparty-media-transcoder', 'original-cache'),
  ffmpegNice: process.env.FFMPEG_NICE !== '0',
  ffmpegThreads: Math.max(1, numberEnv('FFMPEG_THREADS', 2)),
  ffmpegPreset: stringEnv('FFMPEG_PRESET', 'ultrafast'),
  r2UploadConcurrency: Math.max(1, numberEnv('R2_UPLOAD_CONCURRENCY', 5)),
  realtimePublishUrl: optionalEnv('REALTIME_PUBLISH_URL'),
  realtimePublishToken: optionalEnv('REALTIME_PUBLISH_TOKEN'),
};

const s3 = new S3Client({
  region: 'auto',
  endpoint: config.r2Endpoint,
  credentials: {
    accessKeyId: config.r2AccessKeyId,
    secretAccessKey: config.r2SecretAccessKey,
  },
});

const activeJobs = new Set();
const originalDownloadPromises = new Map();
let stopping = false;

process.on('SIGINT', () => {
  stopping = true;
  log('shutdown requested by SIGINT');
});

process.on('SIGTERM', () => {
  stopping = true;
  log('shutdown requested by SIGTERM');
});

await mkdir(config.tmpDir, { recursive: true });
await mkdir(config.originalCacheDir, { recursive: true });
log(`started worker=${config.workerId} concurrency=${config.maxConcurrentFfmpeg}`);

while (!stopping) {
  try {
    await promoteAgedJobs();
    await fillWorkerSlots();
  } catch (error) {
    logError('poll loop failed', error);
  }
  await sleep(config.pollIntervalMs);
}

while (activeJobs.size > 0) {
  log(`waiting for ${activeJobs.size} active job(s) before shutdown`);
  await sleep(1000);
}

async function fillWorkerSlots() {
  const availableSlots = config.maxConcurrentFfmpeg - activeJobs.size;
  if (availableSlots <= 0) return;

  const deleteCandidates = await selectQueuedDeleteJobs(Math.max(availableSlots, config.claimBatchSize));
  for (const candidate of deleteCandidates) {
    if (activeJobs.size >= config.maxConcurrentFfmpeg) return;
    const claimed = await claimDeleteJob(candidate.id);
    if (!claimed) continue;

    const promise = processDeleteJob(claimed)
      .catch((error) => logError(`delete job ${claimed.id} crashed`, error))
      .finally(() => activeJobs.delete(promise));
    activeJobs.add(promise);
  }

  if (activeJobs.size >= config.maxConcurrentFfmpeg) return;

  const candidates = await selectQueuedJobs(Math.max(availableSlots, config.claimBatchSize));
  for (const candidate of candidates) {
    if (activeJobs.size >= config.maxConcurrentFfmpeg) return;
    const claimed = await claimJob(candidate.id);
    if (!claimed) continue;

    const promise = processJob(claimed)
      .catch((error) => logError(`job ${claimed.id} crashed`, error))
      .finally(() => activeJobs.delete(promise));
    activeJobs.add(promise);
  }
}

async function promoteAgedJobs() {
  const now = nowSec();
  const cutoff = now - config.agingSeconds;
  await d1Exec(
    `UPDATE transcode_jobs
     SET queue_level = CASE
           WHEN queue_level > 1 THEN queue_level - 1
           ELSE queue_level
         END,
         last_promoted_at = ?
     WHERE status = 'queued'
       AND queue_level > 1
       AND created_at < ?
       AND (last_promoted_at IS NULL OR last_promoted_at < ?)`,
    [now, cutoff, cutoff],
  );
}

async function selectQueuedDeleteJobs(limit) {
  const now = nowSec();
  const result = await d1Query(
    `SELECT id
     FROM media_delete_jobs
     WHERE status = 'queued'
       AND (locked_until IS NULL OR locked_until < ?)
     ORDER BY created_at ASC
     LIMIT ?`,
    [now, limit],
  );
  return result.results || [];
}

async function selectQueuedJobs(limit) {
  const now = nowSec();
  const result = await d1Query(
    `SELECT j.id
     FROM transcode_jobs j
     JOIN media_items m ON m.id = j.media_id
     WHERE j.status = 'queued'
       AND m.upload_status = 'uploaded'
       AND m.deleted_at IS NULL
       AND (j.locked_until IS NULL OR j.locked_until < ?)
     ORDER BY
       j.queue_level ASC,
       CASE
         WHEN m.playback_status IN ('mp4_ready', 'playable_base', 'playable_hd') THEN 0
         ELSE 1
       END DESC,
       j.estimated_work ASC,
       j.created_at ASC
     LIMIT ?`,
    [now, limit],
  );
  return result.results || [];
}

async function claimDeleteJob(jobId) {
  const now = nowSec();
  const lockUntil = now + config.jobLockSec;
  const update = await d1Exec(
    `UPDATE media_delete_jobs
     SET status = 'processing',
         locked_by = ?,
         locked_until = ?,
         attempts = attempts + 1,
         started_at = COALESCE(started_at, ?),
         error_message = NULL
     WHERE id = ?
       AND status = 'queued'
       AND (locked_until IS NULL OR locked_until < ?)`,
    [config.workerId, lockUntil, now, jobId, now],
  );

  if (!update.success || Number(update.meta?.changes || 0) === 0) return null;

  const result = await d1Query(
    `SELECT *
     FROM media_delete_jobs
     WHERE id = ?
     LIMIT 1`,
    [jobId],
  );
  return result.results?.[0] || null;
}

async function claimJob(jobId) {
  const now = nowSec();
  const lockUntil = now + config.jobLockSec;
  const update = await d1Exec(
    `UPDATE transcode_jobs
     SET status = 'processing',
         locked_by = ?,
         locked_until = ?,
         progress_percent = CASE
           WHEN progress_percent > 0 THEN progress_percent
           ELSE 0
         END,
         attempts = attempts + 1,
         started_at = COALESCE(started_at, ?),
         error_message = NULL
     WHERE id = ?
       AND status = 'queued'
       AND (locked_until IS NULL OR locked_until < ?)`,
    [config.workerId, lockUntil, now, jobId, now],
  );

  if (!update.success || Number(update.meta?.changes || 0) === 0) return null;

  const result = await d1Query(
    `SELECT j.*,
            m.title,
            m.user_id AS media_user_id,
            m.original_r2_key,
            m.thumbnail_r2_key,
            m.source_width,
            m.source_height,
            m.duration_sec,
            m.original_size_bytes,
            m.hls_size_bytes,
            m.thumbnail_size_bytes,
            m.processing_mode,
            m.playback_status,
            m.transcode_status
     FROM transcode_jobs j
     JOIN media_items m ON m.id = j.media_id
     WHERE j.id = ?
     LIMIT 1`,
    [jobId],
  );
  return result.results?.[0] || null;
}

async function processJob(job) {
  log(`job ${job.id} ${job.job_type} media=${job.media_id} attempts=${job.attempts}`);
  const workDir = path.join(config.tmpDir, `${job.id}-${Date.now()}`);
  const stopRenewLock = startLockRenewal({
    tableName: 'transcode_jobs',
    jobId: job.id,
    status: 'processing',
  });

  try {
    if (await isMediaDeleted(job.media_id, job.user_id)) {
      log(`job ${job.id} skipped because media=${job.media_id} is deleted`);
      return;
    }
    if (!job.original_r2_key) throw new Error('media item is missing original_r2_key');
    await mkdir(workDir, { recursive: true });
    const originalPath = await getCachedOriginalPath(job);

    if (await isMediaDeleted(job.media_id, job.user_id)) {
      log(`job ${job.id} stopped after download because media=${job.media_id} is deleted`);
      return;
    }

    if (job.job_type === 'probe') {
      await handleProbe(job, originalPath);
    } else if (job.job_type === 'thumbnail') {
      await handleThumbnail(job, originalPath, workDir);
    } else if (RENDITION_TARGETS[job.job_type]) {
      await handleRendition(job, originalPath, workDir, RENDITION_TARGETS[job.job_type]);
      await ensureDeferred1080pJob(job);
    } else {
      throw new Error(`unsupported job_type ${job.job_type}`);
    }

    if (await isMediaDeleted(job.media_id, job.user_id)) {
      log(`job ${job.id} finished work but media=${job.media_id} is deleted; skipping job_done publish`);
      return;
    }

    await markJobDone(job.id);
    await refreshMediaTranscodeStatus(job.media_id, job.user_id);
    await publishMediaUpdated(job, { reason: 'job_done' });
    log(`job ${job.id} done`);
  } catch (error) {
    await markJobFailedOrRetry(job, error);
  } finally {
    stopRenewLock();
    await rm(workDir, { recursive: true, force: true });
  }
}

async function processDeleteJob(job) {
  log(`delete job ${job.id} media=${job.media_id} attempts=${job.attempts}`);
  const stopRenewLock = startLockRenewal({
    tableName: 'media_delete_jobs',
    jobId: job.id,
    status: 'processing',
  });
  try {
    await removeCachedOriginal(job.media_id);
    await deleteR2Prefix(job.r2_prefix);

    await d1Exec(
      'DELETE FROM transcode_jobs WHERE media_id = ? AND user_id = ?',
      [job.media_id, job.user_id],
    );
    await d1Exec(
      'DELETE FROM media_renditions WHERE media_id = ?',
      [job.media_id],
    );
    await markDeleteJobDone(job.id);
    await d1Exec(
      'DELETE FROM media_items WHERE id = ? AND user_id = ?',
      [job.media_id, job.user_id],
    );

    await publishMediaUpdated(job, { reason: 'delete_cleaned' });
    log(`delete job ${job.id} done`);
  } catch (error) {
    await markDeleteJobFailedOrRetry(job, error);
  } finally {
    stopRenewLock();
  }
}

async function handleProbe(job, originalPath) {
  const probe = await ffprobe(originalPath);
  const videoStream = probe.streams.find((stream) => stream.codec_type === 'video') || {};
  const width = integerOrNull(videoStream.width) || integerOrNull(job.source_width);
  const height = integerOrNull(videoStream.height) || integerOrNull(job.source_height);
  const duration = numberOrNull(probe.format?.duration) || numberOrNull(job.duration_sec);
  const now = nowSec();

  const update = await d1Exec(
    `UPDATE media_items
     SET source_width = COALESCE(?, source_width),
         source_height = COALESCE(?, source_height),
         duration_sec = COALESCE(?, duration_sec),
         updated_at = ?
     WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    [width, height, duration, now, job.media_id, job.user_id],
  );
  if (Number(update.meta?.changes || 0) === 0) return;

  await ensureRenditionJobs(job, { sourceHeight: height, durationSec: duration });
}

async function handleThumbnail(job, originalPath, workDir) {
  const thumbPath = path.join(workDir, 'thumb.jpg');
  await runCommand('ffmpeg', [
    '-hide_banner',
    '-y',
    '-ss',
    '1',
    '-i',
    originalPath,
    '-frames:v',
    '1',
    '-vf',
    "scale='min(720,iw)':-2",
    '-q:v',
    '3',
    thumbPath,
  ]);

  if (await isMediaDeleted(job.media_id, job.user_id)) return;

  const key = `users/${job.user_id}/media/${job.media_id}/thumb/thumb.jpg`;
  await uploadR2File(key, thumbPath, 'image/jpeg', 'public, max-age=31536000, immutable');
  const thumbStat = await stat(thumbPath);
  const previousSize = Math.max(0, Number(job.thumbnail_size_bytes || 0));
  const nextSize = thumbStat.size;
  const delta = nextSize - previousSize;
  const now = nowSec();

  const update = await d1Exec(
    `UPDATE media_items
     SET thumbnail_r2_key = ?,
         thumbnail_size_bytes = ?,
         total_size_bytes = original_size_bytes + hls_size_bytes + ?,
         updated_at = ?
     WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    [key, nextSize, nextSize, now, job.media_id, job.user_id],
  );

  if (delta !== 0 && Number(update.meta?.changes || 0) > 0) {
    await d1Exec(
      `UPDATE user_media_quota
       SET used_storage_bytes = MAX(used_storage_bytes + ?, 0),
           updated_at = ?
       WHERE user_id = ?`,
      [delta, now, job.user_id],
    );
  }
}

async function handleRendition(job, originalPath, workDir, target) {
  const sourceHeight = Math.max(0, Number(job.source_height || 0));
  const outputHeight = sourceHeight > 0 ? Math.min(target.height, sourceHeight) : target.height;
  const safeHeight = Math.max(2, outputHeight - (outputHeight % 2));
  const label = `${safeHeight}p`;
  const renditionDir = path.join(workDir, label);
  await mkdir(renditionDir, { recursive: true });
  const publishProgress = createProgressPublisher(job);

  const playlistPath = path.join(renditionDir, 'index.m3u8');
  await runCommand('ffmpeg', [
    '-hide_banner',
    '-y',
    '-nostats',
    '-progress',
    'pipe:1',
    '-i',
    originalPath,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c:v',
    'libx264',
    '-preset',
    config.ffmpegPreset,
    '-threads',
    String(config.ffmpegThreads),
    '-crf',
    crfForHeight(safeHeight),
    '-vf',
    `scale=-2:${safeHeight}`,
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-f',
    'hls',
    '-hls_time',
    '6',
    '-hls_playlist_type',
    'vod',
    '-hls_segment_filename',
    path.join(renditionDir, 'seg_%05d.ts'),
    playlistPath,
  ], {
    onProgress: (progress) => publishProgress(progress),
    progressDurationSec: job.duration_sec,
  });

  if (await isMediaDeleted(job.media_id, job.user_id)) return;

  const prefix = `users/${job.user_id}/media/${job.media_id}/hls/${label}`;
  const { uploadedBytes } = await uploadDirectory(renditionDir, prefix, job);
  const playlistKey = `${prefix}/index.m3u8`;
  const masterKey = `users/${job.user_id}/media/${job.media_id}/hls/master.m3u8`;
  const now = nowSec();

  const previous = await d1Query(
    'SELECT size_bytes FROM media_renditions WHERE media_id = ? AND height = ? LIMIT 1',
    [job.media_id, safeHeight],
  );
  const previousSize = Math.max(0, Number(previous.results?.[0]?.size_bytes || 0));
  const delta = uploadedBytes - previousSize;

  await d1Exec(
    `INSERT INTO media_renditions
       (id, media_id, height, label, playlist_r2_key, size_bytes, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?)
     ON CONFLICT(media_id, height) DO UPDATE SET
       label = excluded.label,
       playlist_r2_key = excluded.playlist_r2_key,
       size_bytes = excluded.size_bytes,
       status = 'ready',
       updated_at = excluded.updated_at`,
    [crypto.randomUUID(), job.media_id, safeHeight, label, playlistKey, uploadedBytes, now, now],
  );

  const totalHlsSize = await sumReadyRenditionBytes(job.media_id);
  await writeMasterPlaylist(job.media_id, job.user_id, masterKey);

  const update = await d1Exec(
    `UPDATE media_items
     SET hls_master_key = ?,
         hls_size_bytes = ?,
         total_size_bytes = original_size_bytes + ? + thumbnail_size_bytes,
         playback_status = CASE
           WHEN ? >= 720 THEN 'playable_hd'
           ELSE 'playable_base'
         END,
         transcode_status = CASE
           WHEN transcode_status = 'ready' THEN 'ready'
           ELSE 'processing'
         END,
         updated_at = ?
     WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    [masterKey, totalHlsSize, totalHlsSize, safeHeight, now, job.media_id, job.user_id],
  );

  if (delta !== 0 && Number(update.meta?.changes || 0) > 0) {
    await d1Exec(
      `UPDATE user_media_quota
       SET used_storage_bytes = MAX(used_storage_bytes + ?, 0),
           updated_at = ?
       WHERE user_id = ?`,
      [delta, now, job.user_id],
    );
  }
}

async function ensureRenditionJobs(job, { sourceHeight, durationSec }) {
  const height = Math.max(0, Number(sourceHeight || 0));
  const jobs = [];
  if (height >= 480) jobs.push('base_480p');
  if (job.processing_mode !== 'full_quality') {
    await enqueueMissingRenditionJobs(job, jobs, { sourceHeight, durationSec });
    return;
  }
  if (height >= 720) jobs.push('enhance_720p');
  if (height >= 1080 && !shouldDeferAutomatic1080Job({ sourceHeight, durationSec, processingMode: job.processing_mode })) {
    jobs.push('enhance_1080p');
  }

  await enqueueMissingRenditionJobs(job, jobs, { sourceHeight, durationSec });
}

async function ensureDeferred1080pJob(job) {
  if (job.job_type !== 'enhance_720p') return;

  const sourceHeight = Math.max(0, Number(job.source_height || 0));
  const durationSec = Math.max(0, Number(job.duration_sec || 0));
  if (!shouldDeferAutomatic1080Job({ sourceHeight, durationSec, processingMode: job.processing_mode })) return;
  if (sourceHeight < 1080) return;

  const ready = await d1Query(
    `SELECT id
     FROM media_renditions
     WHERE media_id = ? AND height = 1080 AND status = 'ready'
     LIMIT 1`,
    [job.media_id],
  );
  if (ready.results?.length) return;

  const existing = await d1Query(
    `SELECT id, status
     FROM transcode_jobs
     WHERE media_id = ? AND user_id = ? AND job_type = 'enhance_1080p'
     ORDER BY created_at DESC
     LIMIT 1`,
    [job.media_id, job.user_id],
  );
  const existingJob = existing.results?.[0];
  if (existingJob && ['queued', 'processing', 'done'].includes(String(existingJob.status || ''))) return;

  const now = nowSec();
  const jobId = existingJob?.id || crypto.randomUUID();
  await d1Exec(
    existingJob
      ? `UPDATE transcode_jobs
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
         WHERE id = ?`
      : `INSERT INTO transcode_jobs
           (id, media_id, user_id, job_type, queue_level, status, estimated_work, progress_percent, attempts, created_at)
         VALUES (?, ?, ?, 'enhance_1080p', ?, 'queued', ?, 0, 0, ?)`,
    existingJob
      ? [JOB_LEVELS.enhance_1080p, estimateWork(durationSec, sourceHeight, 1080), jobId]
      : [jobId, job.media_id, job.user_id, JOB_LEVELS.enhance_1080p, estimateWork(durationSec, sourceHeight, 1080), now],
  );

  await d1Exec(
    `INSERT INTO media_renditions
       (id, media_id, height, label, status, created_at, updated_at)
     VALUES (?, ?, 1080, '1080p', 'queued', ?, ?)
     ON CONFLICT(media_id, height) DO UPDATE SET
       status = CASE
         WHEN media_renditions.status = 'ready' THEN media_renditions.status
         ELSE 'queued'
       END,
       updated_at = excluded.updated_at`,
    [crypto.randomUUID(), job.media_id, now, now],
  );
}

async function enqueueMissingRenditionJobs(job, jobs, { sourceHeight, durationSec }) {
  for (const jobType of jobs) {
    const existing = await d1Query(
      'SELECT id FROM transcode_jobs WHERE media_id = ? AND job_type = ? LIMIT 1',
      [job.media_id, jobType],
    );

    if (!existing.results?.length) {
      await d1Exec(
        `INSERT INTO transcode_jobs
          (id, media_id, user_id, job_type, queue_level, status, estimated_work, progress_percent, attempts, created_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, 0, ?)`,
        [
          crypto.randomUUID(),
          job.media_id,
          job.user_id,
          jobType,
          JOB_LEVELS[jobType],
          estimateWork(durationSec, sourceHeight, RENDITION_TARGETS[jobType].height),
          nowSec(),
        ],
      );
    }

    const target = RENDITION_TARGETS[jobType];
    await d1Exec(
      `INSERT INTO media_renditions
         (id, media_id, height, label, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?)
       ON CONFLICT(media_id, height) DO UPDATE SET
         status = CASE
           WHEN media_renditions.status = 'ready' THEN media_renditions.status
           ELSE 'queued'
         END,
         updated_at = excluded.updated_at`,
      [crypto.randomUUID(), job.media_id, target.height, target.label, nowSec(), nowSec()],
    );
  }
}

async function refreshMediaTranscodeStatus(mediaId, userId) {
  const pending = await d1Query(
    `SELECT
       SUM(CASE WHEN status IN ('queued', 'processing') THEN 1 ELSE 0 END) AS pending_count,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count
     FROM transcode_jobs
     WHERE media_id = ?`,
    [mediaId],
  );
  const row = pending.results?.[0] || {};
  const pendingCount = Number(row.pending_count || 0);
  const failedCount = Number(row.failed_count || 0);
  const nextStatus = pendingCount > 0 ? 'processing' : (failedCount > 0 ? 'failed' : 'ready');

  await d1Exec(
    `UPDATE media_items
     SET transcode_status = ?,
         updated_at = ?
     WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    [nextStatus, nowSec(), mediaId, userId],
  );

  if (nextStatus === 'ready' || nextStatus === 'failed') {
    await d1Exec(
      `UPDATE user_media_quota
       SET active_transcode_media_id = CASE
             WHEN active_transcode_media_id = ? THEN NULL
             ELSE active_transcode_media_id
           END,
           updated_at = ?
       WHERE user_id = ?`,
      [mediaId, nowSec(), userId],
    );
    await removeCachedOriginal(mediaId);
  }
}

async function isMediaDeleted(mediaId, userId) {
  const result = await d1Query(
    `SELECT deleted_at
     FROM media_items
     WHERE id = ? AND user_id = ?
     LIMIT 1`,
    [mediaId, userId],
  );
  const row = result.results?.[0];
  return !row || Boolean(row.deleted_at);
}

async function writeMasterPlaylist(mediaId, userId, masterKey) {
  const renditions = await d1Query(
    `SELECT height, label, playlist_r2_key
     FROM media_renditions
     WHERE media_id = ? AND status = 'ready'
     ORDER BY height ASC`,
    [mediaId],
  );
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  for (const rendition of renditions.results || []) {
    const height = Number(rendition.height || 0);
    const bandwidth = bandwidthForHeight(height);
    const relativePath = rendition.playlist_r2_key
      .replace(`users/${userId}/media/${mediaId}/hls/`, '');
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${widthForHeight(height)}x${height}`);
    lines.push(relativePath);
  }
  lines.push('');

  await uploadR2Buffer(masterKey, Buffer.from(lines.join('\n')), 'application/vnd.apple.mpegurl', 'public, max-age=60');
}

async function sumReadyRenditionBytes(mediaId) {
  const rows = await d1Query(
    `SELECT COALESCE(SUM(size_bytes), 0) AS size_bytes
     FROM media_renditions
     WHERE media_id = ? AND status = 'ready'`,
    [mediaId],
  );
  return Math.max(0, Number(rows.results?.[0]?.size_bytes || 0));
}

async function markJobDone(jobId) {
  const now = nowSec();
  await d1Exec(
    `UPDATE transcode_jobs
     SET status = 'done',
         progress_percent = 100,
         locked_by = NULL,
         locked_until = NULL,
         progress_updated_at = ?,
         finished_at = ?,
         error_message = NULL
     WHERE id = ?`,
    [now, now, jobId],
  );
}

async function markDeleteJobDone(jobId) {
  const now = nowSec();
  await d1Exec(
    `UPDATE media_delete_jobs
     SET status = 'done',
         locked_by = NULL,
         locked_until = NULL,
         finished_at = ?,
         error_message = NULL
     WHERE id = ?`,
    [now, jobId],
  );
}

async function markJobFailedOrRetry(job, error) {
  const attempts = Number(job.attempts || 0);
  const shouldRetry = attempts < config.jobMaxAttempts;
  const nextStatus = shouldRetry ? 'queued' : 'failed';
  const nextQueueLevel = shouldRetry ? Math.min(3, Number(job.queue_level || 0) + 1) : Number(job.queue_level || 0);
  const now = nowSec();
  const message = String(error?.message || error || 'transcode_failed').slice(0, 900);
  logError(`job ${job.id} ${shouldRetry ? 'will retry' : 'failed permanently'}: ${message}`, error);

  await d1Exec(
    `UPDATE transcode_jobs
     SET status = ?,
         queue_level = ?,
         progress_percent = CASE WHEN ? = 'queued' THEN 0 ELSE progress_percent END,
         locked_by = NULL,
         locked_until = NULL,
         progress_updated_at = ?,
         finished_at = CASE WHEN ? = 'failed' THEN ? ELSE finished_at END,
         error_message = ?
     WHERE id = ?`,
    [nextStatus, nextQueueLevel, nextStatus, now, nextStatus, now, message, job.id],
  );

  if (!shouldRetry) {
    await refreshMediaTranscodeStatus(job.media_id, job.user_id);
    await publishMediaUpdated(job, { reason: 'job_failed' });
  }
}

async function markDeleteJobFailedOrRetry(job, error) {
  const attempts = Number(job.attempts || 0);
  const shouldRetry = attempts < config.jobMaxAttempts;
  const nextStatus = shouldRetry ? 'queued' : 'failed';
  const now = nowSec();
  const message = String(error?.message || error || 'delete_failed').slice(0, 900);
  logError(`delete job ${job.id} ${shouldRetry ? 'will retry' : 'failed permanently'}: ${message}`, error);

  await d1Exec(
    `UPDATE media_delete_jobs
     SET status = ?,
         locked_by = NULL,
         locked_until = NULL,
         finished_at = CASE WHEN ? = 'failed' THEN ? ELSE finished_at END,
         error_message = ?
     WHERE id = ?`,
    [nextStatus, nextStatus, now, message, job.id],
  );
}

async function publishMediaUpdated(job, extraPayload = {}) {
  if (!config.realtimePublishUrl || !config.realtimePublishToken) return;

  try {
    const response = await fetch(config.realtimePublishUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.realtimePublishToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        type: 'media.updated',
        targets: [job.user_id],
        payload: {
          mediaId: job.media_id,
          jobType: job.job_type,
          ...extraPayload,
        },
        ts: Date.now(),
      }),
    });
    if (!response.ok) {
      log(`realtime publish media.updated failed status=${response.status}`);
    }
  } catch (error) {
    logError('realtime publish media.updated failed', error);
  }
}

function createProgressPublisher(job) {
  let lastPublishedAt = 0;
  let lastProgress = -1;

  return async (progress) => {
    const nextProgress = Math.max(0, Math.min(100, Math.floor(Number(progress || 0))));
    const now = Date.now();
    if (
      nextProgress < 100
      && lastProgress >= 0
      && nextProgress - lastProgress < PROGRESS_PUBLISH_MIN_DELTA
      && now - lastPublishedAt < PROGRESS_PUBLISH_MIN_INTERVAL_MS
    ) {
      return;
    }

    lastProgress = nextProgress;
    lastPublishedAt = now;
    await d1Exec(
      `UPDATE transcode_jobs
       SET progress_percent = ?,
           progress_updated_at = ?
       WHERE id = ?`,
      [nextProgress, nowSec(), job.id],
    );
    await publishMediaUpdated(job, {
      reason: 'job_progress',
      transcodeProgress: nextProgress,
    });
  };
}

async function deleteR2Prefix(prefix) {
  const safePrefix = String(prefix || '').trim();
  if (!safePrefix) return 0;

  let continuationToken;
  let deletedCount = 0;
  do {
    const result = await s3.send(new ListObjectsV2Command({
      Bucket: config.r2BucketName,
      Prefix: safePrefix,
      ContinuationToken: continuationToken,
    }));
    const objects = (result.Contents || [])
      .map((item) => ({ Key: item.Key }))
      .filter((item) => item.Key);

    if (objects.length > 0) {
      await s3.send(new DeleteObjectsCommand({
        Bucket: config.r2BucketName,
        Delete: {
          Objects: objects,
          Quiet: true,
        },
      }));
      deletedCount += objects.length;
    }

    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken);

  return deletedCount;
}

async function downloadR2Object(key, outputPath) {
  const result = await s3.send(new GetObjectCommand({
    Bucket: config.r2BucketName,
    Key: key,
  }));
  await pipeline(result.Body, createWriteStream(outputPath));
}

async function uploadR2File(key, filePath, contentType, cacheControl) {
  await s3.send(new PutObjectCommand({
    Bucket: config.r2BucketName,
    Key: key,
    Body: createReadStream(filePath),
    ContentType: contentType,
    CacheControl: cacheControl,
  }));
}

async function uploadR2Buffer(key, body, contentType, cacheControl) {
  await s3.send(new PutObjectCommand({
    Bucket: config.r2BucketName,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: cacheControl,
  }));
}

async function uploadDirectory(directory, keyPrefix, job = null) {
  const files = await collectUploadFiles(directory, keyPrefix);
  const uploadedBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  const startedAt = Date.now();
  const jobLabel = job ? ` job=${job.id} media=${job.media_id}` : '';

  log(`uploading ${files.length} HLS file(s)${jobLabel} bytes=${uploadedBytes} concurrency=${config.r2UploadConcurrency}`);

  await runWithConcurrency(files, config.r2UploadConcurrency, (file) => uploadR2File(
    file.key,
    file.filePath,
    file.contentType,
    'public, max-age=31536000, immutable',
  ));

  log(`uploaded ${files.length} HLS file(s)${jobLabel} bytes=${uploadedBytes} durationMs=${Date.now() - startedAt}`);

  return { uploadedBytes };
}

async function collectUploadFiles(directory, keyPrefix) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectUploadFiles(filePath, `${keyPrefix}/${entry.name}`);
      files.push(...nested);
      continue;
    }
    if (!entry.isFile()) continue;

    const fileStat = await stat(filePath);
    const contentType = entry.name.endsWith('.m3u8')
      ? 'application/vnd.apple.mpegurl'
      : (entry.name.endsWith('.ts') ? 'video/mp2t' : 'application/octet-stream');
    files.push({
      filePath,
      key: `${keyPrefix}/${entry.name}`,
      contentType,
      sizeBytes: fileStat.size,
    });
  }

  return files;
}

async function runWithConcurrency(items, limit, worker) {
  const concurrency = Math.max(1, Math.floor(Number(limit || 1)));
  let nextIndex = 0;

  async function runNext() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runNext(),
  );
  await Promise.all(workers);
}

async function ffprobe(inputPath) {
  const output = await runCommand('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    inputPath,
  ], { captureStdout: true, useNice: false });
  return JSON.parse(output || '{}');
}

async function getCachedOriginalPath(job) {
  const cacheKey = String(job.media_id || '').trim();
  if (!cacheKey) throw new Error('media item is missing id');

  const mediaCacheDir = path.join(config.originalCacheDir, cacheKey);
  const cachePath = path.join(mediaCacheDir, 'original');
  const existing = await getExistingFileSize(cachePath);
  if (existing > 0) {
    log(`original cache hit media=${job.media_id} bytes=${existing}`);
    return cachePath;
  }

  if (!originalDownloadPromises.has(cacheKey)) {
    originalDownloadPromises.set(cacheKey, downloadOriginalToCache(job, mediaCacheDir, cachePath)
      .finally(() => originalDownloadPromises.delete(cacheKey)));
  }

  await originalDownloadPromises.get(cacheKey);
  return cachePath;
}

async function downloadOriginalToCache(job, mediaCacheDir, cachePath) {
  await mkdir(mediaCacheDir, { recursive: true });
  const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  const startedAt = Date.now();
  log(`original cache miss media=${job.media_id}; downloading ${job.original_r2_key}`);
  try {
    await downloadR2Object(job.original_r2_key, tempPath);
    await rename(tempPath, cachePath);
    const sizeBytes = await getExistingFileSize(cachePath);
    log(`original cached media=${job.media_id} bytes=${sizeBytes} durationMs=${Date.now() - startedAt}`);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function removeCachedOriginal(mediaId) {
  const safeMediaId = String(mediaId || '').trim();
  if (!safeMediaId) return;
  originalDownloadPromises.delete(safeMediaId);
  await rm(path.join(config.originalCacheDir, safeMediaId), { recursive: true, force: true });
}

async function getExistingFileSize(filePath) {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile() ? Math.max(0, Number(fileStat.size || 0)) : 0;
  } catch {
    return 0;
  }
}

function startLockRenewal({ tableName, jobId, status }) {
  const safeTableName = tableName === 'media_delete_jobs' ? 'media_delete_jobs' : 'transcode_jobs';
  const safeJobId = String(jobId || '').trim();
  if (!safeJobId) return () => {};

  const intervalMs = Math.max(30000, Math.min(60000, Math.floor((config.jobLockSec * 1000) / 3)));
  let stopped = false;
  let running = false;

  async function renew() {
    if (stopped || running) return;
    running = true;
    try {
      await d1Exec(
        `UPDATE ${safeTableName}
         SET locked_until = ?
         WHERE id = ?
           AND status = ?
           AND locked_by = ?`,
        [nowSec() + config.jobLockSec, safeJobId, status, config.workerId],
      );
    } catch (error) {
      logError(`lock renewal failed job=${safeJobId}`, error);
    } finally {
      running = false;
    }
  }

  const timerId = setInterval(renew, intervalMs);
  if (typeof timerId.unref === 'function') timerId.unref();

  return () => {
    stopped = true;
    clearInterval(timerId);
  };
}

async function runCommand(command, args, options = {}) {
  const {
    captureStdout = false,
    useNice = config.ffmpegNice && command === 'ffmpeg',
    onProgress = null,
    progressDurationSec = 0,
  } = options;
  const finalCommand = useNice ? 'nice' : command;
  const finalArgs = useNice ? ['-n', '10', 'ionice', '-c2', '-n7', command, ...args] : args;

  return new Promise((resolve, reject) => {
    const child = spawn(finalCommand, finalArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let progressBuffer = '';
    const progressState = {};

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (captureStdout) stdout += text;
      if (typeof onProgress === 'function') {
        progressBuffer += text;
        const lines = progressBuffer.split(/\r?\n/);
        progressBuffer = lines.pop() || '';
        handleProgressLines(lines, progressDurationSec, onProgress, progressState);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`${command} exited with ${code}: ${stderr.slice(-1200)}`));
    });
  });
}

function handleProgressLines(lines, durationSec, onProgress, progressState) {
  const duration = Number(durationSec || 0);
  if (!Number.isFinite(duration) || duration <= 0) return;

  for (const line of lines) {
    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) continue;

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    progressState[key] = value;

    if (key !== 'progress') continue;

    const outTimeUs = Number(progressState.out_time_us || progressState.out_time_ms || 0);
    const ratio = value === 'end'
      ? 1
      : Math.max(0, Math.min(1, outTimeUs / 1000000 / duration));
    const progress = Math.max(0, Math.min(FFMPEG_PROGRESS_MAX_BEFORE_FINALIZE, Math.round(ratio * 100)));
    Promise.resolve(onProgress(progress)).catch((error) => {
      logError('ffmpeg progress publish failed', error);
    });
  }
}

async function d1Query(sql, params = []) {
  const payload = await d1Request(sql, params);
  const result = payload.result?.[0];
  if (!payload.success || !result?.success) {
    throw new Error(`D1 query failed: ${JSON.stringify(payload.errors || result?.error || payload)}`);
  }
  return result;
}

async function d1Exec(sql, params = []) {
  return d1Query(sql, params);
}

async function d1Request(sql, params) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${config.cloudflareAccountId}/d1/database/${config.d1DatabaseId}/query`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.cloudflareApiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sql, params }),
    },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Cloudflare D1 API ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

function estimateWork(durationSec, sourceHeight, targetHeight) {
  const duration = Math.max(1, Number(durationSec || 1));
  const source = Number(sourceHeight || 0);
  const sourceFactor = source >= 2160 ? 6 : (source >= 1080 ? 1.8 : 1);
  const targetFactor = targetHeight >= 1080 ? 2.4 : (targetHeight >= 720 ? 1.6 : 1);
  return duration * sourceFactor * targetFactor;
}

function shouldDeferAutomatic1080Job({ sourceHeight, durationSec, processingMode }) {
  const height = Number(sourceHeight || 0);
  const duration = Number(durationSec || 0);
  return processingMode === 'full_quality'
    && height > DEFER_1080P_SOURCE_HEIGHT
    && duration >= DEFER_1080P_DURATION_SEC;
}

function crfForHeight(height) {
  if (height >= 1080) return '23';
  if (height >= 720) return '24';
  return '25';
}

function bandwidthForHeight(height) {
  if (height >= 1080) return 4500000;
  if (height >= 720) return 2600000;
  return 1200000;
}

function widthForHeight(height) {
  return Math.max(2, Math.round((height * 16) / 9 / 2) * 2);
}

function integerOrNull(value) {
  const next = Math.floor(Number(value || 0));
  return Number.isFinite(next) && next > 0 ? next : null;
}

function numberOrNull(value) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? next : null;
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
}

function optionalEnv(name) {
  return String(process.env[name] || '').trim();
}

function stringEnv(name, fallback) {
  const value = String(process.env[name] || '').trim();
  return value || fallback;
}

function normalizeR2Endpoint(value) {
  const explicitEndpoint = String(value || '').trim().replace(/\/+$/, '');
  if (explicitEndpoint) return explicitEndpoint;
  const accountId = String(process.env.R2_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  if (!accountId) throw new Error('Missing required env R2_S3_ENDPOINT or R2_ACCOUNT_ID');
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function log(message) {
  console.log(`[media-transcoder] ${new Date().toISOString()} ${message}`);
}

function logError(message, error) {
  console.error(`[media-transcoder] ${new Date().toISOString()} ${message}`);
  if (error?.stack) console.error(error.stack);
}
