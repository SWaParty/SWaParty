import { json } from '../../../_lib/http';
import { publishRealtimeEvent } from '../../../_lib/realtime';
import { currentTimestamp, mediaError, requireSessionUser } from '../../../_lib/media';

export async function onRequestDelete(context) {
  const { env, params } = context;
  if (!env.DB) return mediaError('DB binding is missing', 500, 'missing_db_binding');

  const session = await requireSessionUser(context);
  if (!session) return mediaError('Unauthorized', 401, 'unauthorized');

  const categoryId = String(params?.id || '').trim();
  if (!categoryId) return mediaError('Invalid category id', 400, 'invalid_category_id');

  const category = await env.DB
    .prepare('SELECT id, name FROM media_categories WHERE id = ? AND user_id = ? LIMIT 1')
    .bind(categoryId, session.user_id)
    .first();

  if (!category) return mediaError('Category not found', 404, 'category_not_found');

  const now = currentTimestamp();
  await env.DB.batch([
    env.DB
      .prepare('UPDATE media_items SET category = NULL, updated_at = ? WHERE user_id = ? AND category = ? AND deleted_at IS NULL')
      .bind(now, session.user_id, category.name),
    env.DB
      .prepare('DELETE FROM media_categories WHERE id = ? AND user_id = ?')
      .bind(categoryId, session.user_id),
  ]);
  await publishRealtimeEvent(env, {
    type: 'media.categories.updated',
    targets: [session.user_id],
    payload: {
      categoryId,
      name: category.name,
      reason: 'category_deleted',
    },
  }, { timeoutMs: 1500 });

  return json({ ok: true, deletedId: categoryId, deletedName: category.name });
}
