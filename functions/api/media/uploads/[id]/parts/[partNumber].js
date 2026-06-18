import { json, readJson } from '../../../../../_lib/http';
import {
  MAX_MEDIA_ORIGINAL_BYTES,
  mediaError,
  requireSessionUser,
} from '../../../../../_lib/media';

function parsePartNumber(value) {
  const next = Math.floor(Number(value || 0));
  return Number.isFinite(next) && next > 0 ? next : 0;
}

export async function onRequestPost(context) {
  const { env, params, request } = context;
  if (!env.DB) return mediaError('DB binding is missing', 500, 'missing_db_binding');

  const session = await requireSessionUser(context);
  if (!session) return mediaError('Unauthorized', 401, 'unauthorized');

  const mediaId = String(params?.id || '').trim();
  const partNumber = parsePartNumber(params?.partNumber);
  if (!mediaId) return mediaError('Invalid media id', 400, 'invalid_media_id');
  if (!partNumber) return mediaError('Invalid part number', 400, 'invalid_part_number');

  const body = await readJson(request);
  if (!body) return mediaError('Invalid JSON body', 400, 'invalid_json');

  const etag = String(body.etag || '').trim();
  const sizeBytes = Math.max(0, Math.floor(Number(body.sizeBytes || 0)));
  if (!etag || !sizeBytes || sizeBytes > MAX_MEDIA_ORIGINAL_BYTES) {
    return mediaError('Invalid uploaded part metadata', 400, 'invalid_upload_part_metadata');
  }

  const media = await env.DB
    .prepare(
      `SELECT id, user_id, upload_status, original_size_bytes,
              current_upload_session_id, upload_part_size_bytes, upload_parts_total
       FROM media_items
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL
       LIMIT 1`,
    )
    .bind(mediaId, session.user_id)
    .first();

  if (!media) return mediaError('Media item not found', 404, 'media_not_found');
  if (String(media.upload_status || '') !== 'uploading') {
    return mediaError('Media item is not accepting uploads', 409, 'invalid_upload_status');
  }
  if (!media.current_upload_session_id) {
    return mediaError('Media item is missing upload session', 409, 'missing_upload_session');
  }

  const uploadSession = await env.DB
    .prepare(
      `SELECT id, status, part_size_bytes, parts_total, bytes_total
       FROM media_upload_sessions
       WHERE id = ? AND media_id = ? AND user_id = ?
       LIMIT 1`,
    )
    .bind(media.current_upload_session_id, mediaId, session.user_id)
    .first();

  if (!uploadSession) return mediaError('Upload session not found', 404, 'upload_session_not_found');
  if (String(uploadSession.status || '') !== 'uploading') {
    return mediaError('Upload session is not accepting parts', 409, 'invalid_upload_session_status');
  }

  const totalParts = Math.max(0, Number(uploadSession.parts_total || media.upload_parts_total || 0));
  if (!totalParts || partNumber > totalParts) {
    return mediaError('Part number exceeds upload session size', 400, 'invalid_part_number');
  }

  const expectedPartSize = Math.max(1, Number(uploadSession.part_size_bytes || media.upload_part_size_bytes || 0));
  const totalBytes = Math.max(0, Number(uploadSession.bytes_total || media.original_size_bytes || 0));
  const remainingBytes = Math.max(0, totalBytes - expectedPartSize * (partNumber - 1));
  const maxAllowedBytes = partNumber === totalParts ? Math.max(1, remainingBytes) : expectedPartSize;
  if (sizeBytes > maxAllowedBytes || (partNumber !== totalParts && sizeBytes !== expectedPartSize)) {
    return mediaError('Upload part size does not match session plan', 400, 'invalid_upload_part_size');
  }

  const previousPart = await env.DB
    .prepare(
      `SELECT part_size_bytes
       FROM media_upload_parts
       WHERE upload_session_id = ? AND part_number = ?
       LIMIT 1`,
    )
    .bind(uploadSession.id, partNumber)
    .first();
  const previousPartSize = Math.max(0, Number(previousPart?.part_size_bytes || 0));
  const bytesDelta = sizeBytes - previousPartSize;
  const now = Math.floor(Date.now() / 1000);

  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO media_upload_parts
          (id, upload_session_id, media_id, part_number, part_size_bytes, etag, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'uploaded', ?, ?)
         ON CONFLICT(upload_session_id, part_number) DO UPDATE SET
           part_size_bytes = excluded.part_size_bytes,
           etag = excluded.etag,
           status = 'uploaded',
           error_message = NULL,
           updated_at = excluded.updated_at`,
      )
      .bind(crypto.randomUUID(), uploadSession.id, mediaId, partNumber, sizeBytes, etag, now, now),
    env.DB
      .prepare(
        `UPDATE media_upload_sessions
         SET parts_uploaded = (
               SELECT COUNT(*)
               FROM media_upload_parts
               WHERE upload_session_id = ?
                 AND status = 'uploaded'
             ),
             bytes_uploaded = MAX(bytes_uploaded + ?, 0),
             last_part_number = ?,
             error_message = NULL,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(uploadSession.id, bytesDelta, partNumber, now, uploadSession.id),
    env.DB
      .prepare(
        `UPDATE media_items
         SET upload_parts_uploaded = (
               SELECT COUNT(*)
               FROM media_upload_parts
               WHERE upload_session_id = ?
                 AND status = 'uploaded'
             ),
             upload_bytes_received = MAX(upload_bytes_received + ?, 0),
             upload_error_message = NULL,
             upload_updated_at = ?,
             updated_at = ?
         WHERE id = ? AND user_id = ?`,
      )
      .bind(uploadSession.id, bytesDelta, now, now, mediaId, session.user_id),
  ]);

  return json({
    ok: true,
    mediaId,
    uploadSessionId: uploadSession.id,
    partNumber,
    etag,
    sizeBytes,
  });
}
