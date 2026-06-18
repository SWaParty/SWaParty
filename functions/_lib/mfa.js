import { createId, nowSec } from './auth';

const TOTP_PERIOD_SEC = 30;
const TOTP_DIGITS = 6;
const TOTP_ALGO = 'SHA-1';
const TOTP_SECRET_BYTES = 20;
const MFA_KID = 'v1';
const enc = new TextEncoder();

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlEncode(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(input) {
  const normalized = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (normalized.length % 4)) % 4;
  return base64ToBytes(normalized + '='.repeat(padLength));
}

function base32Encode(bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(input) {
  const clean = String(input || '').toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
  if (!clean) return new Uint8Array(0);
  const map = new Map('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.split('').map((ch, idx) => [ch, idx]));
  let bits = 0;
  let value = 0;
  const out = [];
  for (let i = 0; i < clean.length; i += 1) {
    const v = map.get(clean[i]);
    if (typeof v !== 'number') throw new Error('Invalid base32 character');
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

function decodeOtpCode(code) {
  const digits = String(code || '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(digits)) return null;
  return digits;
}

function hotpFromDigest(digest, digits = TOTP_DIGITS) {
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  const mod = 10 ** digits;
  return String(binary % mod).padStart(digits, '0');
}

async function hmacCounter(secretBytes, counter, algorithm = TOTP_ALGO) {
  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: algorithm },
    false,
    ['sign'],
  );
  const data = new ArrayBuffer(8);
  const view = new DataView(data);
  const hi = Math.floor(counter / 2 ** 32);
  const lo = counter >>> 0;
  view.setUint32(0, hi, false);
  view.setUint32(4, lo, false);
  const sig = await crypto.subtle.sign('HMAC', key, data);
  return new Uint8Array(sig);
}

function getSecretMasterKey(env) {
  const raw = String(env?.MFA_TOTP_SECRET_KEY || '').trim();
  if (!raw) {
    throw new Error('MFA_TOTP_SECRET_KEY is missing');
  }
  return raw;
}

async function deriveAesKey(rawKey) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(rawKey));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encryptWithEnvKey(env, plaintext) {
  const key = await deriveAesKey(getSecretMasterKey(env));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(String(plaintext || '')),
  );
  const merged = new Uint8Array(iv.length + ciphertext.byteLength);
  merged.set(iv, 0);
  merged.set(new Uint8Array(ciphertext), iv.length);
  return base64UrlEncode(merged);
}

async function decryptWithEnvKey(env, payload) {
  const key = await deriveAesKey(getSecretMasterKey(env));
  const raw = base64UrlDecode(payload);
  if (raw.length <= 12) throw new Error('Invalid encrypted payload');
  const iv = raw.slice(0, 12);
  const body = raw.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, body);
  return new TextDecoder().decode(decrypted);
}

export function createTotpSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(TOTP_SECRET_BYTES));
  return base32Encode(bytes);
}

export function buildTotpUri({ issuer, accountName, secret }) {
  const safeIssuer = String(issuer || '').trim() || 'SWaParty';
  const safeAccount = String(accountName || '').trim() || 'account';
  const label = `${safeIssuer}:${safeAccount}`;
  const params = new URLSearchParams({
    secret: String(secret || '').replace(/\s+/g, ''),
    issuer: safeIssuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SEC),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

export async function encryptTotpSecret(env, plainSecret) {
  return {
    secretCiphertext: await encryptWithEnvKey(env, String(plainSecret || '').replace(/\s+/g, '')),
    secretKid: MFA_KID,
  };
}

export async function decryptTotpSecret(env, ciphertext) {
  return decryptWithEnvKey(env, ciphertext);
}

export async function verifyTotpCode({ secret, code, atSec = nowSec(), periodSec = TOTP_PERIOD_SEC, window = 1 }) {
  const normalizedCode = decodeOtpCode(code);
  if (!normalizedCode) return false;
  const secretBytes = base32Decode(secret);
  if (!secretBytes.length) return false;
  const counter = Math.floor(atSec / periodSec);
  for (let i = -window; i <= window; i += 1) {
    const digest = await hmacCounter(secretBytes, counter + i);
    const candidate = hotpFromDigest(digest, TOTP_DIGITS);
    if (candidate === normalizedCode) return true;
  }
  return false;
}

export async function createLoginMfaChallenge(env, { userId, sessionId = null, purpose = 'login', ttlSec = 300 }) {
  const now = nowSec();
  const challengeId = createId();
  const expiresAt = now + ttlSec;
  await env.DB.prepare(
    `INSERT INTO auth_mfa_challenges
      (id, user_id, session_id, purpose, expires_at, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
  )
    .bind(challengeId, userId, sessionId, purpose, expiresAt, now)
    .run();

  return { challengeId, expiresAt };
}

function createRecoveryCode() {
  const bytes = crypto.getRandomValues(new Uint32Array(1));
  const value = Number(bytes[0] % 100000000);
  return String(value).padStart(8, '0');
}

async function hashRecoveryCode(plainCode) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(plainCode));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function replaceRecoveryCodes(env, userId, { count = 8 } = {}) {
  const now = nowSec();
  const unique = new Set();
  while (unique.size < count) unique.add(createRecoveryCode());
  const plainCodes = Array.from(unique);
  const inserts = await Promise.all(
    plainCodes.map(async (plain) => {
      const hash = await hashRecoveryCode(plain);
      const ciphertext = await encryptWithEnvKey(env, plain);
      return env.DB
        .prepare(
          `INSERT INTO auth_mfa_recovery_codes
            (id, user_id, code_hash, code_ciphertext, used_at, created_at)
           VALUES (?, ?, ?, ?, NULL, ?)`,
        )
        .bind(createId(), userId, hash, ciphertext, now);
    }),
  );

  await env.DB.batch([
    env.DB.prepare('DELETE FROM auth_mfa_recovery_codes WHERE user_id = ?').bind(userId),
    ...inserts,
  ]);

  return plainCodes;
}

export async function appendRecoveryCodes(env, userId, { count = 1 } = {}) {
  const targetCount = Math.max(0, Number(count) || 0);
  if (targetCount <= 0) return [];

  const now = nowSec();
  const created = [];

  for (let i = 0; i < targetCount; i += 1) {
    let inserted = false;
    let attempt = 0;
    while (!inserted && attempt < 8) {
      attempt += 1;
      const plain = createRecoveryCode();
      const hash = await hashRecoveryCode(plain);
      const ciphertext = await encryptWithEnvKey(env, plain);
      const rowId = createId();
      const resp = await env.DB
        .prepare(
          `INSERT OR IGNORE INTO auth_mfa_recovery_codes
            (id, user_id, code_hash, code_ciphertext, used_at, created_at)
           VALUES (?, ?, ?, ?, NULL, ?)`,
        )
        .bind(rowId, userId, hash, ciphertext, now)
        .run();
      if ((resp?.meta?.changes || 0) > 0) {
        inserted = true;
        created.push(plain);
      }
    }
  }

  return created;
}

export async function decryptRecoveryCode(env, ciphertext) {
  return decryptWithEnvKey(env, ciphertext);
}
