export const ROOM_PATH_PREFIX = '/room';

export function normalizeRoomHash(value) {
  return String(value || '')
    .trim()
    .replace(/^#+/, '')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .toUpperCase();
}

export function buildRoomPath(roomHash) {
  const hash = normalizeRoomHash(roomHash);
  return hash ? `${ROOM_PATH_PREFIX}/${encodeURIComponent(hash)}` : ROOM_PATH_PREFIX;
}

export function getRoomHashFromPath(pathname) {
  const path = String(pathname || '').trim();
  if (!path.startsWith(`${ROOM_PATH_PREFIX}/`)) return '';
  const rawHash = path.slice(`${ROOM_PATH_PREFIX}/`.length).split('/')[0];
  try {
    return normalizeRoomHash(decodeURIComponent(rawHash));
  } catch {
    return normalizeRoomHash(rawHash);
  }
}

export function isRoomPath(pathname) {
  return Boolean(getRoomHashFromPath(pathname));
}
