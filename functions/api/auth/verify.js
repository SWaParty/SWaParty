import { createId, createPublicId, hashToken, nowSec } from '../../_lib/auth';
import { writeAuthAuditLog } from '../../_lib/audit';
import { buildSessionSetCookie, createUserSession } from '../../_lib/session';
import { error, json } from '../../_lib/http';
import { normalizeLocale, resolveLocaleFromAcceptLanguage } from '../../_lib/locale';

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.DB) return error('DB binding is missing', 500);

  const url = new URL(request.url);
  const rawToken = url.searchParams.get('token');
  if (!rawToken) return error('Missing token', 400);

  const tokenHash = await hashToken(rawToken);
  const reqRow = await env.DB
    .prepare(
      `SELECT id, email, display_name, password_hash, token_expires_at, status, consumed_at, preferred_locale
       FROM signup_requests
       WHERE token_hash = ? LIMIT 1`,
    )
    .bind(tokenHash)
    .first();

  if (!reqRow) {
    await writeAuthAuditLog(env, { request, eventType: 'verify_failed', metadata: { reason: 'token_not_found' } });
    return error('Invalid token', 400);
  }
  if (reqRow.status !== 'pending') {
    await writeAuthAuditLog(env, {
      request,
      eventType: 'verify_failed',
      email: reqRow.email,
      metadata: { reason: 'invalid_status', status: reqRow.status },
    });
    return error('Token already used or invalid', 400);
  }

  const now = nowSec();
  if (now > reqRow.token_expires_at) {
    await env.DB.prepare(`UPDATE signup_requests SET status = 'expired' WHERE id = ?`).bind(reqRow.id).run();
    await writeAuthAuditLog(env, {
      request,
      eventType: 'verify_failed',
      email: reqRow.email,
      metadata: { reason: 'expired' },
    });
    return error('Token expired', 400);
  }

  const existingUser = await env.DB
    .prepare('SELECT id FROM users WHERE email = ? LIMIT 1')
    .bind(reqRow.email)
    .first();
  if (existingUser) {
    await env.DB
      .prepare(`UPDATE signup_requests SET status = 'canceled', consumed_at = ? WHERE id = ?`)
      .bind(now, reqRow.id)
      .run();
    await writeAuthAuditLog(env, {
      request,
      eventType: 'verify_failed',
      email: reqRow.email,
      metadata: { reason: 'user_exists' },
    });
    return error('Email already registered', 409);
  }

  const userId = createId();
  const publicId = createPublicId();
  const identityId = createId();
  const localeFromQuery = normalizeLocale(url.searchParams.get('lang'));
  const locale = reqRow.preferred_locale || localeFromQuery || resolveLocaleFromAcceptLanguage(request.headers.get('accept-language'));

  try {
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO users (id, public_id, email, display_name, locale, status, email_verified_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .bind(userId, publicId, reqRow.email, reqRow.display_name, locale, now, now, now),
      env.DB
        .prepare(
          `INSERT INTO auth_credentials (user_id, password_hash, password_algo, password_updated_at, created_at)
           VALUES (?, ?, 'pbkdf2_sha256', ?, ?)`,
        )
        .bind(userId, reqRow.password_hash, now, now),
      env.DB
        .prepare(
          `INSERT INTO auth_identities (id, user_id, provider, provider_user_id, provider_email, provider_email_verified, linked_at, created_at)
           VALUES (?, ?, 'email', ?, ?, 1, ?, ?)`,
        )
        .bind(identityId, userId, reqRow.email, reqRow.email, now, now),
      env.DB
        .prepare(`UPDATE signup_requests SET status = 'verified', consumed_at = ? WHERE id = ?`)
        .bind(now, reqRow.id),
    ]);
  } catch {
    await writeAuthAuditLog(env, {
      request,
      eventType: 'verify_failed',
      email: reqRow.email,
      metadata: { reason: 'db_batch_error' },
    });
    return error('Verification failed. Please retry.', 500);
  }

  await writeAuthAuditLog(env, {
    request,
    eventType: 'verify_succeeded',
    email: reqRow.email,
    userId,
    metadata: { signupRequestId: reqRow.id },
  });

  const { rawToken: sessionToken, expiresAt } = await createUserSession(env, { userId, request });
  const headers = new Headers();
  headers.append('Set-Cookie', buildSessionSetCookie(sessionToken, request.url));

  return json({
    ok: true,
    message: 'Email verified. Registration completed.',
    session: { expiresAt },
    user: {
      id: userId,
      publicId,
      email: reqRow.email,
      displayName: reqRow.display_name,
      avatarUrl: null,
      locale,
    },
  }, { headers });
}
