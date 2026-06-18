import { useMemo } from 'react';

const DANMAKU_DISPLAY_DURATION_SEC = 6;
const DANMAKU_DESKTOP_LANE_COUNT = 8;
const DANMAKU_MOBILE_LANE_COUNT = 5;
const DANMAKU_DESKTOP_MAX_ACTIVE = 14;
const DANMAKU_MOBILE_MAX_ACTIVE = 6;
const DANMAKU_TIME_BUCKET_SEC = 0.25;

function getStableDanmakuHash(value) {
  const raw = String(value || '');
  let hash = 0;
  for (let i = 0; i < raw.length; i += 1) {
    hash = (hash * 31 + raw.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function lowerBoundDanmakuTime(items, targetTime) {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((items[mid]?.videoTime || 0) < targetTime) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function useChatDanmakuItems({
  messages = [],
  currentMediaKey = '',
  currentMediaId = '',
  currentTime = 0,
  showDanmaku = true,
} = {}) {
  const danmakuSourceMessages = useMemo(() => {
    if (!currentMediaKey && !currentMediaId) return [];
    return messages
      .filter((msg) => {
        if (msg.type !== 'chat' || !Number.isFinite(msg.videoTime)) return false;
        const messageMediaKey = String(msg.mediaKey || '').trim();
        const messageMediaId = String(msg.mediaId || '').trim();
        const keyMatches = currentMediaKey && (!messageMediaKey || messageMediaKey === currentMediaKey);
        const idMatches = currentMediaId && messageMediaId && messageMediaId === currentMediaId;
        return keyMatches || idMatches;
      })
      .sort((a, b) => (a.videoTime - b.videoTime) || String(a.id).localeCompare(String(b.id)));
  }, [currentMediaId, currentMediaKey, messages]);

  const danmakuClockTime = Math.floor(Math.max(0, currentTime || 0) / DANMAKU_TIME_BUCKET_SEC) * DANMAKU_TIME_BUCKET_SEC;
  return useMemo(() => {
    if (!showDanmaku || (!currentMediaKey && !currentMediaId)) return [];
    const compactViewport = typeof window !== 'undefined' && Boolean(window.matchMedia?.('(max-width: 767px)')?.matches);
    const laneCount = compactViewport ? DANMAKU_MOBILE_LANE_COUNT : DANMAKU_DESKTOP_LANE_COUNT;
    const maxActiveItems = compactViewport ? DANMAKU_MOBILE_MAX_ACTIVE : DANMAKU_DESKTOP_MAX_ACTIVE;
    const startIndex = lowerBoundDanmakuTime(danmakuSourceMessages, danmakuClockTime - DANMAKU_DISPLAY_DURATION_SEC);
    let endIndex = startIndex;
    while (endIndex < danmakuSourceMessages.length && danmakuSourceMessages[endIndex].videoTime <= danmakuClockTime) {
      endIndex += 1;
    }
    const windowItems = danmakuSourceMessages.slice(startIndex, endIndex);
    const cappedItems = windowItems.length > maxActiveItems
      ? windowItems.slice(windowItems.length - maxActiveItems)
      : windowItems;
    return cappedItems
      .map((item) => {
        const elapsed = danmakuClockTime - item.videoTime;
        const lane = getStableDanmakuHash(item.id || item.text) % laneCount;
        const laneHeight = 84 / laneCount;
        return {
          ...item,
          time: item.videoTime,
          elapsed,
          lane,
          topPercent: 6 + lane * laneHeight,
        };
      })
      .filter((item) => item.elapsed >= 0 && item.elapsed <= DANMAKU_DISPLAY_DURATION_SEC);
  }, [currentMediaId, currentMediaKey, danmakuClockTime, danmakuSourceMessages, showDanmaku]);
}
