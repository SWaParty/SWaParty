import { writeAuthAuditLog } from '../../../_lib/audit';
import { createId, hashToken, normalizeEmail, nowSec, validateEmail } from '../../../_lib/auth';
import { resolvePreferredEmailLocale, sendEmailChangeCodeEmail } from '../../../_lib/email';
import { error, json, readJson } from '../../../_lib/http';
import { findUserBySessionToken, readSessionTokenFromRequest } from '../../../_lib/session';

function createNumericCode() {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(arr[0] % 1000000).padStart(6, '0');
}

async function getCurrentSessionUser(context) {
  const { request, env } = context;
  const rawToken = readSessionTokenFromRequest(request);
  if (!rawToken) return null;
  const session = await findUserBySessionToken(env, rawToken);
  if (!session || session.status !== 'active') return null;
  return session;
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return error('DB binding is missing', 500);

  const session = await getCurrentSessionUser(context);
  if (!session) return error('Unauthorized', 401);

  const body = await readJson(request);
  if (!body) return error('Invalid JSON body', 400);

  const newEmail = normalizeEmail(body.newEmail);
  if (!validateEmail(newEmail)) return error('Invalid email', 400);

  const user = await env.DB
    .prepare('SELECT id, email FROM users WHERE id = ? LIMIT 1')
    .bind(session.user_id)
    .first();
  if (!user) return error('User not found', 404);
  if (newEmail === user.email) return error('New email must be different', 400);

  const existingUser = await env.DB
    .prepare('SELECT id FROM users WHERE email = ? AND id <> ? LIMIT 1')
    .bind(newEmail, user.id)
    .first();
  if (existingUser) return error('Email already registered', 409);

  const now = nowSec();
  const code = createNumericCode();
  const codeHash = await hashToken(code);
  const requestId = createId();
  const expiresAt = now + 600;
  const locale = resolvePreferredEmailLocale(body.locale, request.headers.get('accept-language'));

  await env.DB.batch([
    env.DB
      .prepare(`UPDATE email_change_requests SET status = 'canceled', consumed_at = ? WHERE user_id = ? AND status = 'pending'`)
      .bind(now, user.id),
    env.DB
      .prepare(
        `INSERT INTO email_change_requests
          (id, user_id, new_email, token_hash, token_expires_at, requested_at, status, request_ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .bind(
        requestId,
        user.id,
        newEmail,
        codeHash,
        expiresAt,
        now,
        request.headers.get('CF-Connecting-IP') || null,
        request.headers.get('user-agent') || null,
      ),
  ]);

  const mailErr = await sendEmailChangeCodeEmail(env, {
    to: newEmail,
    code,
    locale,
  });
  if (mailErr) {
    await env.DB
      .prepare(`UPDATE email_change_requests SET status = 'failed', consumed_at = ? WHERE id = ?`)
      .bind(nowSec(), requestId)
      .run();
    await writeAuthAuditLog(env, {
      request,
      eventType: 'email_change_code_send_failed',
      email: user.email,
      userId: user.id,
      metadata: { newEmail, reason: 'mail_failed' },
    });
    return mailErr;
  }

  await writeAuthAuditLog(env, {
    request,
    eventType: 'email_change_code_sent',
    email: user.email,
    userId: user.id,
    metadata: { requestId, newEmail, expiresAt },
  });

  return json({
    ok: true,
    message: 'Verification code sent',
    expiresInSec: 600,
  });
}
