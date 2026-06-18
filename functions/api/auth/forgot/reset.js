import { getPasswordIssueCode, hashPassword, hashToken, normalizeEmail, nowSec, validateEmail } from '../../../_lib/auth';
import { writeAuthAuditLog } from '../../../_lib/audit';
import { error, json, readJson } from '../../../_lib/http';

const MAX_ATTEMPTS = 5;

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.DB) return error('DB binding is missing', 500);

  const body = await readJson(request);
  if (!body) return error('Invalid JSON body', 400);

  const email = normalizeEmail(body.email);
  const code = String(body.code || '').trim();
  const newPassword = String(body.newPassword || '');
  if (!validateEmail(email)) return error('Invalid email', 400);
  if (!code) return error('Invalid code', 400);

  const reqRow = await env.DB
    .prepare(
      `SELECT id, code_hash, code_expires_at, status, attempts
       FROM password_reset_requests
       WHERE email = ?
       ORDER BY requested_at DESC
       LIMIT 1`,
    )
    .bind(email)
    .first();

  if (!reqRow || reqRow.status !== 'pending') {
    await writeAuthAuditLog(env, { request, eventType: 'forgot_reset_failed', email, metadata: { reason: 'missing_pending' } });
    return error('Invalid code or request', 400);
  }

  const now = nowSec();
  if (now > reqRow.code_expires_at) {
    await env.DB.prepare(`UPDATE password_reset_requests SET status = 'expired' WHERE id = ?`).bind(reqRow.id).run();
    await writeAuthAuditLog(env, { request, eventType: 'forgot_reset_failed', email, metadata: { reason: 'expired' } });
    return error('Code expired', 400);
  }
  if (reqRow.attempts >= MAX_ATTEMPTS) {
    await env.DB.prepare(`UPDATE password_reset_requests SET status = 'blocked' WHERE id = ?`).bind(reqRow.id).run();
    await writeAuthAuditLog(env, { request, eventType: 'forgot_reset_failed', email, metadata: { reason: 'too_many_attempts' } });
    return error('Too many attempts', 429);
  }

  const inputCodeHash = await hashToken(code);
  if (inputCodeHash !== reqRow.code_hash) {
    await env.DB
      .prepare(`UPDATE password_reset_requests SET attempts = attempts + 1, last_attempt_at = ? WHERE id = ?`)
      .bind(now, reqRow.id)
      .run();
    await writeAuthAuditLog(env, { request, eventType: 'forgot_reset_failed', email, metadata: { reason: 'code_mismatch' } });
    return error('Invalid code', 400);
  }

  const user = await env.DB.prepare(`SELECT id FROM users WHERE email = ? AND status = 'active' LIMIT 1`).bind(email).first();
  if (!user) {
    await writeAuthAuditLog(env, { request, eventType: 'forgot_reset_failed', email, metadata: { reason: 'user_not_found' } });
    return error('User not found', 404);
  }

  const passwordIssueCode = getPasswordIssueCode(newPassword);
  if (passwordIssueCode) {
    return error('Password validation failed', 400, {
      fieldErrors: [{ field: 'password', code: passwordIssueCode }],
    });
  }

  const passwordHash = await hashPassword(newPassword);

  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO auth_credentials
          (user_id, password_hash, password_algo, password_updated_at, created_at)
         VALUES (?, ?, 'pbkdf2_sha256', ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           password_hash = excluded.password_hash,
           password_algo = excluded.password_algo,
           password_updated_at = excluded.password_updated_at`,
      )
      .bind(user.id, passwordHash, now, now),
    env.DB
      .prepare(`UPDATE password_reset_requests SET status = 'used', consumed_at = ? WHERE id = ?`)
      .bind(now, reqRow.id),
    env.DB
      .prepare(`UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`)
      .bind(now, user.id),
  ]);

  await writeAuthAuditLog(env, {
    request,
    eventType: 'forgot_reset_succeeded',
    email,
    userId: user.id,
  });

  return json({
    ok: true,
    message: 'Password reset successful',
  });
}
