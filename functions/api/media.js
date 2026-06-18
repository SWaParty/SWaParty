import { json } from '../_lib/http';
import { mediaPublicUrl, requireSessionUser } from '../_lib/media';

function mapMediaItem(env, row) {
  const originalPlaybackUrl = row.browser_playable && row.original_r2_key
    ? mediaPublicUrl(env, row.original_r2_key)
    : null;
  const masterPlaybackUrl = row.hls_master_key
    ? mediaPublicUrl(env, row.hls_master_key)
    : null;
  const playbackUrl = row.hls_master_key
    ? masterPlaybackUrl
    : originalPlaybackUrl;

  return {
    id: row.id,
    title: row.title,
    category: row.category || '',
    sourceType: row.source_type,
    uploadStatus: row.upload_status,
    playbackStatus: row.playback_status,
    transcodeStatus: row.transcode_status,
    processingMode: row.processing_mode || null,
    mimeType: row.mime_type || '',
    width: row.source_width || null,
    height: row.source_height || null,
    durationSec: row.duration_sec ?? null,
    originalSizeBytes: row.original_size_bytes || 0,
    totalSizeBytes: row.total_size_bytes || 0,
    browserPlayable: Boolean(row.browser_playable),
    starred: Boolean(row.starred),
    starredAt: row.starred_at || null,
    thumbnailUrl: row.thumbnail_r2_key ? mediaPublicUrl(env, row.thumbnail_r2_key) : null,
    originalPlaybackUrl,
    masterPlaybackUrl,
    playbackUrl,
    lastPlayedAt: row.last_played_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    renditions: [],
  };
}

function attachRenditions(env, items, renditionRows) {
  const byMediaId = new Map();
  for (const row of renditionRows || []) {
    const mediaId = String(row.media_id || '');
    if (!mediaId) continue;
    const list = byMediaId.get(mediaId) || [];
    list.push({
      height: Number(row.height || 0),
      label: row.label || `${row.height}p`,
      status: row.status || 'queued',
      sizeBytes: row.size_bytes || 0,
      playlistUrl: row.playlist_r2_key ? mediaPublicUrl(env, row.playlist_r2_key) : null,
      updatedAt: row.updated_at || null,
    });
    byMediaId.set(mediaId, list);
  }

  return items.map((item) => ({
    ...item,
    renditions: (byMediaId.get(item.id) || []).sort((a, b) => a.height - b.height),
  }));
}

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.DB) return json({ ok: false, error: 'DB binding is missing' }, { status: 500 });

  const session = await requireSessionUser(context);
  if (!session) return json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const url = new URL(request.url);
  const limitRaw = Number(url.searchParams.get('limit') || 100);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 100;

  const rows = await env.DB
    .prepare(
      `SELECT *
       FROM media_items
       WHERE user_id = ?
         AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .bind(session.user_id, limit)
    .all();

  const items = (rows?.results || []).map((row) => mapMediaItem(env, row));
  if (items.length > 0) {
    const placeholders = items.map(() => '?').join(', ');
    const renditionRows = await env.DB
      .prepare(
        `SELECT media_id, height, label, playlist_r2_key, size_bytes, status, updated_at
         FROM media_renditions
         WHERE media_id IN (${placeholders})`,
      )
      .bind(...items.map((item) => item.id))
      .all();

    return json({ ok: true, items: attachRenditions(env, items, renditionRows?.results || []), count: items.length });
  }

  return json({ ok: true, items, count: items.length });
}
