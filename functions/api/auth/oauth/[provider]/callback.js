import { createId, createPublicId, normalizeEmail, nowSec } from '../../../../_lib/auth';
import { buildSessionSetCookie, createUserSession } from '../../../../_lib/session';
import { error } from '../../../../_lib/http';
import { normalizeRedirectBase, verifyOAuthStateToken } from '../../../../_lib/oauth';
import { writeAuthAuditLog } from '../../../../_lib/audit';
import { resolveLocaleFromAcceptLanguage } from '../../../../_lib/locale';

const SUPPORTED = new Set(['google', 'github']);
const OAUTH_STATE_MAX_AGE_SEC = 10 * 60;

function getGoogleConfig(env) {
  const clientId = String(env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = String(env.GOOGLE_CLIENT_SECRET || '').trim();
  const redirectBase = normalizeRedirectBase(env.OAUTH_REDIRECT_BASE);
  const stateSecret = String(env.OAUTH_STATE_SECRET || '').trim();
  if (!clientId || !clientSecret || !redirectBase || !stateSecret) return null;
  return {
    clientId,
    clientSecret,
    redirectBase,
    redirectUri: `${redirectBase}/api/auth/oauth/google/callback`,
    stateSecret,
  };
}

function getGitHubConfig(env) {
  const clientId = String(env.GITHUB_CLIENT_ID || '').trim();
  const clientSecret = String(env.GITHUB_CLIENT_SECRET || '').trim();
  const redirectBase = normalizeRedirectBase(env.OAUTH_REDIRECT_BASE);
  const stateSecret = String(env.OAUTH_STATE_SECRET || '').trim();
  if (!clientId || !clientSecret || !redirectBase || !stateSecret) return null;
  return {
    clientId,
    clientSecret,
    redirectBase,
    redirectUri: `${redirectBase}/api/auth/oauth/github/callback`,
    stateSecret,
  };
}

function redirect(url, headers = null) {
  const out = new Headers(headers || {});
  out.set('Location', url);
  return new Response(null, { status: 302, headers: out });
}

function buildLoginRedirect(base, reason) {
  const url = new URL('/auth/login', base);
  if (reason) url.searchParams.set('oauth_error', reason);
  return url.toString();
}

async function exchangeGoogleToken({ code, config }) {
  const body = new URLSearchParams();
  body.set('code', code);
  body.set('client_id', config.clientId);
  body.set('client_secret', config.clientSecret);
  body.set('redirect_uri', config.redirectUri);
  body.set('grant_type', 'authorization_code');

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok || !payload.access_token) return null;
  return payload;
}

async function fetchGoogleUser(accessToken) {
  const resp = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok) return null;
  return payload;
}

async function exchangeGitHubToken({ code, config }) {
  const body = new URLSearchParams();
  body.set('code', code);
  body.set('client_id', config.clientId);
  body.set('client_secret', config.clientSecret);
  body.set('redirect_uri', config.redirectUri);

  const resp = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'SWaParty OAuth',
    },
    body: body.toString(),
  });
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok || !payload.access_token) return null;
  return payload;
}

async function fetchGitHubUser(accessToken) {
  const resp = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'SWaParty OAuth',
    },
  });
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok) return null;
  return payload;
}

async function fetchGitHubPrimaryVerifiedEmail(accessToken) {
  const resp = await fetch('https://api.github.com/user/emails', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'SWaParty OAuth',
    },
  });
  const payload = await resp.json().catch(() => null);
  if (!resp.ok || !Array.isArray(payload)) return null;

  const primaryVerified = payload.find((item) => item?.primary && item?.verified && item?.email);
  if (primaryVerified) return normalizeEmail(primaryVerified.email);

  const anyVerified = payload.find((item) => item?.verified && item?.email);
  if (anyVerified) return normalizeEmail(anyVerified.email);

  return null;
}

