import { getLocale, setLocale } from '../i18n';

const CACHE_KEY = 'swaparty.user_cache.v1';
const CACHE_META_KEY = 'swaparty.user_cache.meta.v1';
const CACHE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7;

const SUPPORTED_LOCALES = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko'];

function normalizeLocale(raw) {
  const tag = String(raw || '').trim().toLowerCase();
  if (!tag) return null;
  if (tag.startsWith('zh-cn') || tag.startsWith('zh-sg')) return 'zh-CN';
  if (tag.startsWith('zh-tw') || tag.startsWith('zh-hk') || tag.startsWith('zh-mo')) return 'zh-TW';
  if (tag.startsWith('ja')) return 'ja';
  if (tag.startsWith('ko')) return 'ko';
  if (tag.startsWith('en')) return 'en';
  return null;
}

function resolveBrowserLocale() {
  if (typeof navigator === 'undefined') return 'en';
  const candidates = Array.isArray(navigator.languages) && navigator.languages.length > 0
    ? navigator.languages
    : [navigator.language];
  for (const candidate of candidates) {
    const normalized = normalizeLocale(candidate);
    if (normalized && SUPPORTED_LOCALES.includes(normalized)) return normalized;
  }
  return 'en';
}

function safeParse(jsonText) {
  try {
    return JSON.parse(String(jsonText || ''));
  } catch {
    return null;
  }
}

function readStorage(key) {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function removeStorage(key) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export function readCachedUser() {
  const raw = readStorage(CACHE_KEY);
  const parsed = safeParse(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  const cachedAt = Number(parsed.cachedAt || 0);
  if (!Number.isFinite(cachedAt) || cachedAt <= 0) return null;
  if (Date.now() - cachedAt > CACHE_MAX_AGE_MS) return null;
  const user = parsed.user;
  if (!user || typeof user !== 'object' || !user.id || !user.email) return null;
  return user;
}

export function writeCachedUser(user) {
  if (!user || typeof user !== 'object' || !user.id || !user.email) return;
  writeStorage(CACHE_KEY, JSON.stringify({
    user,
    cachedAt: Date.now(),
  }));
}

export function clearCachedUser() {
  removeStorage(CACHE_KEY);
  removeStorage(CACHE_META_KEY);
}

export function markUserCacheDirty(reason = 'unknown') {
  writeStorage(CACHE_META_KEY, JSON.stringify({
    dirty: true,
    reason,
    updatedAt: Date.now(),
  }));
}

export function clearUserCacheDirty() {
  writeStorage(CACHE_META_KEY, JSON.stringify({
    dirty: false,
    reason: '',
    updatedAt: Date.now(),
  }));
}

export function isUserCacheDirty() {
  const parsed = safeParse(readStorage(CACHE_META_KEY));
  return Boolean(parsed?.dirty);
}

export function applyLocaleWithFallback(localeFromServer) {
  const preferred = normalizeLocale(localeFromServer);
  if (preferred) {
    const ok = setLocale(preferred, { persist: true });
    if (ok) return preferred;
  }
  const browserLocale = resolveBrowserLocale();
  const browserOk = setLocale(browserLocale, { persist: true });
  if (browserOk) return browserLocale;
  setLocale('en', { persist: true });
  return getLocale();
}
