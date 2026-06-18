import { createId, nowSec } from '../_lib/auth';
import { error, json, readJson } from '../_lib/http';
import { publishRealtimeEvent } from '../_lib/realtime';
import { buildWatchRequestMessage } from '../_lib/room-copy';
import { findUserBySessionToken, readSessionTokenFromRequest } from '../_lib/session';

async function requireSessionUser(context) {
  const { env, request } = context;
  const rawToken = readSessionTokenFromRequest(request);
  if (!rawToken) return null;
  const session = await findUserBySessionToken(env, rawToken);
  if (!session || session.status !== 'active') return null;
  return session;
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
  if (!receiverUserId) return error('Receiver is required', 400);
  if (receiverUserId === session.user_id) return error('Cannot invite yourself', 400);

  const receiver = await env.DB
    .prepare('SELECT id, status, locale FROM users WHERE id = ? LIMIT 1')
    .bind(receiverUserId)
    .first();
  if (!receiver) return error('Receiver not found', 404);
  if (receiver.status !== 'active') return error('Receiver is not active', 400);

  const senderName = normalizeText(session.display_name || session.email?.split('@')[0], 'Guest', 80);
  const localized = buildWatchRequestMessage(receiver.locale || session.locale || 'en', { senderName });
  const message = normalizeText(body.message, localized.message, 240);
  const messageId = createId();
  const now = nowSec();

  try {
    await env.DB
      .prepare(
        `INSERT INTO contact_inbox_messages
           (id, user_id, kind, reason, actor_user_id, message_locale, message, created_at)
         VALUES (?, ?, 'watch_request', 'pending_watch', ?, ?, ?, ?)`,
      )
      .bind(messageId, receiverUserId, session.user_id, localized.locale, message, now)
      .run();

    await publishRealtimeEvent(env, {
      type: 'inbox.changed',
      targets: [receiverUserId],
      payload: {
        reason: 'watch_request',
        messageId,
        senderUserId: session.user_id,
        createdAt: now,
      },
      ts: Date.now(),
    });
  } catch (err) {
    console.error('watch_request_failed', err);
    return error('watch_request_failed', 500, { errorCode: 'watch_request_failed' });
  }

  return json({
    ok: true,
    request: {
      id: messageId,
      receiverUserId,
      createdAt: now,
    },
  });
}
