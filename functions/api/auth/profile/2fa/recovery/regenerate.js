import { error, json } from '../../../../../_lib/http';
import { findUserBySessionToken, readSessionTokenFromRequest } from '../../../../../_lib/session';
import { replaceRecoveryCodes } from '../../../../../_lib/mfa';
import { writeAuthAuditLog } from '../../../../../_lib/audit';

async function getSessionUser(context) {
  const rawToken = readSessionTokenFromRequest(context.request);
  if (!rawToken) return null;
  const session = await findUserBySessionToken(context.env, rawToken);
  if (!session || session.status !== 'active') return null;
  return session;
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return error('DB binding is missing', 500);

  const session = await getSessionUser(context);
  if (!session) return error('Unauthorized', 401);

  const mfa = await env.DB
    .prepare(
      `SELECT enabled
       FROM auth_mfa_totp
       WHERE user_id = ?
       LIMIT 1`,
    )
    .bind(session.user_id)
    .first();

  if (!mfa?.enabled) return error('2FA is not enabled', 400);

  const recoveryCodes = await replaceRecoveryCodes(env, session.user_id, { count: 9 });

  await writeAuthAuditLog(env, {
    request,
    eventType: 'mfa_recovery_codes_regenerated',
    email: session.email,
    userId: session.user_id,
    metadata: { count: recoveryCodes.length },
  });

  return json({
    ok: true,
    recoveryCodes,
  });
}
