import { createId, nowSec } from '../../../../_lib/auth';
import { error, json } from '../../../../_lib/http';
import { findUserBySessionToken, readSessionTokenFromRequest } from '../../../../_lib/session';
import { publishRealtimeEvent } from '../../../../_lib/realtime';
import { buildInviteRejectedByReceiverMessage } from '../../../../_lib/contact-copy';

const INVITE_EXPIRE_SECONDS = 86400;

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
      `SELECT id, sender_user_id, receiver_user_id, status, created_at, expires_at
       FROM contact_invites
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(inviteId)
    .first();

  if (!invite) return error('Invite not found', 404);
  if (invite.receiver_user_id !== session.user_id) return error('Forbidden', 403);
  const now = nowSec();
  const expiresAt = Number(invite.expires_at || 0) || (Number(invite.created_at || 0) + INVITE_EXPIRE_SECONDS);
  if (invite.status === 'pending' && expiresAt > 0 && expiresAt <= now) {
    await env.DB
      .prepare(
        `UPDATE contact_invites
         SET status = 'canceled', updated_at = ?, responded_at = COALESCE(responded_at, ?)
         WHERE id = ? AND status = 'pending'`,
      )
      .bind(now, now, inviteId)
      .run();

    await publishRealtimeEvent(env, {
      type: 'invite.updated',
      targets: [invite.sender_user_id, invite.receiver_user_id],
      payload: {
        inviteId: invite.id,
        senderUserId: invite.sender_user_id,
        receiverUserId: invite.receiver_user_id,
        status: 'canceled',
        canceledBy: 'system_timeout',
        respondedAt: now,
        updatedAt: now,
      },
      ts: Date.now(),
    });

    return error('Invite is not pending', 409, { status: 'canceled' });
  }
  if (invite.status !== 'pending') return error('Invite is not pending', 409, { status: invite.status });

  await env.DB
    .prepare(
      `UPDATE contact_invites
       SET status = 'rejected', updated_at = ?, responded_at = ?, receiver_read_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .bind(now, now, now, inviteId)
    .run();

  const senderProfile = await env.DB
    .prepare('SELECT locale FROM users WHERE id = ? LIMIT 1')
    .bind(invite.sender_user_id)
    .first();
  const actorName = String(session.display_name || session.email?.split('@')[0] || 'User').trim() || 'User';
  const localizedNotice = buildInviteRejectedByReceiverMessage(senderProfile?.locale || 'en', { senderName: actorName });

  await env.DB
    .prepare(
      `INSERT INTO contact_inbox_messages
         (id, user_id, kind, reason, actor_user_id, message_locale, message, created_at)
       VALUES (?, ?, 'contact_removed', 'invite_rejected', ?, ?, ?, ?)`,
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
      status: 'rejected',
      respondedAt: now,
      updatedAt: now,
    },
    ts: Date.now(),
  });

  await publishRealtimeEvent(env, {
    type: 'inbox.changed',
    targets: [invite.sender_user_id],
    payload: {
      reason: 'invite_rejected',
      actorUserId: session.user_id,
      inviteId: invite.id,
    },
    ts: Date.now(),
  });

  return json({
    ok: true,
    invite: {
      id: invite.id,
      status: 'rejected',
      respondedAt: now,
      updatedAt: now,
    },
  });
}
