import { error, json } from '../../../_lib/http';
import { findUserBySessionToken, readSessionTokenFromRequest } from '../../../_lib/session';

async function requireSessionUser(context) {
  const { env, request } = context;
  const rawToken = readSessionTokenFromRequest(request);
  if (!rawToken) return null;
  const session = await findUserBySessionToken(env, rawToken);
  if (!session || session.status !== 'active') return null;
  return session;
}

export async function onRequestDelete(context) {
  const { env, params } = context;
  if (!env.DB) return error('DB binding is missing', 500);

  const session = await requireSessionUser(context);
  if (!session) return error('Unauthorized', 401);

  const messageId = String(params?.id || '').trim();
  if (!messageId) return error('Invalid inbox message id', 400);

  const result = await env.DB
    .prepare('DELETE FROM contact_inbox_messages WHERE id = ? AND user_id = ?')
    .bind(messageId, session.user_id)
    .run();

  return json({
    ok: true,
    removed: Number(result?.meta?.changes || 0) > 0,
  });
}
