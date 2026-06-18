import { writeAuthAuditLog } from '../../_lib/audit';
import { error, json } from '../../_lib/http';
import { buildClearSessionCookie, findUserBySessionToken, readSessionTokenFromRequest } from '../../_lib/session';
import { createId, nowSec } from '../../_lib/auth';
import { publishRealtimeEvent } from '../../_lib/realtime';
import { buildContactRemovedByAccountDeletedMessage } from '../../_lib/contact-copy';
import { normalizePublicOrigin } from '../../_lib/media';

function getAvatarPublicOrigin(env) {
  return normalizePublicOrigin(env?.AVATAR_PUBLIC_ORIGIN || 'https://avatars.example.com');
}

function keyFromPublicUrl(url, baseUrl) {
  const normalizedBase = normalizePublicOrigin(baseUrl);
  const targetUrl = String(url || '').trim();
  if (!normalizedBase || !targetUrl || !targetUrl.startsWith(`${normalizedBase}/`)) return null;
  return targetUrl.slice(normalizedBase.length + 1);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.DB) return error('DB binding is missing', 500);

  const rawToken = readSessionTokenFromRequest(request);
  if (!rawToken) return error('Unauthorized', 401);

  const session = await findUserBySessionToken(env, rawToken);
  if (!session || session.status !== 'active') return error('Unauthorized', 401);
  const now = nowSec();
  const actorName = String(session.display_name || session.email?.split('@')[0] || 'Guest').trim() || 'Guest';

  const relatedContactsRows = await env.DB
    .prepare(
      `SELECT DISTINCT
         qc.user_id AS receiver_user_id,
         u.locale AS receiver_locale
       FROM quick_contacts qc
       JOIN users u ON u.id = qc.user_id
       WHERE qc.contact_user_id = ?`,
    )
    .bind(session.user_id)
    .all();
  const relatedContacts = (relatedContactsRows?.results || [])
    .map((row) => ({
      receiverUserId: String(row.receiver_user_id || '').trim(),
      receiverLocale: String(row.receiver_locale || '').trim() || 'en',
    }))
    .filter((row) => row.receiverUserId);

  if (relatedContacts.length > 0) {
    await env.DB.batch(
      relatedContacts.map((target) => {
        const localized = buildContactRemovedByAccountDeletedMessage(target.receiverLocale, { senderName: actorName });
        return env.DB
          .prepare(
            `INSERT INTO contact_inbox_messages
               (id, user_id, kind, reason, actor_user_id, message_locale, message, created_at)
             VALUES (?, ?, 'contact_removed', 'account_deleted', ?, ?, ?, ?)`,
          )
          .bind(createId(), target.receiverUserId, session.user_id, localized.locale, localized.message, now);
      }),
    );
  }

  await env.DB
    .prepare('DELETE FROM signup_requests WHERE email = ?')
    .bind(session.email)
    .run();

  await env.DB
    .prepare('DELETE FROM password_reset_requests WHERE email = ?')
    .bind(session.email)
    .run();

  await env.DB
    .prepare('DELETE FROM auth_audit_logs WHERE user_id = ? OR email = ?')
    .bind(session.user_id, session.email)
    .run();

  await writeAuthAuditLog(env, {
    request,
    eventType: 'account_deleted',
    email: session.email,
    userId: session.user_id,
    metadata: { sessionId: session.session_id, notifiedContacts: relatedContacts.length },
  });

  const publicBaseUrl = getAvatarPublicOrigin(env);
  const avatarObjectKey = keyFromPublicUrl(session.avatar_url, publicBaseUrl);
  if (env.AVATARS && avatarObjectKey) {
    try {
      await env.AVATARS.delete(avatarObjectKey);
    } catch {
      // Best effort cleanup: account deletion should not fail due to avatar cleanup.
    }
  }

  await env.DB
    .prepare('DELETE FROM users WHERE id = ?')
    .bind(session.user_id)
    .run();

  if (relatedContacts.length > 0) {
    for (const target of relatedContacts) {
      await publishRealtimeEvent(env, {
        type: 'contact.removed',
        targets: [target.receiverUserId],
        payload: {
          actorUserId: session.user_id,
          contactUserId: session.user_id,
          displayName: actorName,
          reason: 'account_deleted',
        },
        ts: Date.now(),
      });
      await publishRealtimeEvent(env, {
        type: 'inbox.changed',
        targets: [target.receiverUserId],
        payload: {
          reason: 'account_deleted',
          actorUserId: session.user_id,
        },
        ts: Date.now(),
      });
    }
  }

  const headers = new Headers();
  headers.append('Set-Cookie', buildClearSessionCookie(request.url));
  return json({ ok: true, message: 'Account deleted', notifiedContacts: relatedContacts.length }, { headers });
}
