import { error, json } from '../../../../_lib/http';
import { findUserBySessionToken, readSessionTokenFromRequest } from '../../../../_lib/session';
import { createId, nowSec } from '../../../../_lib/auth';
import { publishRealtimeEvent } from '../../../../_lib/realtime';
import { buildInviteCanceledByReceiverMessage } from '../../../../_lib/contact-copy';

async function requireSessionUser(context) {
  const { env, request } = context;
  const rawToken = readSessionTokenFromRequest(request);
  if (!rawToken) return null;
  const session = await findUserBySessionToken(env, rawToken);
  if (!session || session.status !== 'active') return null;
  return session;
}

export async function onRequestPost(context) {
  const { env, params } = context;
  if (!env.DB) return error('DB binding is missing', 500);

  const session = await requireSessionUser(context);
  if (!session) return error('Unauthorized', 401);

  const inviteId = String(params?.id || '').trim();
  if (!inviteId) return error('Invalid invite id', 400);

  const invite = await env.DB
    .prepare(
      `SELECT id, sender_user_id, receiver_user_id, status
       FROM contact_invites
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(inviteId)
    .first();

  if (!invite) return error('Invite not found', 404);
  if (invite.receiver_user_id !== session.user_id) return error('Forbidden', 403);

  const now = nowSec();

  const result = await env.DB
    .prepare(
      String(invite.status || '').trim() === 'pending'
        ? `UPDATE contact_invites
           SET status = 'canceled',
               updated_at = ?,
               responded_at = COALESCE(responded_at, ?),
               receiver_read_at = COALESCE(receiver_read_at, ?),
               receiver_dismissed_at = ?
           WHERE id = ? AND receiver_user_id = ?`
        : `UPDATE contact_invites
           SET receiver_dismissed_at = ?
           WHERE id = ? AND receiver_user_id = ?`,
    )
    .bind(
      ...(String(invite.status || '').trim() === 'pending'
        ? [now, now, now, now, inviteId, session.user_id]
        : [now, inviteId, session.user_id]),
    )
    .run();

  if (String(invite.status || '').trim() === 'pending') {
    const senderProfile = await env.DB
      .prepare('SELECT locale FROM users WHERE id = ? LIMIT 1')
      .bind(invite.sender_user_id)
      .first();
    const actorName = String(session.display_name || session.email?.split('@')[0] || 'User').trim() || 'User';
    const localizedNotice = buildInviteCanceledByReceiverMessage(senderProfile?.locale || 'en', { senderName: actorName });

    await env.DB
      .prepare(
        `INSERT INTO contact_inbox_messages
           (id, user_id, kind, reason, actor_user_id, message_locale, message, created_at)
         VALUES (?, ?, 'contact_removed', 'invite_canceled_by_peer', ?, ?, ?, ?)`,
      )
      .bind(createId(), invite.sender_user_id, session.user_id, localizedNotice.locale, localizedNotice.message, now)
      .run();

    await publishRealtimeEvent(env, {
      type: 'invite.updated',
      targets: [invite.sender_user_id, invite.receiver_user_id],
      payload: {
        inviteId: invite.id,
        senderUserId: invite.sender_user_id,
        receiverUserId: invite.receiver_user_id,
        status: 'canceled',
        canceledBy: 'receiver_dismissed',
        respondedAt: now,
        updatedAt: now,
      },
      ts: Date.now(),
    });

    await publishRealtimeEvent(env, {
      type: 'inbox.changed',
      targets: [invite.sender_user_id],
      payload: {
        reason: 'invite_canceled_by_peer',
        actorUserId: session.user_id,
        inviteId: invite.id,
      },
      ts: Date.now(),
    });
  } else {
    await publishRealtimeEvent(env, {
      type: 'inbox.changed',
      targets: [invite.receiver_user_id],
      payload: {
        inviteId: invite.id,
      },
      ts: Date.now(),
    });
  }

  return json({
    ok: true,
    removed: Number(result?.meta?.changes || 0) > 0,
  });
}
