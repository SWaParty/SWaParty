import { error, json } from '../../../../../_lib/http';
import { findUserBySessionToken, readSessionTokenFromRequest } from '../../../../../_lib/session';
import { decryptRecoveryCode } from '../../../../../_lib/mfa';
import { writeAuthAuditLog } from '../../../../../_lib/audit';

async function getSessionUser(context) {
  const rawToken = readSessionTokenFromRequest(context.request);
  if (!rawToken) return null;
  const session = await findUserBySessionToken(context.env, rawToken);
  if (!session || session.status !== 'active') return null;
  return session;
}

export async function onRequestGet(context) {
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

  const rows = await env.DB
    .prepare(
      `SELECT code_ciphertext
       FROM auth_mfa_recovery_codes
       WHERE user_id = ? AND used_at IS NULL
       ORDER BY created_at ASC`,
    )
    .bind(session.user_id)
    .all();

  const codes = [];
  for (const item of rows?.results || []) {
    if (!item?.code_ciphertext) continue;
    try {
      codes.push(await decryptRecoveryCode(env, item.code_ciphertext));
    } catch {
      // skip invalid ciphertext row
    }
  }

  await writeAuthAuditLog(env, {
    request,
    eventType: 'mfa_recovery_codes_viewed',
    email: session.email,
    userId: session.user_id,
    metadata: { count: codes.length },
  });

  return json({
    ok: true,
    recoveryCodes: codes,
  });
}

