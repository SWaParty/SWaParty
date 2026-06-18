import { json, readJson } from '../../_lib/http';
import { publishRealtimeEvent } from '../../_lib/realtime';
import {
  currentTimestamp,
  createMediaId,
  mediaError,
  normalizeCategoryKey,
  normalizeCategoryName,
  requireSessionUser,
} from '../../_lib/media';

function mapCategory(row) {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function onRequestGet(context) {
  const { env } = context;
  if (!env.DB) return mediaError('DB binding is missing', 500, 'missing_db_binding');

  const session = await requireSessionUser(context);
  if (!session) return mediaError('Unauthorized', 401, 'unauthorized');

  const rows = await env.DB
    .prepare(
      `SELECT id, name, sort_order, created_at, updated_at
       FROM media_categories
       WHERE user_id = ?
       ORDER BY sort_order ASC, created_at ASC`,
    )
    .bind(session.user_id)
    .all();

  const items = (rows?.results || []).map(mapCategory);
  return json({ ok: true, items, count: items.length });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return mediaError('DB binding is missing', 500, 'missing_db_binding');

  const session = await requireSessionUser(context);
  if (!session) return mediaError('Unauthorized', 401, 'unauthorized');

  const body = await readJson(request);
  if (!body) return mediaError('Invalid JSON body', 400, 'invalid_json');

  const name = normalizeCategoryName(body.name);
  const normalizedName = normalizeCategoryKey(name);
  if (!name || !normalizedName) return mediaError('Invalid category name', 400, 'invalid_category_name');

  const now = currentTimestamp();
  const sortOrderRaw = Number(body.sortOrder);
  const sortOrder = Number.isFinite(sortOrderRaw) ? Math.max(0, Math.floor(sortOrderRaw)) : now;
  const categoryId = createMediaId();

  try {
    await env.DB
      .prepare(
        `INSERT INTO media_categories
          (id, user_id, name, normalized_name, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(categoryId, session.user_id, name, normalizedName, sortOrder, now, now)
      .run();
  } catch {
    return mediaError('Category already exists', 409, 'category_exists');
  }
  await publishRealtimeEvent(env, {
    type: 'media.categories.updated',
    targets: [session.user_id],
    payload: {
      categoryId,
      name,
      reason: 'category_created',
    },
  }, { timeoutMs: 1500 });

  return json({
    ok: true,
    category: {
      id: categoryId,
      name,
      sortOrder,
      createdAt: now,
      updatedAt: now,
    },
  });
}
