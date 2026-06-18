const SUPPORTED_LOCALES = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko'];

export function normalizeLocale(rawTag) {
  const tag = String(rawTag || '').trim().toLowerCase();
  if (!tag) return null;

  if (tag.startsWith('zh-cn') || tag.startsWith('zh-sg')) return 'zh-CN';
  if (tag.startsWith('zh-tw') || tag.startsWith('zh-hk') || tag.startsWith('zh-mo')) return 'zh-TW';
  if (tag.startsWith('ja')) return 'ja';
  if (tag.startsWith('ko')) return 'ko';
  if (tag.startsWith('en')) return 'en';
  return null;
}

export function resolveLocaleFromAcceptLanguage(acceptLanguageHeader) {
  const header = String(acceptLanguageHeader || '').trim();
  if (!header) return 'en';

  const candidates = header.split(',').map((part) => part.split(';')[0].trim()).filter(Boolean);
  for (const candidate of candidates) {
    const locale = normalizeLocale(candidate);
    if (locale) return locale;
  }
  return 'en';
}

export function ensureSupportedLocale(rawTag, fallback = 'en') {
  const locale = normalizeLocale(rawTag);
  if (locale && SUPPORTED_LOCALES.includes(locale)) return locale;
  return fallback;
}

export { SUPPORTED_LOCALES };
