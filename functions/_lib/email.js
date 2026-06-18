import { error } from './http';
import en from '../locales/en';
import ja from '../locales/ja';
import ko from '../locales/ko';
import zhCN from '../locales/zh-CN';
import zhTW from '../locales/zh-TW';

const EMAIL_LOCALES = {
  en,
  ja,
  ko,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
};

function normalizeLangTag(rawTag) {
  const tag = String(rawTag || '').trim().toLowerCase();
  if (!tag) return null;

  if (tag.startsWith('zh-cn') || tag.startsWith('zh-sg')) return 'zh-CN';
  if (tag.startsWith('zh-tw') || tag.startsWith('zh-hk') || tag.startsWith('zh-mo')) return 'zh-TW';
  if (tag.startsWith('ja')) return 'ja';
  if (tag.startsWith('ko')) return 'ko';
  if (tag.startsWith('en')) return 'en';
  return null;
}

export function resolveEmailLocale(acceptLanguageHeader) {
  const header = String(acceptLanguageHeader || '').trim();
  if (!header) return 'en';

  const candidates = header.split(',').map((part) => part.split(';')[0].trim()).filter(Boolean);
  for (const candidate of candidates) {
    const locale = normalizeLangTag(candidate);
    if (locale && EMAIL_LOCALES[locale]) return locale;
  }
  return 'en';
}

export function resolvePreferredEmailLocale(explicitLocale, acceptLanguageHeader) {
  const explicit = normalizeLangTag(explicitLocale);
  if (explicit && EMAIL_LOCALES[explicit]) return explicit;
  return resolveEmailLocale(acceptLanguageHeader);
}

function getEmailCopy(locale) {
  const pack = EMAIL_LOCALES[locale] || EMAIL_LOCALES.en;
  return pack.email || EMAIL_LOCALES.en.email;
}

export async function sendVerifyEmail(env, { to, verifyUrl, locale = 'en' }) {
  if (!env.RESEND_API_KEY) {
    return error('RESEND_API_KEY is not configured', 500);
  }

  const copy = getEmailCopy(locale);
  const from = env.RESEND_FROM || 'SWaParty <onboarding@resend.dev>';
  const subject = copy.verify.subject;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto;">
      <h2>${copy.verify.title}</h2>
      <p>${copy.verify.intro}</p>
      <p style="margin: 24px 0;">
        <a href="${verifyUrl}" style="background:#2563eb;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;display:inline-block;">
          ${copy.verify.cta}
        </a>
      </p>
      <p>${copy.verify.ttl}</p>
      <p>${copy.verify.ignore}</p>
    </div>
  `;

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, html }),
  });

  if (!resp.ok) {
    const payload = await resp.text();
    return error('Failed to send verification email', 502, { provider: payload });
  }

  return null;
}

export async function sendEmailChangeCodeEmail(env, { to, code, locale = 'en' }) {
  if (!env.RESEND_API_KEY) {
    return error('RESEND_API_KEY is not configured', 500);
  }

  const copy = getEmailCopy(locale);
  const from = env.RESEND_FROM || 'SWaParty <onboarding@resend.dev>';
  const subject = copy.changeCode?.subject || copy.reset.subject;
  const title = copy.changeCode?.title || copy.reset.title;
  const intro = copy.changeCode?.intro || copy.reset.intro;
  const ttl = copy.changeCode?.ttl || copy.reset.ttl;
  const ignore = copy.changeCode?.ignore || copy.reset.ignore;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto;">
      <h2>${title}</h2>
      <p>${intro}</p>
      <p style="font-size: 28px; font-weight: 700; letter-spacing: 6px; margin: 20px 0;">${code}</p>
      <p>${ttl}</p>
      <p>${ignore}</p>
    </div>
  `;

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, html }),
  });

  if (!resp.ok) {
    const payload = await resp.text();
    return error('Failed to send email change code', 502, { provider: payload });
  }

  return null;
}

export async function sendPasswordResetCodeEmail(env, { to, code, locale = 'en' }) {
  if (!env.RESEND_API_KEY) {
    return error('RESEND_API_KEY is not configured', 500);
  }

  const copy = getEmailCopy(locale);
  const from = env.RESEND_FROM || 'SWaParty <onboarding@resend.dev>';
  const subject = copy.reset.subject;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto;">
      <h2>${copy.reset.title}</h2>
      <p>${copy.reset.intro}</p>
      <p style="font-size: 28px; font-weight: 700; letter-spacing: 6px; margin: 20px 0;">${code}</p>
      <p>${copy.reset.ttl}</p>
      <p>${copy.reset.ignore}</p>
    </div>
  `;

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, html }),
  });

  if (!resp.ok) {
    const payload = await resp.text();
    return error('Failed to send reset code email', 502, { provider: payload });
  }

  return null;
}
