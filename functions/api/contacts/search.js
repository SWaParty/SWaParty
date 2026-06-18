import { normalizeEmail } from '../../_lib/auth';
import { error, json } from '../../_lib/http';
import { findUserBySessionToken, readSessionTokenFromRequest } from '../../_lib/session';

function normalizePublicId(value) {
  return String(value || '').trim().toUpperCase();
}

function toSearchUser(row) {
  return {
    id: row.id,
    publicId: row.public_id || null,
    email: row.email,
    displayName: row.display_name || row.email.split('@')[0] || 'Guest',
    avatarUrl: row.avatar_url || null,
  };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.DB) return error('DB binding is missing', 500);

  const rawToken = readSessionTokenFromRequest(request);
  if (!rawToken) return error('Unauthorized', 401);
  const session = await findUserBySessionToken(env, rawToken);
  if (!session || session.status !== 'active') return error('Unauthorized', 401);

  const url = new URL(request.url);
  const q = String(url.searchParams.get('q') || '').trim();
  if (!q) return error('Missing query', 400);

  const emailQ = normalizeEmail(q);
  const publicIdQ = normalizePublicId(q);

  const selfMatched = session.email === emailQ
    || (session.public_id && String(session.public_id).toUpperCase() === publicIdQ);
  if (selfMatched) {
    return json({ ok: true, user: null, reason: 'self_search' });
  }

  const row = await env.DB
    .prepare(
      `SELECT id, public_id, email, display_name, avatar_url
       FROM users
       WHERE id <> ?
         AND (LOWER(email) = ? OR UPPER(public_id) = ?)
       LIMIT 1`,
    )
    .bind(session.user_id, emailQ, publicIdQ)
    .first();

  if (!row) {
    return json({ ok: true, user: null });
  }

  return json({
    ok: true,
    user: toSearchUser(row),
  });
}
