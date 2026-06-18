import { error, json } from '../../../../_lib/http';
import { nowSec } from '../../../../_lib/auth';
import { findUserBySessionToken, readSessionTokenFromRequest } from '../../../../_lib/session';
import { buildTotpUri, createTotpSecret, encryptTotpSecret } from '../../../../_lib/mfa';
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

  const user = await env.DB
    .prepare(
      `SELECT
         u.id,
         u.email,
         CASE WHEN c.password_hash IS NULL THEN 0 ELSE 1 END AS has_password
       FROM users u
       LEFT JOIN auth_credentials c ON c.user_id = u.id
       WHERE u.id = ?
       LIMIT 1`,
    )
    .bind(session.user_id)
    .first();
  if (!user) return error('User not found', 404);
  if (!user.has_password) return error('Password must be set before enabling 2FA', 400);

  const secret = createTotpSecret();
  const encrypted = await encryptTotpSecret(env, secret);
  const now = nowSec();
  const issuer = 'SWaParty';
  const otpauthUri = buildTotpUri({ issuer, accountName: user.email, secret });
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=512x512&ecc=Q&qzone=2&data=${encodeURIComponent(otpauthUri)}`;

  await env.DB
    .prepare(
      `INSERT INTO auth_mfa_totp
        (user_id, enabled, secret_ciphertext, secret_kid, enrolled_at, last_verified_at, created_at, updated_at)
       VALUES (?, 0, ?, ?, NULL, NULL, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         enabled = 0,
         secret_ciphertext = excluded.secret_ciphertext,
         secret_kid = excluded.secret_kid,
         enrolled_at = NULL,
         last_verified_at = NULL,
         updated_at = excluded.updated_at`,
    )
    .bind(user.id, encrypted.secretCiphertext, encrypted.secretKid, now, now)
    .run();

  await env.DB
    .prepare('DELETE FROM auth_mfa_recovery_codes WHERE user_id = ?')
    .bind(user.id)
    .run();

  await writeAuthAuditLog(env, {
    request,
    eventType: 'mfa_totp_setup_started',
    email: user.email,
    userId: user.id,
  });

  return json({
    ok: true,
    secret,
    issuer,
    accountName: user.email,
    otpauthUri,
    qrCodeUrl,
  });
}
