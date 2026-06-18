const CONTACTS_CACHE_TTL_MS = 60 * 1000;
const INVITE_HISTORY_CACHE_TTL_MS = 60 * 1000;
const CONTACTS_FORCE_MIN_INTERVAL_MS = 4000;

const runtimeCache = {
  contacts: [],
  contactsLoaded: false,
  contactsAt: 0,
  contactsInFlight: null,
  contactsLastForceAt: 0,
  inviteHistory: [],
  inviteHistoryLoaded: false,
  inviteHistoryAt: 0,
};

export const CONTACTS_CHANGED_EVENT = 'swaparty-contacts-changed';
export const CONTACTS_RUNTIME_UPDATED_EVENT = 'swaparty-contacts-runtime-updated';

export function publishContactsChanged(detail = {}) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(CONTACTS_CHANGED_EVENT, {
    detail: detail && typeof detail === 'object' ? detail : {},
  }));
}

export function publishContactsRuntimeUpdated(detail = {}) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(CONTACTS_RUNTIME_UPDATED_EVENT, {
    detail: detail && typeof detail === 'object' ? detail : {},
  }));
}

function isFresh(timestamp, ttlMs) {
  return Number(timestamp) > 0 && (Date.now() - Number(timestamp)) <= ttlMs;
}

export function getCachedContacts() {
  return runtimeCache.contacts;
}

export function hasCachedContacts() {
  return runtimeCache.contactsLoaded;
}

export function isCachedContactsFresh() {
  return runtimeCache.contactsLoaded && isFresh(runtimeCache.contactsAt, CONTACTS_CACHE_TTL_MS);
}

export function setCachedContacts(items) {
  runtimeCache.contacts = Array.isArray(items) ? items : [];
  runtimeCache.contactsLoaded = true;
  runtimeCache.contactsAt = Date.now();
  publishContactsRuntimeUpdated({ contacts: runtimeCache.contacts });
}

export function getCachedInviteHistory() {
  return runtimeCache.inviteHistory;
}

export function hasCachedInviteHistory() {
  return runtimeCache.inviteHistoryLoaded;
}

export function isCachedInviteHistoryFresh() {
  return runtimeCache.inviteHistoryLoaded && isFresh(runtimeCache.inviteHistoryAt, INVITE_HISTORY_CACHE_TTL_MS);
}

export function setCachedInviteHistory(items) {
  runtimeCache.inviteHistory = Array.isArray(items) ? items : [];
  runtimeCache.inviteHistoryLoaded = true;
  runtimeCache.inviteHistoryAt = Date.now();
}

function buildAvatarGradient(seed) {
  const gradients = [
    'from-sky-400 to-blue-500',
    'from-indigo-400 to-indigo-500',
    'from-cyan-400 to-blue-500',
    'from-emerald-400 to-teal-500',
    'from-violet-400 to-indigo-500',
  ];
  const raw = String(seed || '');
  const hash = raw.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return gradients[hash % gradients.length];
}

export function mapQuickContactUser(user) {
  const name = String(user?.displayName || '').trim() || String(user?.email || '').split('@')[0] || 'U';
  return {
    id: user?.id,
    publicId: user?.publicId || null,
    email: user?.email || '',
    name,
    avatarUrl: user?.avatarUrl || null,
    initial: name.charAt(0).toUpperCase(),
    bg: buildAvatarGradient(user?.publicId || user?.email || name),
  };
}

export async function prefetchContactsCache({ force = false, limit = 200 } = {}) {
  const nowMs = Date.now();
  if (runtimeCache.contactsInFlight) return runtimeCache.contactsInFlight;
  if (!force && isCachedContactsFresh()) {
    return getCachedContacts();
  }
  if (force && runtimeCache.contactsLoaded && (nowMs - runtimeCache.contactsLastForceAt) < CONTACTS_FORCE_MIN_INTERVAL_MS) {
    return getCachedContacts();
  }

  const task = (async () => {
    try {
      const resp = await fetch(`/api/contacts/list?limit=${encodeURIComponent(limit)}`, { credentials: 'include' });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok || !Array.isArray(data.items)) {
        return getCachedContacts();
      }

      const mapped = data.items.map((item) => ({
        relationId: item.id,
        createdAt: item.createdAt,
        ...mapQuickContactUser(item.user || {}),
      }));
      setCachedContacts(mapped);
      if (force) {
        runtimeCache.contactsLastForceAt = Date.now();
      }
      return mapped;
    } catch {
      return getCachedContacts();
    } finally {
      runtimeCache.contactsInFlight = null;
    }
  })();

  runtimeCache.contactsInFlight = task;
  return task;
}
