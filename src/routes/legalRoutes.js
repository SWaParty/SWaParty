export const LEGAL_PAGE_TERMS = 'terms';
export const LEGAL_PAGE_PRIVACY = 'privacy';

export const LEGAL_TERMS_PATH = '/terms';
export const LEGAL_PRIVACY_PATH = '/privacy';

export function getLegalPageFromPath(pathname) {
  if (pathname === LEGAL_TERMS_PATH) return LEGAL_PAGE_TERMS;
  if (pathname === LEGAL_PRIVACY_PATH) return LEGAL_PAGE_PRIVACY;
  return null;
}

export function isLegalPath(pathname) {
  return pathname === LEGAL_TERMS_PATH || pathname === LEGAL_PRIVACY_PATH;
}
