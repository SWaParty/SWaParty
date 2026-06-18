import { error, json, readJson } from '../../_lib/http';
import { normalizeEmail, validateEmail, verifyPassword } from '../../_lib/auth';
import { buildSessionSetCookie, createUserSession } from '../../_lib/session';
import { writeAuthAuditLog } from '../../_lib/audit';
import { createLoginMfaChallenge } from '../../_lib/mfa';

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.DB) return error('DB binding is missing', 500);

  const body = await readJson(request);
  if (!body) return error('Invalid JSON body', 400);

  const email = normalizeEmail(body.email);
  const password = String(body.password || '');
  if (!validateEmail(email) || !password) {
    await writeAuthAuditLog(env, {
      request,
      eventType: 'login_failed',
      email,
      metadata: { reason: 'invalid_input' },
    });
    return error('Invalid email or password', 400);
  }

  const row = await env.DB
    .prepare(
      `SELECT u.id, u.email, u.display_name, u.status, u.email_verified_at, c.password_hash
              , u.avatar_url, u.public_id, u.locale
       FROM users u
       JOIN auth_credentials c ON c.user_id = u.id
       WHERE u.email = ?
       LIMIT 1`,
    )
    .bind(email)
    .first();

  if (!row) {
    await writeAuthAuditLog(env, { request, eventType: 'login_failed', email, metadata: { reason: 'user_not_found' } });
    return error('Invalid email or password', 401);
  }
  if (!row.email_verified_at) {
    await writeAuthAuditLog(env, { request, eventType: 'login_failed', email, metadata: { reason: 'email_not_verified' } });
    return error('Email is not verified', 403);
  }
  if (row.status !== 'active') {
    await writeAuthAuditLog(env, { request, eventType: 'login_failed', email, userId: row.id, metadata: { reason: 'status_inactive', status: row.status } });
    return error('Account is not active', 403);
  }

  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) {
    await writeAuthAuditLog(env, { request, eventType: 'login_failed', email, userId: row.id, metadata: { reason: 'password_mismatch' } });
    return error('Invalid email or password', 401);
  }

  const mfa = await env.DB
    .prepare(
      `SELECT enabled
       FROM auth_mfa_totp
       WHERE user_id = ?
       LIMIT 1`,
    )
    .bind(row.id)
    .first();

  if (mfa?.enabled) {
    const challenge = await createLoginMfaChallenge(env, { userId: row.id, purpose: 'login', ttlSec: 300 });
    await writeAuthAuditLog(env, {
      request,
      eventType: 'login_mfa_required',
      email,
      userId: row.id,
      metadata: { challengeId: challenge.challengeId, expiresAt: challenge.expiresAt },
    });

    return json({
      ok: true,
      requiresTwoFactor: true,
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt,
      user: {
        id: row.id,
        publicId: row.public_id || null,
        email: row.email,
        displayName: row.display_name,
        avatarUrl: row.avatar_url || null,
        locale: row.locale || 'en',
      },
    });
  }

  const { rawToken, expiresAt } = await createUserSession(env, { userId: row.id, request });
  const headers = new Headers();
  headers.append('Set-Cookie', buildSessionSetCookie(rawToken, request.url));

  await writeAuthAuditLog(env, {
    request,
    eventType: 'login_succeeded',
    email,
    userId: row.id,
    metadata: { expiresAt },
  });

  return json(
    {
      ok: true,
      message: 'Login successful',
      session: { expiresAt },
      user: {
        id: row.id,
        publicId: row.public_id || null,
        email: row.email,
        displayName: row.display_name,
        avatarUrl: row.avatar_url || null,
        locale: row.locale || 'en',
      },
    },
    { headers },
  );
}
