export const SETTINGS_PATH_PREFIX = '/settings';

export const SETTINGS_TAB_PROFILE = 'profile';
export const SETTINGS_TAB_SECURITY = 'security';
export const SETTINGS_TAB_PREFERENCES = 'preferences';
export const SETTINGS_TAB_CONTACTS = 'contacts';

export const SETTINGS_TAB_IDS = [
  SETTINGS_TAB_PROFILE,
  SETTINGS_TAB_SECURITY,
  SETTINGS_TAB_PREFERENCES,
  SETTINGS_TAB_CONTACTS,
];

export function normalizeSettingsTab(tabId) {
  const normalized = String(tabId || '').trim().toLowerCase();
  if (SETTINGS_TAB_IDS.includes(normalized)) return normalized;
  return SETTINGS_TAB_PROFILE;
}

export function buildSettingsPath(tabId = SETTINGS_TAB_PROFILE) {
  const tab = normalizeSettingsTab(tabId);
  return `${SETTINGS_PATH_PREFIX}/${tab}`;
}

export function isSettingsPath(pathname) {
  const path = String(pathname || '').trim();
  if (!path) return false;
  return path === SETTINGS_PATH_PREFIX || path.startsWith(`${SETTINGS_PATH_PREFIX}/`);
}

export function getSettingsTabFromPath(pathname) {
  const path = String(pathname || '').trim();
  if (!isSettingsPath(path)) return null;
  if (path === SETTINGS_PATH_PREFIX) return SETTINGS_TAB_PROFILE;
  const prefix = `${SETTINGS_PATH_PREFIX}/`;
  const rawTab = path.slice(prefix.length).split('/')[0];
  return normalizeSettingsTab(rawTab);
}
