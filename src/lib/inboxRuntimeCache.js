const INBOX_REFRESH_MIN_INTERVAL_MS = 10000;

export const INVITES_CHANGED_EVENT = 'swaparty-invites-changed';
export const INBOX_RUNTIME_UPDATED_EVENT = 'swaparty-inbox-runtime-updated';

export const inboxRuntimeCache = {
  items: [],
  snapshot: '[]',
  hasLoaded: false,
  lastFetchAt: 0,
  inFlight: null,
};

export function publishInboxRuntimeUpdated(detail = {}) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(INBOX_RUNTIME_UPDATED_EVENT, {
    detail: detail && typeof detail === 'object' ? detail : {},
  }));
}

export function publishInboxChanged(detail = {}) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(INVITES_CHANGED_EVENT, {
    detail: detail && typeof detail === 'object' ? detail : {},
  }));
}

export async function warmInboxRuntimeCache({ force = false } = {}) {
  const nowMs = Date.now();
  if (inboxRuntimeCache.inFlight) {
    if (!force) return inboxRuntimeCache.inFlight;
    return inboxRuntimeCache.inFlight.finally(() => warmInboxRuntimeCache({ force: true }));
  }
  if (!force && inboxRuntimeCache.hasLoaded && (nowMs - inboxRuntimeCache.lastFetchAt) < INBOX_REFRESH_MIN_INTERVAL_MS) {
    return null;
  }

  const task = (async () => {
    try {
      const resp = await fetch('/api/contacts/invites/incoming?limit=50', { credentials: 'include' });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok || !Array.isArray(data.items)) return;

      const nextItems = data.items;
      const nextSnapshot = JSON.stringify(
        nextItems.map((item) => ({
          kind: String(item?.kind || ''),
          id: String(item?.id || ''),
          status: String(item?.status || ''),
          updatedAt: Number(item?.updatedAt || 0),
          readAt: Number(item?.readAt || 0),
          message: String(item?.message || ''),
        })),
      );

      inboxRuntimeCache.items = nextItems;
      inboxRuntimeCache.snapshot = nextSnapshot;
      inboxRuntimeCache.hasLoaded = true;
      inboxRuntimeCache.lastFetchAt = Date.now();
      publishInboxRuntimeUpdated({
        items: nextItems,
        unreadCount: nextItems.reduce((acc, item) => acc + (item?.readAt ? 0 : 1), 0),
      });
    } finally {
      inboxRuntimeCache.inFlight = null;
    }
  })();

  inboxRuntimeCache.inFlight = task;
  return task;
}

export async function refreshInboxRuntimeAndNotify({ force = false, reason = '', detail = {} } = {}) {
  try {
    await warmInboxRuntimeCache({ force });
  } finally {
    publishInboxChanged({
      ...detail,
      reason,
      runtimeSynced: true,
    });
  }
}
