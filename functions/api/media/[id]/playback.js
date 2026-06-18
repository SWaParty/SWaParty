import { json } from '../../../_lib/http';
import { currentTimestamp, mediaError, mediaPublicUrl, requireSessionUser } from '../../../_lib/media';

export async function onRequestGet(context) {
  const { env, params } = context;
  if (!env.DB) return mediaError('DB binding is missing', 500, 'missing_db_binding');

  const session = await requireSessionUser(context);
  if (!session) return mediaError('Unauthorized', 401, 'unauthorized');

  const mediaId = String(params?.id || '').trim();
  if (!mediaId) return mediaError('Invalid media id', 400, 'invalid_media_id');

  const media = await env.DB
    .prepare(
      `SELECT id, user_id, title, playback_status, hls_master_key, original_r2_key,
              mime_type, browser_playable, source_width, source_height, duration_sec
       FROM media_items
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL
       LIMIT 1`,
    )
    .bind(mediaId, session.user_id)
    .first();

  if (!media) return mediaError('Media item not found', 404, 'media_not_found');

  let playbackType = '';
  let playbackUrl = '';
  if (media.hls_master_key && (media.playback_status === 'playable_base' || media.playback_status === 'playable_hd')) {
    playbackType = 'hls';
    playbackUrl = mediaPublicUrl(env, media.hls_master_key);
  } else if (media.browser_playable && media.original_r2_key) {
    playbackType = 'original';
    playbackUrl = mediaPublicUrl(env, media.original_r2_key);
  }

  if (!playbackUrl) {
    return mediaError('Media is not ready for playback', 409, 'media_not_playable', {
      playbackStatus: media.playback_status,
    });
  }

  const now = currentTimestamp();
  await env.DB
    .prepare('UPDATE media_items SET last_played_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .bind(now, now, mediaId, session.user_id)
    .run();

  const renditionRows = await env.DB
    .prepare(
      `SELECT height, label, playlist_r2_key, status
       FROM media_renditions
       WHERE media_id = ?
       ORDER BY height ASC`,
    )
    .bind(mediaId)
    .all();

  const originalPlaybackUrl = media.browser_playable && media.original_r2_key
    ? mediaPublicUrl(env, media.original_r2_key)
    : null;
  const masterPlaybackUrl = media.hls_master_key
    ? mediaPublicUrl(env, media.hls_master_key)
    : null;

  return json({
    ok: true,
    media: {
      id: media.id,
      title: media.title,
      playbackType,
      playbackUrl,
      mimeType: media.mime_type || '',
      width: media.source_width || null,
      height: media.source_height || null,
      durationSec: media.duration_sec ?? null,
      sources: {
        originalPlaybackUrl,
        masterPlaybackUrl,
        renditions: (renditionRows?.results || []).map((row) => ({
          height: Number(row.height || 0),
          label: row.label || `${row.height}p`,
          status: row.status || 'queued',
          playlistUrl: row.playlist_r2_key ? mediaPublicUrl(env, row.playlist_r2_key) : null,
        })),
      },
    },
  });
}
