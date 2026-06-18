import { createId, nowSec } from '../_lib/auth';
import { error, json, readJson } from '../_lib/http';
import { publishRealtimeEvent } from '../_lib/realtime';
import { buildRoomInviteMessage, getDefaultRoomTitle } from '../_lib/room-copy';
import { findUserBySessionToken, readSessionTokenFromRequest } from '../_lib/session';

async function requireSessionUser(context) {
  const { env, request } = context;
  const rawToken = readSessionTokenFromRequest(request);
  if (!rawToken) return null;
  const session = await findUserBySessionToken(env, rawToken);
  if (!session || session.status !== 'active') return null;
  return session;
}

function normalizeRoomHash(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

function normalizeText(value, fallback, maxLength) {
  const text = String(value || '').trim() || fallback;
  return text.slice(0, maxLength);
}

export async function onRequestPost(context) {
  const { env } = context;
  if (!env.DB) return error('DB binding is missing', 500);

  const session = await requireSessionUser(context);
  if (!session) return error('Unauthorized', 401);

  const body = await readJson(context.request);
  if (!body) return error('Invalid JSON body', 400);

  const receiverUserId = String(body.receiverUserId || '').trim();
  const roomHash = normalizeRoomHash(body.roomHash || body.roomId || body.hash);
  if (!receiverUserId) return error('Receiver is required', 400);
  if (!roomHash) return error('Room hash is required', 400);
  if (receiverUserId === session.user_id) return error('Cannot invite yourself', 400);

  const receiver = await env.DB
    .prepare('SELECT id, status, locale FROM users WHERE id = ? LIMIT 1')
    .bind(receiverUserId)
    .first();
  if (!receiver) return error('Receiver not found', 404);
  if (receiver.status !== 'active') return error('Receiver is not active', 400);

  const locale = receiver.locale || session.locale || 'en';
  const now = nowSec();
  const title = normalizeText(body.roomTitle || body.title, getDefaultRoomTitle(locale), 80);
  const memberCount = Math.max(1, Math.floor(Number(body.memberCount || body.count || 1) || 1));
  const maxMembers = Math.max(memberCount, Math.floor(Number(body.maxMembers || body.max || 8) || 8));
  const senderName = normalizeText(session.display_name || session.email?.split('@')[0], 'Guest', 80);
  const localized = buildRoomInviteMessage(locale, {
    senderName,
    title,
    roomHash,
    count: memberCount,
    max: maxMembers,
  });
  const message = normalizeText(body.message, localized.message, 240);
  const messageId = createId();

  try {
    await env.DB
      .prepare(
        `INSERT INTO contact_inbox_messages
           (id, user_id, kind, reason, actor_user_id, message_locale, message, created_at)
         VALUES (?, ?, 'room_invite', ?, ?, ?, ?, ?)`,
      )
      .bind(messageId, receiverUserId, roomHash, session.user_id, localized.locale, message, now)
      .run();

    await publishRealtimeEvent(env, {
      type: 'inbox.changed',
      targets: [receiverUserId],
      payload: {
        reason: 'room_invite',
        messageId,
        roomHash,
        senderUserId: session.user_id,
        roomTitle: title,
        createdAt: now,
      },
      ts: Date.now(),
    });
  } catch (err) {
    console.error('room_invite_failed', err);
    return error('room_invite_failed', 500, { errorCode: 'room_invite_failed' });
  }

  return json({
    ok: true,
    invite: {
      id: messageId,
      receiverUserId,
      roomHash,
      roomTitle: title,
      createdAt: now,
    },
  });
}
