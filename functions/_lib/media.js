import { createId, nowSec } from './auth';
import { error } from './http';
import { findUserBySessionToken, readSessionTokenFromRequest } from './session';

export const MAX_MEDIA_ORIGINAL_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_MEDIA_STORAGE_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_MEDIA_DURATION_QUOTA_SEC = 120 * 60;
export const MEDIA_MULTIPART_PART_SIZE_BYTES = 16 * 1024 * 1024;
export const MEDIA_MULTIPART_MAX_CONCURRENCY = 4;

const PLAYABLE_MIME_TYPES = new Set([
  'video/mp4',
  'video/webm',
]);

export async function requireSessionUser(context) {
  const rawToken = readSessionTokenFromRequest(context.request);
  if (!rawToken) return null;
  const session = await findUserBySessionToken(context.env, rawToken);
  if (!session || session.status !== 'active') return null;
  return session;
}

export function mediaError(message, status = 400, code = 'media_failed', extra = {}) {
  return error(message, status, { errorCode: code, ...extra });
}

export function normalizeMediaTitle(value, fallback = 'Untitled video') {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) return fallback;
  return text.slice(0, 160);
}

export function normalizeMediaCategory(value) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  return text ? text.slice(0, 80) : null;
}

export function normalizeCategoryName(value) {
  return normalizeMediaCategory(value);
}

export function normalizeCategoryKey(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

export function normalizeMimeType(value) {
  return String(value || '').trim().toLowerCase().split(';')[0];
}

export function isBrowserPlayableMime(mimeType) {
  return PLAYABLE_MIME_TYPES.has(normalizeMimeType(mimeType));
}

export function sanitizeFilename(value) {
  const text = String(value || '').trim();
  const safe = text.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').slice(0, 180);
  return safe || `media-${Date.now()}`;
}

export function extFromFilename(filename, mimeType) {
  const match = String(filename || '').match(/\.([a-zA-Z0-9]{1,12})$/);
  if (match) return match[1].toLowerCase();
  const mime = normalizeMimeType(mimeType);
  if (mime === 'video/mp4') return 'mp4';
  if (mime === 'video/webm') return 'webm';
  if (mime === 'video/quicktime') return 'mov';
  return 'bin';
}

export function mediaOriginalKey({ userId, mediaId, filename, mimeType }) {
  const safeName = sanitizeFilename(filename);
  const ext = extFromFilename(safeName, mimeType);
  const base = safeName.replace(/\.[a-zA-Z0-9]{1,12}$/, '') || 'original';
  return `users/${userId}/media/${mediaId}/original/${base}.${ext}`;
}

export function normalizePublicOrigin(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

export function getMediaPublicOrigin(env) {
  return normalizePublicOrigin(env?.MEDIA_PUBLIC_ORIGIN || 'https://media.example.com');
}

export function mediaPublicUrl(env, key) {
  const cleanKey = String(key || '').replace(/^\/+/, '');
  return `${getMediaPublicOrigin(env)}/${cleanKey}`;
}

export function createMediaId() {
  return createId();
}

export function currentTimestamp() {
  return nowSec();
}

export function getMultipartPartCount(sizeBytes, partSizeBytes = MEDIA_MULTIPART_PART_SIZE_BYTES) {
  const size = Math.max(0, Math.floor(Number(sizeBytes || 0)));
  const partSize = Math.max(1, Math.floor(Number(partSizeBytes || MEDIA_MULTIPART_PART_SIZE_BYTES)));
  return size > 0 ? Math.ceil(size / partSize) : 0;
}
