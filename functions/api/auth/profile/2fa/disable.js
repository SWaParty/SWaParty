import { error, json, readJson } from '../../../../_lib/http';
import { nowSec } from '../../../../_lib/auth';
import { findUserBySessionToken, readSessionTokenFromRequest } from '../../../../_lib/session';
import { decryptTotpSecret, verifyTotpCode } from '../../../../_lib/mfa';
import { writeAuthAuditLog } from '../../../../_lib/audit';

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

  const body = await readJson(request);
  if (!body) return error('Invalid JSON body', 400);
  const code = String(body.code || '').trim();
  if (!/^\d{6}$/.test(code)) return error('Invalid code', 400);

  const row = await env.DB
    .prepare(
      `SELECT enabled, secret_ciphertext
       FROM auth_mfa_totp
       WHERE user_id = ?
       LIMIT 1`,
    )
    .bind(session.user_id)
    .first();
  if (!row?.enabled || !row?.secret_ciphertext) return error('2FA is not enabled', 400);

  let secret;
  try {
    secret = await decryptTotpSecret(env, row.secret_ciphertext);
  } catch {
    return error('2FA secret decrypt failed', 500);
  }

  const isValid = await verifyTotpCode({ secret, code });
  if (!isValid) {
    await writeAuthAuditLog(env, {
      request,
      eventType: 'mfa_totp_disable_failed',
      email: session.email,
      userId: session.user_id,
      metadata: { reason: 'code_mismatch' },
    });
    return error('Invalid code', 401);
  }

  const now = nowSec();
  const deleteResult = await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE auth_mfa_totp
         SET enabled = 0,
             secret_ciphertext = NULL,
             secret_kid = NULL,
             enrolled_at = NULL,
             last_verified_at = NULL,
             updated_at = ?
         WHERE user_id = ?`,
      )
      .bind(now, session.user_id),
    env.DB.prepare('DELETE FROM auth_mfa_recovery_codes WHERE user_id = ?').bind(session.user_id),
  ]);

  const deletedRecoveryCodes = Number(deleteResult?.[1]?.meta?.changes || 0);

  await writeAuthAuditLog(env, {
    request,
    eventType: 'mfa_totp_disabled',
    email: session.email,
    userId: session.user_id,
    metadata: { deletedRecoveryCodes },
  });

  return json({
    ok: true,
    twoFactorEnabled: false,
    recoveryCodesDestroyed: true,
    deletedRecoveryCodes,
  });
}
