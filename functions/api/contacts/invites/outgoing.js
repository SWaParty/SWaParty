import { error, json } from '../../../_lib/http';
import { findUserBySessionToken, readSessionTokenFromRequest } from '../../../_lib/session';
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

function toReceiver(row) {
  return {
    id: row.receiver_user_id,
    publicId: row.receiver_public_id || null,
    email: row.receiver_email,
    displayName: row.receiver_display_name || row.receiver_email.split('@')[0] || 'Guest',
    avatarUrl: row.receiver_avatar_url || null,
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

  const rows = await env.DB
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
         u.public_id AS receiver_public_id,
         u.email AS receiver_email,
         u.display_name AS receiver_display_name,
         u.avatar_url AS receiver_avatar_url
       FROM contact_invites i
       JOIN users u ON u.id = i.receiver_user_id
       WHERE i.sender_user_id = ?
       ORDER BY i.created_at DESC
       LIMIT ?`,
    )
    .bind(INVITE_EXPIRE_SECONDS, now, INVITE_EXPIRE_SECONDS, session.user_id, limit)
    .all();

  const items = (rows?.results || []).map((row) => {
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
      id: row.id,
      receiver: toReceiver(row),
      senderUserId: row.sender_user_id,
      status,
      createdAt: row.created_at,
      updatedAt: effectiveUpdatedAt,
      respondedAt: effectiveRespondedAt,
      expiresAt,
    };
  });

  return json({
    ok: true,
    items,
    count: items.length,
  });
}