async function resolveOrCreateSocialUser({
  env,
  request,
  provider,
  providerUserId,
  email,
  emailVerified,
  displayName,
  avatarUrl,
}) {
  const normalizedProvider = String(provider || '').trim();
  const normalizedProviderUserId = String(providerUserId || '').trim();
  const normalizedEmail = normalizeEmail(email);
  const normalizedDisplayName = String(displayName || '').trim() || null;
  const normalizedAvatarUrl = String(avatarUrl || '').trim() || null;
  const isEmailVerified = emailVerified === true;

  if (!normalizedProvider || !normalizedProviderUserId || !normalizedEmail || !isEmailVerified) return null;

  const now = nowSec();
  const resolvedLocale = resolveLocaleFromAcceptLanguage(request.headers.get('accept-language'));

  const existingIdentity = await env.DB
    .prepare(
      `SELECT u.id, u.email, u.display_name, u.avatar_url, u.status
       FROM auth_identities ai
       JOIN users u ON u.id = ai.user_id
       WHERE ai.provider = ? AND ai.provider_user_id = ?
       LIMIT 1`,
    )
    .bind(normalizedProvider, normalizedProviderUserId)
    .first();

  if (existingIdentity) {
    if (existingIdentity.status !== 'active') return null;
    if ((!existingIdentity.display_name && normalizedDisplayName) || (!existingIdentity.avatar_url && normalizedAvatarUrl)) {
      await env.DB
        .prepare('UPDATE users SET display_name = COALESCE(display_name, ?), avatar_url = COALESCE(avatar_url, ?), updated_at = ? WHERE id = ?')
        .bind(normalizedDisplayName, normalizedAvatarUrl, now, existingIdentity.id)
        .run();
      if (!existingIdentity.display_name && normalizedDisplayName) existingIdentity.display_name = normalizedDisplayName;
      if (!existingIdentity.avatar_url && normalizedAvatarUrl) existingIdentity.avatar_url = normalizedAvatarUrl;
    }
    return {
      userId: existingIdentity.id,
      email: existingIdentity.email,
      displayName: existingIdentity.display_name,
      avatarUrl: existingIdentity.avatar_url,
      merged: 'identity',
    };
  }

  const existingUser = await env.DB
    .prepare('SELECT id, email, display_name, avatar_url, status FROM users WHERE email = ? LIMIT 1')
    .bind(normalizedEmail)
    .first();

  if (existingUser) {
    if (existingUser.status !== 'active') return null;
    await env.DB
      .prepare(
        `INSERT INTO auth_identities
          (id, user_id, provider, provider_user_id, provider_email, provider_email_verified, linked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(createId(), existingUser.id, normalizedProvider, normalizedProviderUserId, normalizedEmail, 1, now, now)
      .run();

    if ((!existingUser.display_name && normalizedDisplayName) || (!existingUser.avatar_url && normalizedAvatarUrl)) {
      await env.DB
        .prepare('UPDATE users SET display_name = COALESCE(display_name, ?), avatar_url = COALESCE(avatar_url, ?), updated_at = ? WHERE id = ?')
        .bind(normalizedDisplayName, normalizedAvatarUrl, now, existingUser.id)
        .run();
      if (!existingUser.display_name && normalizedDisplayName) existingUser.display_name = normalizedDisplayName;
      if (!existingUser.avatar_url && normalizedAvatarUrl) existingUser.avatar_url = normalizedAvatarUrl;
    }

    return {
      userId: existingUser.id,
      email: existingUser.email,
      displayName: existingUser.display_name,
      avatarUrl: existingUser.avatar_url,
      merged: 'email',
    };
  }

  const userId = createId();
  const publicId = createPublicId();
  await env.DB
    .prepare(
      `INSERT INTO users
        (id, public_id, email, display_name, avatar_url, locale, status, email_verified_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    )
    .bind(userId, publicId, normalizedEmail, normalizedDisplayName, normalizedAvatarUrl, resolvedLocale, now, now, now)
    .run();

  await env.DB
    .prepare(
      `INSERT INTO auth_identities
        (id, user_id, provider, provider_user_id, provider_email, provider_email_verified, linked_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(createId(), userId, normalizedProvider, normalizedProviderUserId, normalizedEmail, 1, now, now)
    .run();

  return { userId, email: normalizedEmail, displayName: normalizedDisplayName, avatarUrl: normalizedAvatarUrl, merged: 'created' };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.DB) return error('DB binding is missing', 500);

  const provider = String(context.params?.provider || '').toLowerCase();
  if (!provider || !SUPPORTED.has(provider)) {
    return error('Unsupported provider', 400, { supported: Array.from(SUPPORTED) });
  }

  const config = provider === 'google' ? getGoogleConfig(env) : getGitHubConfig(env);
  if (!config) return error(`OAuth ${provider} config is incomplete`, 500);

  const url = new URL(request.url);
  const code = String(url.searchParams.get('code') || '');
  const state = String(url.searchParams.get('state') || '');
  if (!code || !state) {
    await writeAuthAuditLog(env, {
      request,
      eventType: `oauth_${provider}_failed`,
      metadata: { reason: 'missing_code_or_state' },
    });
    return redirect(buildLoginRedirect(config.redirectBase, 'missing_code_or_state'));
  }

  const statePayload = await verifyOAuthStateToken(config.stateSecret, state);
  if (!statePayload || statePayload.p !== provider) {
    await writeAuthAuditLog(env, {
      request,
      eventType: `oauth_${provider}_failed`,
      metadata: { reason: 'invalid_state' },
    });
    return redirect(buildLoginRedirect(config.redirectBase, 'invalid_state'));
  }

  const now = nowSec();
  if (!Number.isFinite(statePayload.ts) || now - statePayload.ts > OAUTH_STATE_MAX_AGE_SEC) {
    await writeAuthAuditLog(env, {
      request,
      eventType: `oauth_${provider}_failed`,
      metadata: { reason: 'state_expired' },
    });
    return redirect(buildLoginRedirect(config.redirectBase, 'state_expired'));
  }

  const tokenPayload = provider === 'google'
    ? await exchangeGoogleToken({ code, config })
    : await exchangeGitHubToken({ code, config });
  if (!tokenPayload) {
    await writeAuthAuditLog(env, {
      request,
      eventType: `oauth_${provider}_failed`,
      metadata: { reason: 'token_exchange_failed' },
    });
    return redirect(buildLoginRedirect(config.redirectBase, 'token_exchange_failed'));
  }

  const resolved = provider === 'google'
    ? await (async () => {
      const googleUser = await fetchGoogleUser(tokenPayload.access_token);
      if (!googleUser) return null;
      return resolveOrCreateSocialUser({
        env,
        request,
        provider: 'google',
        providerUserId: googleUser.sub,
        email: googleUser.email,
        emailVerified: googleUser.email_verified === true,
        displayName: googleUser.name || googleUser.given_name || null,
        avatarUrl: googleUser.picture || null,
      });
    })()
    : await (async () => {
      const githubUser = await fetchGitHubUser(tokenPayload.access_token);
      if (!githubUser || !githubUser.id) return null;
      const verifiedEmail = await fetchGitHubPrimaryVerifiedEmail(tokenPayload.access_token);
      if (!verifiedEmail) return null;
      return resolveOrCreateSocialUser({
        env,
        request,
        provider: 'github',
        providerUserId: String(githubUser.id),
        email: verifiedEmail,
        emailVerified: true,
        displayName: githubUser.name || githubUser.login || null,
        avatarUrl: githubUser.avatar_url || null,
      });
    })();

  if (!resolved) {
    await writeAuthAuditLog(env, {
      request,
      eventType: `oauth_${provider}_failed`,
      metadata: { reason: 'user_resolution_failed' },
    });
    return redirect(buildLoginRedirect(config.redirectBase, 'user_resolution_failed'));
  }

  const { rawToken, expiresAt } = await createUserSession(env, {
    userId: resolved.userId,
    request,
  });

  await writeAuthAuditLog(env, {
    request,
    eventType: `oauth_${provider}_succeeded`,
    email: resolved.email,
    userId: resolved.userId,
    metadata: { merged: resolved.merged, expiresAt },
  });

  const headers = new Headers();
  headers.append('Set-Cookie', buildSessionSetCookie(rawToken, request.url));
  return redirect(`${config.redirectBase}/`, headers);
}
