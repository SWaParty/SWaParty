import { error, json, readJson } from '../../_lib/http';
import {
  createId,
  createRawToken,
  hashPassword,
  hashToken,
  normalizeEmail,
  nowSec,
  validateEmail,
  validatePassword,
} from '../../_lib/auth';
import { resolveEmailLocale, sendVerifyEmail } from '../../_lib/email';
import { writeAuthAuditLog } from '../../_lib/audit';
import { normalizeLocale } from '../../_lib/locale';

function normalizeTheme(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'dark' || v === 'light') return v;
  return null;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.DB) return error('DB binding is missing', 500);

  const body = await readJson(request);
  if (!body) return error('Invalid JSON body', 400);

  const email = normalizeEmail(body.email);
  const password = String(body.password || '');
  const displayName = String(body.displayName || '').trim() || null;
  const preferredLocale = normalizeLocale(body.locale);
  const preferredTheme = normalizeTheme(body.theme);

  if (!validateEmail(email)) return error('Invalid email', 400);
  if (!validatePassword(password)) return error('Password must be at least 8 characters', 400);

  const existingUser = await env.DB
    .prepare('SELECT id FROM users WHERE email = ? LIMIT 1')
    .bind(email)
    .first();
  if (existingUser) {
    await writeAuthAuditLog(env, {
      request,
      eventType: 'register_conflict',
      email,
      metadata: { reason: 'email_exists' },
    });
    return error('Email already registered', 409);
  }

  const rawToken = createRawToken();
  const tokenHash = await hashToken(rawToken);
  const passwordHash = await hashPassword(password);
  const now = nowSec();
  const expiresAt = now + 1800;
  const signupId = createId();

  await env.DB.prepare(
    `INSERT INTO signup_requests
      (id, email, display_name, password_hash, token_hash, token_expires_at, requested_at, status, request_ip, user_agent, preferred_locale)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  )
    .bind(
      signupId,
      email,
      displayName,
      passwordHash,
      tokenHash,
      expiresAt,
      now,
      request.headers.get('CF-Connecting-IP') || null,
      request.headers.get('user-agent') || null,
      preferredLocale || null,
    )
    .run();

  const url = new URL(request.url);
  const verifyPageUrl = new URL('/verify', url.origin);
  verifyPageUrl.searchParams.set('token', rawToken);
  if (preferredLocale) verifyPageUrl.searchParams.set('lang', preferredLocale);
  if (preferredTheme) verifyPageUrl.searchParams.set('theme', preferredTheme);
  const verifyUrl = verifyPageUrl.toString();

  const locale = preferredLocale || resolveEmailLocale(request.headers.get('accept-language'));
  const mailErr = await sendVerifyEmail(env, { to: email, verifyUrl, locale });
  if (mailErr) {
    await writeAuthAuditLog(env, {
      request,
      eventType: 'register_mail_failed',
      email,
    });
    return mailErr;
  }

  await writeAuthAuditLog(env, {
    request,
    eventType: 'register_requested',
    email,
    metadata: { signupId, expiresAt },
  });

  return json({
    ok: true,
    message: 'Verification email sent',
    expiresInSec: 1800,
  });
}
