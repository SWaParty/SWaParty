import { error, json } from '../../../../_lib/http';
import { createId, nowSec } from '../../../../_lib/auth';
import { publishRealtimeEvent } from '../../../../_lib/realtime';
import { buildRoomInviteMessage, getDefaultRoomTitle } from '../../../../_lib/room-copy';
import { findUserBySessionToken, readSessionTokenFromRequest } from '../../../../_lib/session';

function trim(value) {
  return String(value || '').trim();
}

function joinRoomPath(pathParam) {
  if (Array.isArray(pathParam)) {
    return pathParam.map((item) => encodeURIComponent(String(item))).join('/');
  }
  const path = trim(pathParam);
  return path ? encodeURIComponent(path) : '';
}

async function readRequestBody(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return null;
  const text = await request.text();
  return text ? text : null;
}

async function notifyPendingWatchRequests(env, session, roomSnapshot) {
  const room = roomSnapshot?.room || {};
  const roomHash = trim(room.hash).toUpperCase();
  if (!roomHash) return;

  const rows = await env.DB
    .prepare(
      `SELECT m.id, m.user_id, u.locale AS receiver_locale
       FROM contact_inbox_messages m
       LEFT JOIN users u ON u.id = m.user_id
       WHERE m.actor_user_id = ?
         AND m.kind = 'watch_request'
         AND m.reason = 'pending_watch'
       ORDER BY m.created_at ASC
       LIMIT 50`,
    )
    .bind(session.user_id)
    .all();
  const pending = rows?.results || [];
  if (!pending.length) return;

  const now = nowSec();
  const senderName = trim(session.display_name) || trim(session.email).split('@')[0] || 'Guest';
  const members = Array.isArray(roomSnapshot?.members) ? roomSnapshot.members : [];
  const memberCount = Math.max(1, members.length || 1);
  const maxMembers = Math.max(memberCount, Number(room.maxMembers || 8) || 8);

  for (const row of pending) {
    const locale = row.receiver_locale || session.locale || 'en';
    const title = trim(room.title) || getDefaultRoomTitle(locale);
    const localized = buildRoomInviteMessage(locale, {
      senderName,
      title,
      roomHash,
      count: memberCount,
      max: maxMembers,
    });
    const messageId = createId();
    await env.DB
      .prepare(
        `INSERT INTO contact_inbox_messages
           (id, user_id, kind, reason, actor_user_id, message_locale, message, created_at)
         VALUES (?, ?, 'room_invite', ?, ?, ?, ?, ?)`,
      )
      .bind(messageId, row.user_id, roomHash, session.user_id, localized.locale, localized.message, now)
      .run();
    await publishRealtimeEvent(env, {
      type: 'inbox.changed',
      targets: [row.user_id],
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
  }

  const ids = pending.map((row) => row.id).filter(Boolean);
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    await env.DB
      .prepare(`DELETE FROM contact_inbox_messages WHERE actor_user_id = ? AND kind = 'watch_request' AND id IN (${placeholders})`)
      .bind(session.user_id, ...ids)
      .run();
  }
}

export async function onRequest(context) {
  const { env, params, request } = context;
  if (!env.DB) return error('DB binding is missing', 500);

  const baseUrl = trim(env.RMSTATE_BASE_URL);
  const internalToken = trim(env.RMSTATE_INTERNAL_API_TOKEN);
  if (!baseUrl || !internalToken) return error('Room backend is not configured', 500, 'rmstate_not_configured');

  const rawToken = readSessionTokenFromRequest(request);
  if (!rawToken) return error('Unauthorized', 401);

  const session = await findUserBySessionToken(env, rawToken);
  if (!session || session.status !== 'active') return error('Unauthorized', 401);

  const url = new URL(request.url);
  const roomPath = joinRoomPath(params?.path);
  const upstreamUrl = new URL(`/internal/rooms${roomPath ? `/${roomPath}` : ''}`, baseUrl.replace(/\/+$/, ''));
  upstreamUrl.search = url.search;

  const upstreamHeaders = new Headers({
    authorization: `Bearer ${internalToken}`,
    'x-swaparty-user-id': session.user_id,
    'x-swaparty-user-name': session.display_name || session.email?.split('@')[0] || 'SWaParty User',
    'x-swaparty-user-avatar': session.avatar_url || '',
  });

  const contentType = request.headers.get('content-type');
  if (contentType) upstreamHeaders.set('content-type', contentType);

  const body = await readRequestBody(request);
  const upstreamResp = await fetch(upstreamUrl.toString(), {
    method: request.method,
    headers: upstreamHeaders,
    body,
  });

  const payload = await upstreamResp.json().catch(() => null);
  if (payload) {
    if (upstreamResp.ok && request.method === 'POST' && !roomPath && payload?.ok && payload?.data?.room?.hash) {
      context.waitUntil?.(notifyPendingWatchRequests(env, session, payload.data));
    }
    return json(payload, { status: upstreamResp.status });
  }

  return new Response(await upstreamResp.text(), {
    status: upstreamResp.status,
    headers: {
      'content-type': upstreamResp.headers.get('content-type') || 'text/plain; charset=utf-8',
    },
  });
}
