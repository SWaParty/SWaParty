import { json, readJson } from '../../../_lib/http';
import { publishRealtimeEvent } from '../../../_lib/realtime';
import {
  currentTimestamp,
  mediaError,
  normalizeCategoryKey,
  normalizeCategoryName,
  requireSessionUser,
} from '../../../_lib/media';

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return mediaError('DB binding is missing', 500, 'missing_db_binding');

  const session = await requireSessionUser(context);
  if (!session) return mediaError('Unauthorized', 401, 'unauthorized');

  const body = await readJson(request);
  if (!body) return mediaError('Invalid JSON body', 400, 'invalid_json');

  const mediaIds = Array.isArray(body.mediaIds)
    ? Array.from(new Set(body.mediaIds.map((id) => String(id || '').trim()).filter(Boolean))).slice(0, 200)
    : [];
  if (mediaIds.length === 0) return mediaError('No media items selected', 400, 'empty_media_selection');

  const categoryName = normalizeCategoryName(body.category);
  const normalizedName = normalizeCategoryKey(categoryName);
  if (!categoryName || !normalizedName) return mediaError('Invalid category name', 400, 'invalid_category_name');

  const category = await env.DB
    .prepare('SELECT id, name FROM media_categories WHERE user_id = ? AND normalized_name = ? LIMIT 1')
    .bind(session.user_id, normalizedName)
    .first();
  if (!category) return mediaError('Category not found', 404, 'category_not_found');

  const now = currentTimestamp();
  const statements = mediaIds.map((mediaId) =>
    env.DB
      .prepare('UPDATE media_items SET category = ?, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
      .bind(category.name, now, mediaId, session.user_id),
  );

  await env.DB.batch(statements);
  await publishRealtimeEvent(env, {
    type: 'media.updated',
    targets: [session.user_id],
    payload: {
      mediaIds,
      category: category.name,
      reason: 'category_moved',
    },
  }, { timeoutMs: 1500 });

  return json({
    ok: true,
    category: category.name,
    updatedCount: mediaIds.length,
  });
}
