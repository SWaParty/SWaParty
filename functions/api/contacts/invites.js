import { createId, normalizeEmail, nowSec } from '../../_lib/auth';
import { error, json, readJson } from '../../_lib/http';
import { findUserBySessionToken, readSessionTokenFromRequest } from '../../_lib/session';
import { ensureSupportedLocale } from '../../_lib/locale';
import { publishRealtimeEvent } from '../../_lib/realtime';

const INVITE_EXPIRE_SECONDS = 86400;

async function requireSessionUser(context) {
  const { env, request } = context;
  const rawToken = readSessionTokenFromRequest(request);
  if (!rawToken) return null;
  const session = await findUserBySessionToken(env, rawToken);
  if (!session || session.status !== 'active') return null;
  return session;
}

async function resolveReceiver(env, body) {
  const receiverUserId = String(body.receiverUserId || '').trim();
  const receiverPublicId = String(body.receiverPublicId || '').trim().toUpperCase();
  const receiverEmail = normalizeEmail(body.receiverEmail);

  if (receiverUserId) {
    return env.DB
      .prepare(`SELECT id, public_id, email, display_name, avatar_url, locale, status FROM users WHERE id = ? LIMIT 1`)
      .bind(receiverUserId)
      .first();
  }
  if (receiverPublicId) {
    return env.DB
      .prepare(`SELECT id, public_id, email, display_name, avatar_url, locale, status FROM users WHERE UPPER(public_id) = ? LIMIT 1`)
      .bind(receiverPublicId)
      .first();
  }
  if (receiverEmail) {
    return env.DB
      .prepare(`SELECT id, public_id, email, display_name, avatar_url, locale, status FROM users WHERE LOWER(email) = ? LIMIT 1`)
      .bind(receiverEmail)
      .first();
  }
  return null;
}

