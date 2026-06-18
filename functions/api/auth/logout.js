import { json } from '../../_lib/http';
import {
  buildClearSessionCookie,
  findUserBySessionToken,
  readSessionTokenFromRequest,
  revokeSessionByToken,
} from '../../_lib/session';
import { writeAuthAuditLog } from '../../_lib/audit';

export async function onRequestPost(context) {
  const { request, env } = context;
  const rawToken = readSessionTokenFromRequest(request);
  let session = null;
  if (env.DB && rawToken) {
    session = await findUserBySessionToken(env, rawToken);
  }
  if (env.DB && rawToken) {
    await revokeSessionByToken(env, rawToken);
  }

  await writeAuthAuditLog(env, {
    request,
    eventType: 'logout',
    email: session?.email || null,
    userId: session?.user_id || null,
  });

  const headers = new Headers();
  headers.append('Set-Cookie', buildClearSessionCookie(request.url));
  return json({ ok: true, message: 'Logged out' }, { headers });
}
