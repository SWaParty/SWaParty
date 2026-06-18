export const PROFILE_UPDATED_EVENT = 'swaparty-profile-updated';

export function normalizeRealtimeProfile(payload = {}) {
  const userId = String(payload.userId || payload.id || '').trim();
  return {
    userId,
    id: userId,
    publicId: payload.publicId || null,
    email: payload.email || '',
    displayName: payload.displayName || payload.name || '',
    name: payload.displayName || payload.name || '',
    avatarUrl: payload.avatarUrl || null,
    locale: payload.locale || null,
  };
}

export function publishProfileUpdated(detail = {}) {
  if (typeof window === 'undefined') return;
  const profile = normalizeRealtimeProfile(detail);
  if (!profile.userId) return;
  window.dispatchEvent(new CustomEvent(PROFILE_UPDATED_EVENT, {
    detail: profile,
  }));
}
