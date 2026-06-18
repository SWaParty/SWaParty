const DEFAULT_LOCALE = 'en';
const SUPPORTED_LOCALES = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko'];
export const LOCALE_CHANGED_EVENT = 'swaparty-locale-changed';

let locale = DEFAULT_LOCALE;
let messages = {};
let defaultMessages = {};

function getByPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function loadLocaleSync(targetLocale) {
  if (typeof window === 'undefined') return null;

  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `/locales/${targetLocale}.json`, false);
    xhr.send(null);

    if (xhr.status >= 200 && xhr.status < 300) {
      const text = String(xhr.responseText || '').replace(/^\uFEFF/, '');
      return JSON.parse(text);
    }
  } catch {
    return null;
  }

  return null;
}

function mapToSupportedLocale(lang) {
  if (!lang) return null;
  const normalized = String(lang).toLowerCase();

  if (normalized.startsWith('zh-tw') || normalized.startsWith('zh-hk') || normalized.startsWith('zh-mo')) {
    return 'zh-TW';
  }
  if (normalized.startsWith('zh')) return 'zh-CN';
  if (normalized.startsWith('ja')) return 'ja';
  if (normalized.startsWith('ko')) return 'ko';
  if (normalized.startsWith('en')) return 'en';

  return null;
}

function detectBrowserLocale() {
  if (typeof navigator === 'undefined') return null;

  const candidates = Array.isArray(navigator.languages) && navigator.languages.length > 0
    ? navigator.languages
    : [navigator.language];

  for (const lang of candidates) {
    const mapped = mapToSupportedLocale(lang);
    if (mapped && SUPPORTED_LOCALES.includes(mapped)) {
      return mapped;
    }
  }

  return null;
}

function initI18n() {
  if (typeof window === 'undefined') return;

  let savedLocale = null;
  try {
    const fromStorage = localStorage.getItem('locale');
    if (fromStorage && SUPPORTED_LOCALES.includes(fromStorage)) {
      savedLocale = fromStorage;
    }
  } catch {
    savedLocale = null;
  }

  const browserLocale = detectBrowserLocale();
  locale = savedLocale || browserLocale || DEFAULT_LOCALE;

  defaultMessages = loadLocaleSync(DEFAULT_LOCALE) || {};

  const loaded = loadLocaleSync(locale);
  if (loaded) {
    messages = loaded;
    return;
  }

  locale = DEFAULT_LOCALE;
  messages = defaultMessages;
}

initI18n();

export function t(key, vars = {}) {
  const value = getByPath(messages, key);
  const fallbackValue = getByPath(defaultMessages, key);
  const resolved = value !== undefined ? value : fallbackValue;

  if (typeof resolved === 'string') {
    return resolved.replace(/\{(\w+)\}/g, (_, varName) => String(vars[varName] ?? ''));
  }

  if (resolved !== undefined) return resolved;
  return key;
}

export function getLocale() {
  return locale;
}

export function setLocale(nextLocale, options = {}) {
  const { persist = false } = options;
  if (!nextLocale || !SUPPORTED_LOCALES.includes(nextLocale)) return false;
  if (nextLocale === locale) return true;

  const loaded = loadLocaleSync(nextLocale);
  if (!loaded) return false;

  locale = nextLocale;
  messages = loaded;
  if (persist && typeof window !== 'undefined') {
    localStorage.setItem('locale', nextLocale);
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(LOCALE_CHANGED_EVENT, { detail: { locale: nextLocale } }));
  }
  return true;
}
