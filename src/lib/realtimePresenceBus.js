export const PRESENCE_CHANGED_EVENT = 'swaparty-presence-changed';
const runtimePresenceState = {
  onlineUserIds: [],
};

export function normalizePresenceUserId(value) {
  return String(value || '').trim();
}

export function normalizePresenceOnlineUserIds(rawList) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  const seen = new Set();
  for (const item of rawList) {
    const id = normalizePresenceUserId(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function getPresenceOnlineUserIds() {
  return runtimePresenceState.onlineUserIds.slice();
}

export function publishPresenceOnlineUserIds(rawList, ts = Date.now()) {
  const onlineUserIds = normalizePresenceOnlineUserIds(rawList);
  runtimePresenceState.onlineUserIds = onlineUserIds;
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(PRESENCE_CHANGED_EVENT, {
    detail: {
      onlineUserIds,
      ts,
    },
  }));
}
