import { error, json } from '../../_lib/http';
import { findUserBySessionToken, readSessionTokenFromRequest } from '../../_lib/session';

async function requireSessionUser(context) {
  const { env, request } = context;
  const rawToken = readSessionTokenFromRequest(request);
  if (!rawToken) return null;
  const session = await findUserBySessionToken(env, rawToken);
  if (!session || session.status !== 'active') return null;
  return session;
}

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.DB) return error('DB binding is missing', 500);

  const session = await requireSessionUser(context);
  if (!session) return error('Unauthorized', 401);

  const url = new URL(request.url);
  const limitRaw = Number(url.searchParams.get('limit') || 100);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 100;

  const rows = await env.DB
    .prepare(
      `SELECT
         qc.id,
         qc.created_at,
         u.id AS user_id,
         u.public_id,
         u.email,
         u.display_name,
         u.avatar_url
       FROM quick_contacts qc
       JOIN users u ON u.id = qc.contact_user_id
       WHERE qc.user_id = ?
         AND u.status = 'active'
       ORDER BY qc.created_at DESC
       LIMIT ?`,
    )
    .bind(session.user_id, limit)
    .all();

  const items = (rows?.results || []).map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    user: {
      id: row.user_id,
      publicId: row.public_id || null,
      email: row.email,
      displayName: row.display_name || row.email.split('@')[0] || 'Guest',
      avatarUrl: row.avatar_url || null,
    },
  }));

  return json({
    ok: true,
    items,
    count: items.length,
  });
}

