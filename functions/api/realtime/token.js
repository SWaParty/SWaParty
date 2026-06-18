import { error, json } from '../../_lib/http';
import { findUserBySessionToken, readSessionTokenFromRequest } from '../../_lib/session';

const WS_TOKEN_TTL_SEC = 60 * 5;

function base64UrlEncode(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function signHs256(secret, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return base64UrlEncode(new Uint8Array(sig));
}

async function createRealtimeWsToken(secret, payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const enc = new TextEncoder();
  const h = base64UrlEncode(enc.encode(JSON.stringify(header)));
  const p = base64UrlEncode(enc.encode(JSON.stringify(payload)));
  const signingInput = `${h}.${p}`;
  const s = await signHs256(secret, signingInput);
  return `${signingInput}.${s}`;
}

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.DB) return error('DB binding is missing', 500);

  const secret = String(env.REALTIME_WS_JWT_SECRET || '').trim();
  if (!secret) return error('REALTIME_WS_JWT_SECRET is missing', 500);

  const rawToken = readSessionTokenFromRequest(request);
  if (!rawToken) return error('Unauthorized', 401);

  const session = await findUserBySessionToken(env, rawToken);
  if (!session || session.status !== 'active') return error('Unauthorized', 401);

  const now = Math.floor(Date.now() / 1000);
  const exp = now + WS_TOKEN_TTL_SEC;
  const token = await createRealtimeWsToken(secret, {
    sub: session.user_id,
    uid: session.user_id,
    iat: now,
    exp,
  });

  return json({
    ok: true,
    token,
    expiresAt: exp,
    ttlSec: WS_TOKEN_TTL_SEC,
  });
}

