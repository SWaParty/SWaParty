import { createId, createRawToken, hashToken, nowSec } from './auth';

const SESSION_COOKIE = 'swaparty_session';
const SESSION_TTL_SEC = 60 * 60 * 24 * 30;

function parseCookies(request) {
  const raw = request.headers.get('cookie') || '';
  const out = {};
  for (const pair of raw.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(value);
  }
  return out;
}

export function buildSessionSetCookie(token, requestUrl, maxAge = SESSION_TTL_SEC) {
  const secure = requestUrl.startsWith('https://');
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function buildClearSessionCookie(requestUrl) {
  return buildSessionSetCookie('', requestUrl, 0);
}

export function readSessionTokenFromRequest(request) {
  const cookies = parseCookies(request);
  return cookies[SESSION_COOKIE] || null;
}

export async function createUserSession(env, { userId, request }) {
  const now = nowSec();
  const expiresAt = now + SESSION_TTL_SEC;
  const rawToken = createRawToken();
  const tokenHash = await hashToken(rawToken);
  const sessionId = createId();

  await env.DB.prepare(
    `INSERT INTO user_sessions
      (id, user_id, refresh_token_hash, issued_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      sessionId,
      userId,
      tokenHash,
      now,
      expiresAt,
      request.headers.get('CF-Connecting-IP') || null,
      request.headers.get('user-agent') || null,
    )
    .run();

  return { rawToken, expiresAt };
}

export async function findUserBySessionToken(env, rawToken) {
  if (!rawToken) return null;
  const tokenHash = await hashToken(rawToken);
  const now = nowSec();
  return env.DB
    .prepare(
      `SELECT s.id AS session_id, s.user_id, s.expires_at, u.email, u.display_name, u.avatar_url, u.public_id, u.status, u.locale
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.refresh_token_hash = ?
         AND s.revoked_at IS NULL
         AND s.expires_at > ?
       LIMIT 1`,
    )
    .bind(tokenHash, now)
    .first();
}

export async function revokeSessionByToken(env, rawToken) {
  if (!rawToken) return;
  const tokenHash = await hashToken(rawToken);
  await env.DB
    .prepare(`UPDATE user_sessions SET revoked_at = ? WHERE refresh_token_hash = ? AND revoked_at IS NULL`)
    .bind(nowSec(), tokenHash)
    .run();
}
