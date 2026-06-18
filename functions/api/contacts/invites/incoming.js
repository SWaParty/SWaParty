import { error, json } from '../../../_lib/http';
import { findUserBySessionToken, readSessionTokenFromRequest } from '../../../_lib/session';
import { buildInviteReceivedMessage } from '../../../_lib/contact-copy';
import { nowSec } from '../../../_lib/auth';

const INVITE_EXPIRE_SECONDS = 86400;

async function requireSessionUser(context) {
  const { env, request } = context;
  const rawToken = readSessionTokenFromRequest(request);
  if (!rawToken) return null;
  const session = await findUserBySessionToken(env, rawToken);
  if (!session || session.status !== 'active') return null;
  return session;
}

function normalizeEtagToken(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const weakStripped = raw.startsWith('W/') ? raw.slice(2).trim() : raw;
  if (weakStripped.startsWith('"') && weakStripped.endsWith('"')) {
    return weakStripped.slice(1, -1);
  }
  return weakStripped;
}

function matchesIfNoneMatch(ifNoneMatchHeader, etagValue) {
  const header = String(ifNoneMatchHeader || '').trim();
  if (!header) return false;
  if (header === '*') return true;
  const expected = normalizeEtagToken(etagValue);
  if (!expected) return false;
  return header
    .split(',')
    .map((token) => normalizeEtagToken(token))
    .some((token) => token && token === expected);
}

function createWeakEtagFromSeed(seed) {
  const text = String(seed || '');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const unsigned = hash >>> 0;
  return `W/"${unsigned.toString(16)}-${text.length}"`;
}

