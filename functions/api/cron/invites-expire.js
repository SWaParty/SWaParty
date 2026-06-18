import { nowSec } from '../../_lib/auth';
import { error, json } from '../../_lib/http';
import { publishRealtimeEvent } from '../../_lib/realtime';

const BATCH_LIMIT = 200;
const INVITE_EXPIRE_SECONDS = 86400;

function readCronSecret(request) {
  const auth = String(request.headers.get('authorization') || '').trim();
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  return String(request.headers.get('x-cron-secret') || '').trim();
}

function isCronAuthorized(env, request) {
  const configured = String(env?.CRON_SECRET || '').trim();
  if (!configured) return true;
  const received = readCronSecret(request);
  return Boolean(received && received === configured);
}

async function expirePendingInvites(env, now) {
  const expiredRows = await env.DB
    .prepare(
      `SELECT id, sender_user_id, receiver_user_id
       FROM contact_invites
       WHERE status = 'pending'
         AND COALESCE(expires_at, created_at + ?) <= ?
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .bind(INVITE_EXPIRE_SECONDS, now, BATCH_LIMIT)
    .all();

  const rows = expiredRows?.results || [];
  if (!rows.length) return [];

  await env.DB.batch(
    rows.map((row) =>
      env.DB
        .prepare(
          `UPDATE contact_invites
           SET status = 'canceled',
               updated_at = ?,
               responded_at = COALESCE(responded_at, ?),
               expires_at = COALESCE(expires_at, created_at + ?)
           WHERE id = ? AND status = 'pending'`,
        )
        .bind(now, now, INVITE_EXPIRE_SECONDS, row.id),
    ),
  );

  return rows;
}

async function notifyTimeoutCanceledInvites(env, now) {
  const notifyRows = await env.DB
    .prepare(
      `SELECT id, sender_user_id, receiver_user_id, updated_at, responded_at
       FROM contact_invites
       WHERE status = 'canceled'
         AND timeout_notified_at IS NULL
         AND COALESCE(expires_at, created_at + ?) <= ?
       ORDER BY updated_at ASC
       LIMIT ?`,
    )
    .bind(INVITE_EXPIRE_SECONDS, now, BATCH_LIMIT)
    .all();

  const rows = notifyRows?.results || [];
  if (!rows.length) return { attempted: 0, notified: 0 };

  let notified = 0;

  for (const row of rows) {
    const publishResult = await publishRealtimeEvent(env, {
      type: 'invite.updated',
      targets: [row.sender_user_id, row.receiver_user_id],
      payload: {
        inviteId: row.id,
        senderUserId: row.sender_user_id,
        receiverUserId: row.receiver_user_id,
        status: 'canceled',
        canceledBy: 'system_timeout',
        respondedAt: row.responded_at || now,
        updatedAt: row.updated_at || now,
      },
      ts: Date.now(),
    });

    if (!publishResult?.ok) continue;

    await env.DB
      .prepare(
        `UPDATE contact_invites
         SET timeout_notified_at = ?
         WHERE id = ? AND timeout_notified_at IS NULL`,
      )
      .bind(now, row.id)
      .run();

    notified += 1;
  }

  return { attempted: rows.length, notified };
}

async function run(context) {
  const { env, request } = context;
  if (!env.DB) return error('DB binding is missing', 500);
  if (!isCronAuthorized(env, request)) return error('Unauthorized', 401);

  const now = nowSec();

  const expired = await expirePendingInvites(env, now);
  const notifyStat = await notifyTimeoutCanceledInvites(env, now);

  return json({
    ok: true,
    now,
    expiredCount: expired.length,
    notifyAttempted: notifyStat.attempted,
    notifySucceeded: notifyStat.notified,
  });
}

export async function onRequestPost(context) {
  return run(context);
}

export async function onRequestGet(context) {
  return run(context);
}
