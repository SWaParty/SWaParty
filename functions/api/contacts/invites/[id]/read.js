import { nowSec } from '../../../../_lib/auth';
import { error, json } from '../../../../_lib/http';
import { findUserBySessionToken, readSessionTokenFromRequest } from '../../../../_lib/session';

async function requireSessionUser(context) {
  const { env, request } = context;
  const rawToken = readSessionTokenFromRequest(request);
  if (!rawToken) return null;
  const session = await findUserBySessionToken(env, rawToken);
  if (!session || session.status !== 'active') return null;
  return session;
}

export async function onRequestPost(context) {
  const { env, params } = context;
  if (!env.DB) return error('DB binding is missing', 500);

  const session = await requireSessionUser(context);
  if (!session) return error('Unauthorized', 401);

  const inviteId = String(params?.id || '').trim();
  if (!inviteId) return error('Invalid invite id', 400);

  const now = nowSec();
  const result = await env.DB
    .prepare(
      `UPDATE contact_invites
       SET receiver_read_at = ?
       WHERE id = ? AND receiver_user_id = ?`,
    )
    .bind(now, inviteId, session.user_id)
    .run();

  return json({
    ok: true,
    updated: Number(result?.meta?.changes || 0) > 0,
    readAt: now,
  });
}

