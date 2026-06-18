import en from '../locales/en';
import ja from '../locales/ja';
import ko from '../locales/ko';
import zhCN from '../locales/zh-CN';
import zhTW from '../locales/zh-TW';
import { ensureSupportedLocale } from './locale';

const CONTACT_LOCALES = {
  en,
  ja,
  ko,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
};

function interpolate(template, vars = {}) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? ''));
}

export function buildInviteReceivedMessage(locale, { senderName }) {
  const normalized = ensureSupportedLocale(locale, 'en');
  const pack = CONTACT_LOCALES[normalized] || CONTACT_LOCALES.en;
  const contactsPack = pack.contacts || CONTACT_LOCALES.en.contacts || {};
  const template = contactsPack.inviteReceived || '{senderName} invited you to connect.';
  return {
    locale: normalized,
    message: interpolate(template, { senderName: String(senderName || 'User') }),
  };
}

export function buildInviteRejectedByReceiverMessage(locale, { senderName }) {
  const normalized = ensureSupportedLocale(locale, 'en');
  const pack = CONTACT_LOCALES[normalized] || CONTACT_LOCALES.en;
  const contactsPack = pack.contacts || CONTACT_LOCALES.en.contacts || {};
  const template = contactsPack.inviteRejectedByReceiver
    || '{senderName} declined your contact invite.';
  return {
    locale: normalized,
    message: interpolate(template, { senderName: String(senderName || 'User') }),
  };
}

export function buildInviteCanceledByReceiverMessage(locale, { senderName }) {
  const normalized = ensureSupportedLocale(locale, 'en');
  const pack = CONTACT_LOCALES[normalized] || CONTACT_LOCALES.en;
  const contactsPack = pack.contacts || CONTACT_LOCALES.en.contacts || {};
  const template = contactsPack.inviteCanceledByReceiver
    || '{senderName} canceled your pending invite. You can send a new invite again.';
  return {
    locale: normalized,
    message: interpolate(template, { senderName: String(senderName || 'User') }),
  };
}

export function buildContactRemovedByPeerMessage(locale, { senderName }) {
  const normalized = ensureSupportedLocale(locale, 'en');
  const pack = CONTACT_LOCALES[normalized] || CONTACT_LOCALES.en;
  const contactsPack = pack.contacts || CONTACT_LOCALES.en.contacts || {};
  const template = contactsPack.contactRemovedByPeer || '{senderName} removed you from contacts.';
  return {
    locale: normalized,
    message: interpolate(template, { senderName: String(senderName || 'User') }),
  };
}

export function buildContactRemovedByAccountDeletedMessage(locale, { senderName }) {
  const normalized = ensureSupportedLocale(locale, 'en');
  const pack = CONTACT_LOCALES[normalized] || CONTACT_LOCALES.en;
  const contactsPack = pack.contacts || CONTACT_LOCALES.en.contacts || {};
  const template = contactsPack.contactRemovedByAccountDeleted
    || '{senderName} deleted the account. The contact relationship with {senderName} was removed automatically.';
  return {
    locale: normalized,
    message: interpolate(template, { senderName: String(senderName || 'User') }),
  };
}
