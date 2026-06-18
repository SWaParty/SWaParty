import { createId, hashToken, normalizeEmail, nowSec, validateEmail } from '../../../_lib/auth';
import { writeAuthAuditLog } from '../../../_lib/audit';
import { resolveEmailLocale, sendPasswordResetCodeEmail } from '../../../_lib/email';
import { error, json, readJson } from '../../../_lib/http';

const RESET_CODE_TTL_SEC = 600;

function normalizeLangTag(rawTag) {
  const tag = String(rawTag || '').trim().toLowerCase();
  if (!tag) return null;

  if (tag.startsWith('zh-cn') || tag.startsWith('zh-sg')) return 'zh-CN';
  if (tag.startsWith('zh-tw') || tag.startsWith('zh-hk') || tag.startsWith('zh-mo')) return 'zh-TW';
  if (tag.startsWith('ja')) return 'ja';
  if (tag.startsWith('ko')) return 'ko';
  if (tag.startsWith('en')) return 'en';
  return null;
}

function createSixDigitCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(n).padStart(6, '0');
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.DB) return error('DB binding is missing', 500);

  const body = await readJson(request);
  if (!body) return error('Invalid JSON body', 400);

  const email = normalizeEmail(body.email);
  if (!validateEmail(email)) return error('Invalid email', 400);

  const user = await env.DB
    .prepare(`SELECT id, email_verified_at, status FROM users WHERE email = ? LIMIT 1`)
    .bind(email)
    .first();
  if (!user || user.status !== 'active' || !user.email_verified_at) {
    await writeAuthAuditLog(env, {
      request,
      eventType: 'forgot_send_code_failed',
      email,
      metadata: { reason: 'user_not_eligible' },
    });
    return error('Email not found', 404);
  }

  const code = createSixDigitCode();
  const codeHash = await hashToken(code);
  const now = nowSec();
  const expiresAt = now + RESET_CODE_TTL_SEC;

  await env.DB.prepare(
    `INSERT INTO password_reset_requests
      (id, email, code_hash, code_expires_at, requested_at, status, attempts, request_ip, user_agent)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
  )
    .bind(
      createId(),
      email,
      codeHash,
      expiresAt,
      now,
      request.headers.get('CF-Connecting-IP') || null,
      request.headers.get('user-agent') || null,
    )
    .run();

  const preferredLocale = normalizeLangTag(body.locale);
  const locale = preferredLocale || resolveEmailLocale(request.headers.get('accept-language'));
  const mailErr = await sendPasswordResetCodeEmail(env, { to: email, code, locale });
  if (mailErr) return mailErr;

  await writeAuthAuditLog(env, {
    request,
    eventType: 'forgot_send_code_succeeded',
    email,
    userId: user.id,
  });

  return json({
    ok: true,
    message: 'Reset code sent',
    expiresInSec: RESET_CODE_TTL_SEC,
  });
}
