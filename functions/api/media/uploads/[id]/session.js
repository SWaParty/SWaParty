import { json } from '../../../../_lib/http';
import { requireSessionUser } from '../../../../_lib/media';
import { createMultipartUploadPartUrlMap, getMediaPresignConfig } from '../../../../_lib/r2Presign';

function clampPercent(value) {
  const next = Number(value);
  if (!Number.isFinite(next)) return 0;
  return Math.max(0, Math.min(100, next));
}

export async function onRequestGet(context) {
  const { env, params } = context;
  if (!env.DB) return json({ ok: false, error: 'DB binding is missing' }, { status: 500 });
  const presignConfig = getMediaPresignConfig(env);
  if (!presignConfig) return json({ ok: false, error: 'MEDIA presign config is missing' }, { status: 500 });

  const session = await requireSessionUser(context);
  if (!session) return json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const mediaId = String(params?.id || '').trim();
  if (!mediaId) return json({ ok: false, error: 'Invalid media id' }, { status: 400 });

  const media = await env.DB
    .prepare(
      `SELECT id, title, upload_status, current_upload_session_id, original_size_bytes,
              upload_bytes_received, upload_parts_total, upload_parts_uploaded, upload_updated_at
       FROM media_items
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL
       LIMIT 1`,
    )
    .bind(mediaId, session.user_id)
    .first();
  if (!media) return json({ ok: false, error: 'Media item not found' }, { status: 404 });

  if (String(media.upload_status || '') !== 'uploading' || !media.current_upload_session_id) {
    return json({ ok: true, session: null });
  }

  const uploadSession = await env.DB
    .prepare(
      `SELECT id, provider, provider_upload_id, object_key, status, part_size_bytes,
              parts_total, parts_uploaded, bytes_total, bytes_uploaded, last_part_number,
              error_message, expires_at, created_at, started_at, completed_at, updated_at
       FROM media_upload_sessions
       WHERE id = ? AND media_id = ? AND user_id = ?
       LIMIT 1`,
    )
    .bind(media.current_upload_session_id, mediaId, session.user_id)
    .first();
  if (!uploadSession) {
    return json({ ok: true, session: null });
  }
  if (String(uploadSession.status || '') !== 'uploading') {
    return json({ ok: true, session: null });
  }

  const uploadedPartsRows = await env.DB
    .prepare(
      `SELECT part_number
       FROM media_upload_parts
       WHERE upload_session_id = ?
         AND status = 'uploaded'
       ORDER BY part_number ASC`,
    )
    .bind(uploadSession.id)
    .all();
  const uploadedPartNumbers = (uploadedPartsRows?.results || [])
    .map((row) => Number(row?.part_number || 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  const signedPartUrls = await createMultipartUploadPartUrlMap({
    config: presignConfig,
    objectKey: uploadSession.object_key,
    uploadId: uploadSession.provider_upload_id,
    partsTotal: Number(uploadSession.parts_total || media.upload_parts_total || 0),
    excludePartNumbers: uploadedPartNumbers,
  });

  const totalBytes = Math.max(0, Number(uploadSession.bytes_total || media.original_size_bytes || 0));
  const uploadedBytes = Math.max(0, Number(uploadSession.bytes_uploaded || media.upload_bytes_received || 0));

  return json({
    ok: true,
    session: {
      mediaId,
      mediaTitle: String(media.title || '').trim() || 'Untitled video',
      uploadStatus: media.upload_status || 'uploading',
      uploadSessionId: uploadSession.id,
      provider: uploadSession.provider || 'r2_multipart',
      providerUploadId: uploadSession.provider_upload_id || '',
      objectKey: uploadSession.object_key || '',
      status: uploadSession.status || 'uploading',
      partSizeBytes: Number(uploadSession.part_size_bytes || 0),
      partsTotal: Number(uploadSession.parts_total || media.upload_parts_total || 0),
      partsUploaded: Number(uploadSession.parts_uploaded || media.upload_parts_uploaded || 0),
      uploadedPartNumbers,
      confirmPartUrlTemplate: `/api/media/uploads/${encodeURIComponent(mediaId)}/parts/{partNumber}`,
      signedPartUrls,
      bytesTotal: totalBytes,
      bytesUploaded: uploadedBytes,
      progressPercent: totalBytes > 0 ? clampPercent((uploadedBytes / totalBytes) * 100) : 0,
      lastPartNumber: Number(uploadSession.last_part_number || 0),
      errorMessage: uploadSession.error_message || null,
      expiresAt: uploadSession.expires_at || null,
      createdAt: uploadSession.created_at || null,
      startedAt: uploadSession.started_at || null,
      completedAt: uploadSession.completed_at || null,
      updatedAt: uploadSession.updated_at || media.upload_updated_at || null,
    },
  });
}
