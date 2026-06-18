export const AUTH_MODE_LOGIN = 'login';
export const AUTH_MODE_REGISTER = 'register';
export const AUTH_PATH_PREFIX = '/auth/';
export const AUTH_LOGIN_PATH = '/auth/login';
export const AUTH_REGISTER_PATH = '/auth/register';
export const AUTH_FORGOT_PATH = '/auth/forgot';
export const AUTH_TWO_FACTOR_PATH = '/auth/2fa';

export function normalizeAuthMode(mode) {
  return mode === AUTH_MODE_REGISTER ? AUTH_MODE_REGISTER : AUTH_MODE_LOGIN;
}

export function getAuthModeFromPath(pathname) {
  if (pathname === AUTH_FORGOT_PATH) return AUTH_MODE_LOGIN;
  if (pathname === AUTH_TWO_FACTOR_PATH) return AUTH_MODE_LOGIN;
  if (pathname === AUTH_REGISTER_PATH) return AUTH_MODE_REGISTER;
  if (pathname === AUTH_LOGIN_PATH) return AUTH_MODE_LOGIN;
  return null;
}

export function buildAuthPath(mode) {
  return normalizeAuthMode(mode) === AUTH_MODE_REGISTER ? AUTH_REGISTER_PATH : AUTH_LOGIN_PATH;
}

export function isAuthPath(pathname) {
  return String(pathname || '').startsWith(AUTH_PATH_PREFIX);
}

export function isForgotPath(pathname) {
  return pathname === AUTH_FORGOT_PATH;
}

export function isTwoFactorPath(pathname) {
  return pathname === AUTH_TWO_FACTOR_PATH;
}
