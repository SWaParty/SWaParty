import { createRawToken, nowSec } from '../../../_lib/auth';
import { error } from '../../../_lib/http';
import { createOAuthStateToken, normalizeRedirectBase } from '../../../_lib/oauth';
import { writeAuthAuditLog } from '../../../_lib/audit';

const SUPPORTED = new Set(['google', 'github']);

function getGoogleConfig(env) {
  const clientId = String(env.GOOGLE_CLIENT_ID || '').trim();
  const redirectBase = normalizeRedirectBase(env.OAUTH_REDIRECT_BASE);
  const stateSecret = String(env.OAUTH_STATE_SECRET || '').trim();
  if (!clientId || !redirectBase || !stateSecret) return null;
  return {
    clientId,
    redirectUri: `${redirectBase}/api/auth/oauth/google/callback`,
    stateSecret,
  };
}

function getGitHubConfig(env) {
  const clientId = String(env.GITHUB_CLIENT_ID || '').trim();
  const redirectBase = normalizeRedirectBase(env.OAUTH_REDIRECT_BASE);
  const stateSecret = String(env.OAUTH_STATE_SECRET || '').trim();
  if (!clientId || !redirectBase || !stateSecret) return null;
  return {
    clientId,
    redirectUri: `${redirectBase}/api/auth/oauth/github/callback`,
    stateSecret,
  };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const provider = String(context.params?.provider || '').toLowerCase();
  if (!provider || !SUPPORTED.has(provider)) {
    return error('Unsupported provider', 400, { supported: Array.from(SUPPORTED) });
  }

  const stateSecret = provider === 'google'
    ? getGoogleConfig(env)?.stateSecret
    : getGitHubConfig(env)?.stateSecret;
  if (!stateSecret) return error(`OAuth ${provider} config is incomplete`, 500);

  const state = await createOAuthStateToken(stateSecret, {
    p: provider,
    n: createRawToken(),
    ts: nowSec(),
  });

  const authUrl = new URL(
    provider === 'google'
      ? 'https://accounts.google.com/o/oauth2/v2/auth'
      : 'https://github.com/login/oauth/authorize',
  );

  if (provider === 'google') {
    const google = getGoogleConfig(env);
    if (!google) return error('OAuth Google config is incomplete', 500);
    authUrl.searchParams.set('client_id', google.clientId);
    authUrl.searchParams.set('redirect_uri', google.redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'openid email profile');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('access_type', 'online');
    authUrl.searchParams.set('include_granted_scopes', 'true');
    authUrl.searchParams.set('prompt', 'select_account');
  } else {
    const github = getGitHubConfig(env);
    if (!github) return error('OAuth GitHub config is incomplete', 500);
    authUrl.searchParams.set('client_id', github.clientId);
    authUrl.searchParams.set('redirect_uri', github.redirectUri);
    authUrl.searchParams.set('scope', 'read:user user:email');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('allow_signup', 'true');
  }

  await writeAuthAuditLog(env, {
    request,
    eventType: `oauth_${provider}_authorize_redirect`,
    metadata: { provider },
  });

  const headers = new Headers();
  headers.set('Location', authUrl.toString());
  return new Response(null, { status: 302, headers });
}
