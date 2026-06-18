import { error, json } from '../../_lib/http';
import { findUserBySessionToken, readSessionTokenFromRequest } from '../../_lib/session';
import { createId, nowSec } from '../../_lib/auth';
import { publishRealtimeEvent } from '../../_lib/realtime';
import { buildContactRemovedByPeerMessage } from '../../_lib/contact-copy';

async function requireSessionUser(context) {
  const { env, request } = context;
  const rawToken = readSessionTokenFromRequest(request);
  if (!rawToken) return null;
  const session = await findUserBySessionToken(env, rawToken);
  if (!session || session.status !== 'active') return null;
  return session;
}

export async function onRequestDelete(context) {
  const { env, params } = context;
  if (!env.DB) return error('DB binding is missing', 500);

  const session = await requireSessionUser(context);
  if (!session) return error('Unauthorized', 401);

  const contactUserId = String(params?.id || '').trim();
  if (!contactUserId) return error('Invalid contact id', 400);
  if (contactUserId === session.user_id) return error('Cannot delete yourself', 400);

  const now = nowSec();
  const contactUser = await env.DB
    .prepare('SELECT id, email, display_name, locale FROM users WHERE id = ? LIMIT 1')
    .bind(contactUserId)
    .first();

  const deleteResult = await env.DB
    .prepare(
      `DELETE FROM quick_contacts
       WHERE (user_id = ? AND contact_user_id = ?)
          OR (user_id = ? AND contact_user_id = ?)`,
    )
    .bind(session.user_id, contactUserId, contactUserId, session.user_id)
    .run();

  await env.DB
    .prepare(
      `UPDATE contact_invites
       SET status = 'canceled', updated_at = ?, responded_at = COALESCE(responded_at, ?)
       WHERE status = 'pending'
         AND (
           (sender_user_id = ? AND receiver_user_id = ?)
           OR
           (sender_user_id = ? AND receiver_user_id = ?)
         )`,
    )
    .bind(now, now, session.user_id, contactUserId, contactUserId, session.user_id)
    .run();

  const changed = Number(deleteResult?.meta?.changes || 0);
  if (changed > 0) {
    const actorName = String(session.display_name || session.email?.split('@')[0] || 'Guest').trim();
    if (contactUser?.id) {
      const localized = buildContactRemovedByPeerMessage(contactUser.locale || 'en', { senderName: actorName });
      await env.DB
        .prepare(
          `INSERT INTO contact_inbox_messages
             (id, user_id, kind, reason, actor_user_id, message_locale, message, created_at)
           VALUES (?, ?, 'contact_removed', 'peer_removed', ?, ?, ?, ?)`,
        )
        .bind(createId(), contactUserId, session.user_id, localized.locale, localized.message, now)
        .run();
    }

    await publishRealtimeEvent(env, {
      type: 'contact.removed',
      targets: [session.user_id, contactUserId],
      payload: {
        actorUserId: session.user_id,
        contactUserId,
        displayName: actorName,
      },
      ts: Date.now(),
    });
  }

  return json({
    ok: true,
    removed: changed > 0,
    removedRows: changed,
  });
}