function toSender(row) {
  return {
    id: row.sender_user_id,
    publicId: row.sender_public_id || null,
    email: row.sender_email,
    displayName: row.sender_display_name || row.sender_email.split('@')[0] || 'Guest',
    avatarUrl: row.sender_avatar_url || null,
  };
}

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.DB) return error('DB binding is missing', 500);

  const session = await requireSessionUser(context);
  if (!session) return error('Unauthorized', 401);

  const url = new URL(request.url);
  const limitRaw = Number(url.searchParams.get('limit') || 30);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.floor(limitRaw))) : 30;
  const now = nowSec();
  const locale = String(session.locale || 'en').trim() || 'en';

  const inviteMeta = await env.DB
    .prepare(
      `SELECT
         COUNT(*) AS total_count,
         COALESCE(MAX(i.updated_at), 0) AS max_updated_at,
         COALESCE(MAX(i.created_at), 0) AS max_created_at,
         COALESCE(MAX(i.responded_at), 0) AS max_responded_at,
         COALESCE(MAX(i.receiver_read_at), 0) AS max_receiver_read_at,
         SUM(CASE WHEN i.status = 'pending' AND COALESCE(i.expires_at, i.created_at + ?) > ? THEN 1 ELSE 0 END) AS pending_open_count,
         SUM(CASE WHEN i.status = 'pending' AND COALESCE(i.expires_at, i.created_at + ?) <= ? THEN 1 ELSE 0 END) AS pending_expired_count
       FROM contact_invites i
       WHERE i.receiver_user_id = ?
         AND i.receiver_dismissed_at IS NULL`,
    )
    .bind(INVITE_EXPIRE_SECONDS, now, INVITE_EXPIRE_SECONDS, now, session.user_id)
    .first();

  const inboxMeta = await env.DB
    .prepare(
      `SELECT
         COUNT(*) AS total_count,
         COALESCE(MAX(m.created_at), 0) AS max_created_at,
         COALESCE(MAX(m.read_at), 0) AS max_read_at
       FROM contact_inbox_messages m
       WHERE m.user_id = ?`,
    )
    .bind(session.user_id)
    .first();

  const etagSeed = [
    session.user_id,
    locale,
    limit,
    Number(inviteMeta?.total_count || 0),
    Number(inviteMeta?.max_updated_at || 0),
    Number(inviteMeta?.max_created_at || 0),
    Number(inviteMeta?.max_responded_at || 0),
    Number(inviteMeta?.max_receiver_read_at || 0),
    Number(inviteMeta?.pending_open_count || 0),
    Number(inviteMeta?.pending_expired_count || 0),
    Number(inboxMeta?.total_count || 0),
    Number(inboxMeta?.max_created_at || 0),
    Number(inboxMeta?.max_read_at || 0),
  ].join('|');
  const etag = createWeakEtagFromSeed(etagSeed);

  if (matchesIfNoneMatch(request.headers.get('if-none-match'), etag)) {
    const headers = new Headers();
    headers.set('etag', etag);
    headers.set('cache-control', 'private, no-cache');
    return new Response(null, { status: 304, headers });
  }

  const inviteRows = await env.DB
    .prepare(
      `SELECT
         i.id,
         i.sender_user_id,
         i.receiver_user_id,
         i.status AS raw_status,
         CASE
           WHEN i.status = 'pending' AND COALESCE(i.expires_at, i.created_at + ?) <= ? THEN 'canceled'
           ELSE i.status
         END AS status,
         COALESCE(i.expires_at, i.created_at + ?) AS expires_at,
         i.created_at,
         i.updated_at,
         i.responded_at,
         i.receiver_read_at,
         u.public_id AS sender_public_id,
         u.email AS sender_email,
         u.display_name AS sender_display_name,
         u.avatar_url AS sender_avatar_url
       FROM contact_invites i
       JOIN users u ON u.id = i.sender_user_id
       WHERE i.receiver_user_id = ?
         AND i.receiver_dismissed_at IS NULL
       ORDER BY i.updated_at DESC, i.created_at DESC
       LIMIT ?`,
    )
    .bind(INVITE_EXPIRE_SECONDS, now, INVITE_EXPIRE_SECONDS, session.user_id, limit)
    .all();

  const inboxRows = await env.DB
    .prepare(
      `SELECT
         m.id,
         m.kind,
         m.reason,
         m.message_locale,
         m.message,
         m.created_at,
         m.read_at,
         m.actor_user_id,
         u.public_id AS actor_public_id,
         u.email AS actor_email,
         u.display_name AS actor_display_name,
         u.avatar_url AS actor_avatar_url
       FROM contact_inbox_messages m
       LEFT JOIN users u ON u.id = m.actor_user_id
       WHERE m.user_id = ?
       ORDER BY m.created_at DESC
       LIMIT ?`,
    )
    .bind(session.user_id, limit)
    .all();

  const inviteItems = (inviteRows?.results || []).map((row) => {
    const sender = toSender(row);
    const senderName = sender.displayName || sender.email;
    const localized = buildInviteReceivedMessage(locale, { senderName });
    const status = String(row.status || '').trim();
    const rawStatus = String(row.raw_status || '').trim();
    const expiresAt = Number(row.expires_at || 0) || null;
    const effectiveUpdatedAt = status === 'canceled' && rawStatus === 'pending'
      ? Math.max(Number(row.updated_at || 0), Number(expiresAt || 0))
      : Number(row.updated_at || 0);
    const effectiveRespondedAt = status === 'canceled' && rawStatus === 'pending'
      ? (Number(row.responded_at || 0) || Number(expiresAt || 0) || null)
      : (row.responded_at || null);
    return {
      kind: 'invite',
      id: row.id,
      sender,
      receiverUserId: row.receiver_user_id,
      status,
      createdAt: row.created_at,
      updatedAt: effectiveUpdatedAt,
      respondedAt: effectiveRespondedAt,
      readAt: row.receiver_read_at || null,
      expiresAt,
      messageLocale: localized.locale,
      message: localized.message,
    };
  });

  const noticeItems = (inboxRows?.results || []).map((row) => {
    const senderEmail = String(row.actor_email || '').trim();
    const senderName = String(row.actor_display_name || '').trim() || senderEmail.split('@')[0] || 'User';
    const reason = String(row.reason || 'generic').trim() || 'generic';
    const kind = String(row.kind || 'notice').trim() || 'notice';
    return {
      kind,
      id: row.id,
      sender: {
        id: row.actor_user_id || null,
        publicId: row.actor_public_id || null,
        email: senderEmail,
        displayName: senderName,
        avatarUrl: row.actor_avatar_url || null,
      },
      receiverUserId: session.user_id,
      status: kind === 'room_invite'
        ? 'pending'
        : reason === 'account_deleted'
        ? 'account_deleted'
        : reason === 'invite_rejected'
          ? 'rejected'
          : reason === 'invite_canceled_by_peer'
            ? 'canceled'
            : 'info',
      reason,
      createdAt: row.created_at,
      updatedAt: row.created_at,
      respondedAt: null,
      readAt: row.read_at || null,
      messageLocale: row.message_locale || (session.locale || 'en'),
      message: String(row.message || '').trim(),
      roomHash: kind === 'room_invite' ? reason : null,
    };
  });

  const items = [...inviteItems, ...noticeItems]
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    .slice(0, limit);

  const unreadCount = items.reduce((acc, item) => {
    const readAt = Number(item.readAt || 0);
    const updatedAt = Number(item.updatedAt || item.createdAt || 0);
    return acc + (readAt > 0 && readAt >= updatedAt ? 0 : 1);
  }, 0);

  const headers = new Headers();
  headers.set('etag', etag);
  headers.set('cache-control', 'private, no-cache');
  return json({
    ok: true,
    items,
    unreadCount,
  }, { headers });
}
