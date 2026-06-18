const enc = new TextEncoder();

function bytesToBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(input) {
  const normalized = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeJson(obj) {
  return bytesToBase64Url(enc.encode(JSON.stringify(obj)));
}

function decodeJson(payloadB64) {
  const bytes = base64UrlToBytes(payloadB64);
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function hmacSha256(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return bytesToBase64Url(new Uint8Array(sig));
}

export function normalizeRedirectBase(rawBase) {
  const base = String(rawBase || '').trim();
  if (!base) return null;
  try {
    const url = new URL(base);
    return `${url.origin}`;
  } catch {
    return null;
  }
}

export async function createOAuthStateToken(secret, payload) {
  const payloadB64 = encodeJson(payload);
  const signature = await hmacSha256(secret, payloadB64);
  return `${payloadB64}.${signature}`;
}

export async function verifyOAuthStateToken(secret, token) {
  const raw = String(token || '');
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return null;
  const payloadB64 = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = await hmacSha256(secret, payloadB64);
  if (sig !== expected) return null;
  try {
    return decodeJson(payloadB64);
  } catch {
    return null;
  }
}

