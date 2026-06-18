const PROFILE_CACHE_PREFIX = 'swaparty.profile_meta_cache.v1:';
const PROFILE_CACHE_DIRTY_PREFIX = 'swaparty.profile_meta_cache_dirty.v1:';
const PROFILE_CACHE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7;

function safeParse(raw) {
  try {
    return JSON.parse(String(raw || ''));
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

export function getProfileMetaCacheKey(user) {
  const idPart = String(user?.id || '').trim();
  const emailPart = String(user?.email || '').trim().toLowerCase();
  if (idPart) return `id:${idPart}`;
  if (emailPart) return `email:${emailPart}`;
  return '';
}

function buildProfileCacheStorageKey(user) {
  const key = getProfileMetaCacheKey(user);
  if (!key) return '';
  return `${PROFILE_CACHE_PREFIX}${key}`;
}

function buildProfileDirtyStorageKey(user) {
  const key = getProfileMetaCacheKey(user);
  if (!key) return '';
  return `${PROFILE_CACHE_DIRTY_PREFIX}${key}`;
}

export function readCachedProfileMeta(user) {
  const storageKey = buildProfileCacheStorageKey(user);
  if (!storageKey) return null;
  const parsed = safeParse(readStorage(storageKey));
  if (!parsed || typeof parsed !== 'object') return null;
  const cachedAt = Number(parsed.cachedAt || 0);
  if (!Number.isFinite(cachedAt) || cachedAt <= 0) return null;
  if (Date.now() - cachedAt > PROFILE_CACHE_MAX_AGE_MS) return null;
  const meta = parsed.meta;
  if (!meta || typeof meta !== 'object') return null;
  if (!meta.id || !meta.email) return null;
  return meta;
}

export function writeCachedProfileMeta(user, meta) {
  if (!meta || typeof meta !== 'object' || !meta.id || !meta.email) return;
  const storageKey = buildProfileCacheStorageKey(user || meta);
  if (!storageKey) return;
  writeStorage(storageKey, JSON.stringify({
    cachedAt: Date.now(),
    meta,
  }));
}

export function clearCachedProfileMeta(user) {
  const storageKey = buildProfileCacheStorageKey(user);
  if (!storageKey) return;
  removeStorage(storageKey);
}

export function markProfileMetaCacheDirty(user, reason = 'unknown') {
  const storageKey = buildProfileDirtyStorageKey(user);
  if (!storageKey) return;
  writeStorage(storageKey, JSON.stringify({
    dirty: true,
    reason,
    updatedAt: Date.now(),
  }));
}

export function markProfileMetaCacheDirtyByEmail(email, reason = 'unknown') {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || typeof window === 'undefined') return;

  markProfileMetaCacheDirty({ email: normalizedEmail }, reason);

  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key || !key.startsWith(PROFILE_CACHE_PREFIX)) continue;
      const parsed = safeParse(window.localStorage.getItem(key));
      const meta = parsed?.meta;
      if (!meta || String(meta.email || '').trim().toLowerCase() !== normalizedEmail) continue;
      markProfileMetaCacheDirty(meta, reason);
    }
  } catch {
    // ignore
  }
}

export function clearProfileMetaCacheDirty(user) {
  const storageKey = buildProfileDirtyStorageKey(user);
  if (!storageKey) return;
  writeStorage(storageKey, JSON.stringify({
    dirty: false,
    reason: '',
    updatedAt: Date.now(),
  }));
}

export function isProfileMetaCacheDirty(user) {
  const storageKey = buildProfileDirtyStorageKey(user);
  if (!storageKey) return false;
  const parsed = safeParse(readStorage(storageKey));
  return Boolean(parsed?.dirty);
}
