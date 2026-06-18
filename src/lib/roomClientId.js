const ROOM_CLIENT_ID_KEY = 'swaparty.roomClientId';

function createRoomClientId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function getRoomClientId() {
  if (typeof window === 'undefined') return '';
  try {
    const existing = sessionStorage.getItem(ROOM_CLIENT_ID_KEY);
    if (existing) return existing;
    const next = createRoomClientId();
    sessionStorage.setItem(ROOM_CLIENT_ID_KEY, next);
    return next;
  } catch {
    return createRoomClientId();
  }
}

export function buildRoomClientHeaders(extraHeaders = {}) {
  const clientId = getRoomClientId();
  return {
    ...extraHeaders,
    ...(clientId ? { 'x-swaparty-client-id': clientId } : {}),
  };
}
