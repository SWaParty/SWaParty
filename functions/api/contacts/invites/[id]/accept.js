import { createId, nowSec } from '../../../../_lib/auth';
import { error, json } from '../../../../_lib/http';
import { findUserBySessionToken, readSessionTokenFromRequest } from '../../../../_lib/session';
import { publishRealtimeEvent } from '../../../../_lib/realtime';

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

  const receiverToSenderId = createId();
  const senderToReceiverId = createId();

  await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE contact_invites
         SET status = 'accepted', updated_at = ?, responded_at = ?, receiver_read_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .bind(now, now, now, inviteId),
    env.DB
      .prepare(
        `INSERT OR IGNORE INTO quick_contacts (id, user_id, contact_user_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(receiverToSenderId, invite.receiver_user_id, invite.sender_user_id, now),
    env.DB
      .prepare(
        `INSERT OR IGNORE INTO quick_contacts (id, user_id, contact_user_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(senderToReceiverId, invite.sender_user_id, invite.receiver_user_id, now),
  ]);

  await publishRealtimeEvent(env, {
    type: 'invite.updated',
    targets: [invite.sender_user_id, invite.receiver_user_id],
    payload: {
      inviteId: invite.id,
      senderUserId: invite.sender_user_id,
      receiverUserId: invite.receiver_user_id,
      status: 'accepted',
      respondedAt: now,
      updatedAt: now,
    },
    ts: Date.now(),
  });

  await publishRealtimeEvent(env, {
    type: 'contact.added',
    targets: [invite.sender_user_id, invite.receiver_user_id],
    payload: {
      senderUserId: invite.sender_user_id,
      receiverUserId: invite.receiver_user_id,
    },
    ts: Date.now(),
  });

  return json({
    ok: true,
    invite: {
      id: invite.id,
      status: 'accepted',
      respondedAt: now,
      updatedAt: now,
    },
  });
}
