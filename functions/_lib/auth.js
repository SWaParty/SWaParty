const PBKDF2_ITERATIONS = 100000;
const PBKDF2_HASH = 'SHA-256';
const SALT_LENGTH = 16;
const TOKEN_BYTES = 32;

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

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export function createId() {
  return crypto.randomUUID();
}

export function createPublicId() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `U${bytesToHex(bytes).toUpperCase()}`;
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function validatePassword(password) {
  return typeof password === 'string' && password.length >= 8;
}

export function getPasswordIssueCode(password) {
  const raw = typeof password === 'string' ? password : '';
  if (raw.length < 8) return 'password_too_short';
  if (/\s/.test(raw) || /[\u3400-\u9FFF]/.test(raw)) return 'password_invalid_chars';
  if (!/[a-z]/.test(raw) || !/[A-Z]/.test(raw) || !/\d/.test(raw)) return 'password_complexity';

  const normalized = raw.toLowerCase();
  const weakTokens = [
    'password',
    '123456',
    '12345678',
    'qwerty',
    'abc123',
    '111111',
    '000000',
    'iloveyou',
  ];
  if (weakTokens.some((token) => normalized.includes(token))) return 'password_too_weak';
  if (/^(.)\1+$/.test(raw)) return 'password_too_weak';

  return '';
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: PBKDF2_HASH },
    key,
    256,
  );
  const hash = new Uint8Array(bits);
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [algo, itersRaw, saltB64, hashB64] = String(stored).split('$');
    if (algo !== 'pbkdf2_sha256') return false;
    const iters = Number(itersRaw);
    if (!Number.isFinite(iters) || iters <= 0) return false;

    const salt = base64ToBytes(saltB64);
    const expected = base64ToBytes(hashB64);
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: iters, hash: PBKDF2_HASH },
      key,
      expected.byteLength * 8,
    );
    const actual = new Uint8Array(bits);
    if (actual.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < actual.length; i += 1) diff |= actual[i] ^ expected[i];
    return diff === 0;
  } catch {
    return false;
  }
}

export function createRawToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(token));
  return bytesToHex(new Uint8Array(digest));
}