export async function onRequestPost(context) {
  const { env } = context;
  if (!env.DB) return error('DB binding is missing', 500);

  const session = await requireSessionUser(context);
  if (!session) return error('Unauthorized', 401);

  const body = await readJson(context.request);
  if (!body) return error('Invalid JSON body', 400);

  const receiver = await resolveReceiver(env, body);
  if (!receiver) {
    return error('Receiver not found', 404);
  }
  if (receiver.status !== 'active') {
    return error('Receiver is not active', 400);
  }
  if (receiver.id === session.user_id) {
    return error('Cannot invite yourself', 400);
  }

  const contactExists = await env.DB
    .prepare(
      `SELECT id
       FROM quick_contacts
       WHERE (user_id = ? AND contact_user_id = ?)
          OR (user_id = ? AND contact_user_id = ?)
       LIMIT 1`,
    )
    .bind(session.user_id, receiver.id, receiver.id, session.user_id)
    .first();
  if (contactExists) {
    return error('Already contacts', 409);
  }

  const now = nowSec();
  const latestInvite = await env.DB
    .prepare(
      `SELECT
         id,
         sender_user_id,
         receiver_user_id,
         status,
         created_at,
         COALESCE(expires_at, created_at + ?) AS expires_at
       FROM contact_invites
       WHERE
         (sender_user_id = ? AND receiver_user_id = ?)
         OR
         (sender_user_id = ? AND receiver_user_id = ?)
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .bind(INVITE_EXPIRE_SECONDS, session.user_id, receiver.id, receiver.id, session.user_id)
    .first();

  if (latestInvite) {
    const latestCreatedAt = Number(latestInvite.created_at || 0);
    const latestStatus = String(latestInvite.status || '').trim();
    const latestExpiresAt = Number(latestInvite.expires_at || 0);
    const isPending = latestStatus === 'pending';
    if (isPending && latestCreatedAt > 0 && latestExpiresAt > now) {
      const retryAfterSec = Math.max(1, latestExpiresAt - now);
      return error('Invite cooldown active', 409, {
        code: 'invite_cooldown',
        retryAfterSec,
        invite: {
          id: latestInvite.id,
          senderUserId: latestInvite.sender_user_id,
          receiverUserId: latestInvite.receiver_user_id,
          status: latestInvite.status,
          expiresAt: Number(latestInvite.expires_at || 0) || null,
        },
      });
    }
  }

  const pendingSummary = await env.DB
    .prepare(
      `SELECT
         COUNT(*) AS pending_count,
         MAX(COALESCE(expires_at, created_at + ?)) AS max_expires_at
       FROM contact_invites
       WHERE status = 'pending'
         AND (
           (sender_user_id = ? AND receiver_user_id = ?)
           OR
           (sender_user_id = ? AND receiver_user_id = ?)
         )`,
    )
    .bind(INVITE_EXPIRE_SECONDS, session.user_id, receiver.id, receiver.id, session.user_id)
    .first();

  const pendingCount = Number(pendingSummary?.pending_count || 0);
  const maxExpiresAt = Number(pendingSummary?.max_expires_at || 0);

  if (pendingCount > 0 && maxExpiresAt > now) {
    const existingPending = await env.DB
      .prepare(
        `SELECT id, sender_user_id, receiver_user_id, COALESCE(expires_at, created_at + ?) AS expires_at
         FROM contact_invites
         WHERE status = 'pending'
           AND (
             (sender_user_id = ? AND receiver_user_id = ?)
             OR
             (sender_user_id = ? AND receiver_user_id = ?)
           )
         ORDER BY COALESCE(expires_at, created_at + ?) DESC, created_at DESC
         LIMIT 1`,
      )
      .bind(INVITE_EXPIRE_SECONDS, session.user_id, receiver.id, receiver.id, session.user_id, INVITE_EXPIRE_SECONDS)
      .first();

    const remainingSec = Math.max(0, maxExpiresAt - now);
    return error('Invite cooldown active', 409, {
      code: 'invite_cooldown',
      retryAfterSec: remainingSec,
      invite: existingPending
        ? {
            id: existingPending.id,
            senderUserId: existingPending.sender_user_id,
            receiverUserId: existingPending.receiver_user_id,
            expiresAt: Number(existingPending.expires_at || 0) || null,
          }
        : null,
    });
  }

  if (pendingCount > 0) {
    await env.DB
      .prepare(
        `UPDATE contact_invites
         SET status = 'canceled',
             updated_at = CASE
               WHEN receiver_read_at IS NOT NULL THEN updated_at
               ELSE ?
             END,
             responded_at = COALESCE(responded_at, ?)
         WHERE status = 'pending'
           AND COALESCE(expires_at, created_at + ?) <= ?
           AND (
             (sender_user_id = ? AND receiver_user_id = ?)
             OR
             (sender_user_id = ? AND receiver_user_id = ?)
           )`,
      )
      .bind(now, now, INVITE_EXPIRE_SECONDS, now, session.user_id, receiver.id, receiver.id, session.user_id)
      .run();
  }

  const existsAfterCleanup = await env.DB
    .prepare(
      `SELECT id
       FROM contact_invites
       WHERE status = 'pending'
         AND (
           (sender_user_id = ? AND receiver_user_id = ?)
           OR
           (sender_user_id = ? AND receiver_user_id = ?)
         )
       LIMIT 1`,
    )
    .bind(session.user_id, receiver.id, receiver.id, session.user_id)
    .first();

  if (existsAfterCleanup) {
    return error('Invite already pending', 409, {
      invite: {
        id: existsAfterCleanup.id,
        senderUserId: session.user_id,
        receiverUserId: receiver.id,
      },
    });
  }

  const expiresAt = now + INVITE_EXPIRE_SECONDS;
  const inviteId = createId();
  await env.DB
    .prepare(
      `INSERT INTO contact_invites
        (id, sender_user_id, receiver_user_id, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .bind(inviteId, session.user_id, receiver.id, expiresAt, now, now)
    .run();

  await publishRealtimeEvent(env, {
    type: 'invite.created',
    targets: [receiver.id, session.user_id],
    payload: {
      inviteId,
      senderUserId: session.user_id,
      receiverUserId: receiver.id,
      status: 'pending',
      expiresAt,
      createdAt: now,
      updatedAt: now,
      senderDisplayName: session.display_name || session.email?.split('@')[0] || 'Guest',
      senderAvatarUrl: session.avatar_url || null,
      senderPublicId: session.public_id || null,
    },
    ts: Date.now(),
  });

  return json({
    ok: true,
    invite: {
      id: inviteId,
      senderUserId: session.user_id,
      receiverUserId: receiver.id,
      status: 'pending',
      expiresAt,
      createdAt: now,
      updatedAt: now,
      receiverLocale: ensureSupportedLocale(receiver.locale, 'en'),
    },
  });
}
