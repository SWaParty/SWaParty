export const MEDIA_CHANGED_EVENT = 'swaparty-media-changed';
export const ROOM_REALTIME_EVENT = 'swaparty-room-realtime';

export function publishMediaChanged(detail = {}) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(MEDIA_CHANGED_EVENT, {
    detail: detail && typeof detail === 'object' ? detail : {},
  }));
}

export function publishRoomRealtimeEvent(detail = {}) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(ROOM_REALTIME_EVENT, {
    detail: detail && typeof detail === 'object' ? detail : {},
  }));
}
