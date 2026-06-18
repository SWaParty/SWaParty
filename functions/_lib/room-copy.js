import en from '../locales/en';
import ja from '../locales/ja';
import ko from '../locales/ko';
import zhCN from '../locales/zh-CN';
import zhTW from '../locales/zh-TW';
import { ensureSupportedLocale } from './locale';

const ROOM_LOCALES = {
  en,
  ja,
  ko,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
};

function interpolate(template, vars = {}) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? ''));
}

function resolveRoomsPack(locale) {
  const normalized = ensureSupportedLocale(locale, 'en');
  const pack = ROOM_LOCALES[normalized] || ROOM_LOCALES.en;
  return {
    locale: normalized,
    rooms: pack.rooms || ROOM_LOCALES.en.rooms || {},
  };
}

export function getDefaultRoomTitle(locale) {
  const { rooms } = resolveRoomsPack(locale);
  return rooms.defaultRoomTitle || 'Sync Watch Room';
}

export function buildRoomInviteMessage(locale, {
  senderName,
  title,
  roomHash,
  count,
  max,
}) {
  const { locale: normalized, rooms } = resolveRoomsPack(locale);
  const template = rooms.inviteMessageReceived
    || '{senderName} invited you to join {title} - Room {roomHash} - {count}/{max} online';
  return {
    locale: normalized,
    message: interpolate(template, {
      senderName: String(senderName || 'User'),
      title: String(title || getDefaultRoomTitle(normalized)),
      roomHash: String(roomHash || ''),
      count: String(count || 1),
      max: String(max || 8),
    }),
  };
}

export function buildWatchRequestMessage(locale, { senderName }) {
  const { locale: normalized, rooms } = resolveRoomsPack(locale);
  const template = rooms.watchRequestMessage
    || '{senderName} invited you to watch together. You will be notified when {senderName} creates a room for the first time.';
  return {
    locale: normalized,
    message: interpolate(template, {
      senderName: String(senderName || 'User'),
    }),
  };
}
