import { error, json } from '../../_lib/http';
import { findUserBySessionToken, readSessionTokenFromRequest } from '../../_lib/session';

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.DB) return error('DB binding is missing', 500);

  const rawToken = readSessionTokenFromRequest(request);
  if (!rawToken) return json({ ok: true, authenticated: false, user: null });

  const session = await findUserBySessionToken(env, rawToken);
  if (!session || session.status !== 'active') {
    return json({ ok: true, authenticated: false, user: null });
  }

  return json({
    ok: true,
    authenticated: true,
    user: {
      id: session.user_id,
      publicId: session.public_id || null,
      email: session.email,
      displayName: session.display_name,
      avatarUrl: session.avatar_url || null,
      locale: session.locale || 'en',
    },
  });
}
