export const INBOX_PATH = '/inbox';

export function isInboxPath(pathname) {
  return String(pathname || '').trim() === INBOX_PATH;
}
