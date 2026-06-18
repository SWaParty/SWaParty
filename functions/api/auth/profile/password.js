import { writeAuthAuditLog } from '../../../_lib/audit';
import { getPasswordIssueCode, hashPassword, hashToken, nowSec, verifyPassword } from '../../../_lib/auth';
import { error, json, readJson } from '../../../_lib/http';
import { findUserBySessionToken, readSessionTokenFromRequest } from '../../../_lib/session';

function toPublicUser(row) {
  return {
    id: row.id,
    publicId: row.public_id || null,
    email: row.email,
    displayName: row.display_name || row.email.split('@')[0] || 'Guest',
    avatarUrl: row.avatar_url || null,
    locale: row.locale || 'en',
    status: row.status,
    emailVerifiedAt: row.email_verified_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    passwordUpdatedAt: row.password_updated_at || null,
    hasPassword: Boolean(row.has_password),
    activeSessionCount: Number(row.active_session_count || 0),
    twoFactorEnabled: Boolean(row.mfa_enabled),
    twoFactorEnrolledAt: row.mfa_enrolled_at || null,
    twoFactorLastVerifiedAt: row.mfa_last_verified_at || null,
  };
}

async function getCurrentSessionUser(context) {
  const rawToken = readSessionTokenFromRequest(context.request);
  if (!rawToken) return null;
  const session = await findUserBySessionToken(context.env, rawToken);
  if (!session || session.status !== 'active') return null;
  return session;
}

export async function onRequestPatch(context) {
  const { env, request } = context;
  if (!env.DB) return error('DB binding is missing', 500);

  const rawToken = readSessionTokenFromRequest(request);
  const session = await getCurrentSessionUser(context);
  if (!session) return error('Unauthorized', 401);

  const body = await readJson(request);
  if (!body) return error('Invalid JSON body', 400);

  const row = await env.DB
    .prepare(
      `SELECT
         u.id,
         u.public_id,
         u.email,
         u.display_name,
         u.avatar_url,
         u.locale,
         u.status,
         u.email_verified_at,
         u.created_at,
         u.updated_at,
         c.password_hash,
         c.password_updated_at,
         CASE WHEN c.password_hash IS NULL THEN 0 ELSE 1 END AS has_password,
         COALESCE(m.enabled, 0) AS mfa_enabled,
         m.enrolled_at AS mfa_enrolled_at,
         m.last_verified_at AS mfa_last_verified_at
       FROM users u
       LEFT JOIN auth_credentials c ON c.user_id = u.id
       LEFT JOIN auth_mfa_totp m ON m.user_id = u.id
       WHERE u.id = ?
       LIMIT 1`,
    )
    .bind(session.user_id)
    .first();

  if (!row) return error('User not found', 404);

  const oldPassword = String(body.oldPassword || '');
  const newPassword = String(body.newPassword || '');
  const confirmPassword = String(body.confirmPassword || '');
  const hasPassword = Boolean(row.has_password);
  const wantsPasswordChange = Boolean(oldPassword || newPassword || confirmPassword);
  if (!wantsPasswordChange) {
    return error('Validation failed', 400, {
      fieldErrors: [{ field: 'password', code: 'password_empty' }],
    });
  }

  const fieldErrors = [];
  if (!newPassword || !confirmPassword) {
    fieldErrors.push({ field: 'password', code: 'password_required' });
  }
  const passwordIssueCode = newPassword ? getPasswordIssueCode(newPassword) : '';
  if (passwordIssueCode) fieldErrors.push({ field: 'password', code: passwordIssueCode });
  if (newPassword && confirmPassword && newPassword !== confirmPassword) {
    fieldErrors.push({ field: 'password', code: 'password_mismatch' });
  }
  if (hasPassword && oldPassword && newPassword && oldPassword === newPassword) {
    fieldErrors.push({ field: 'password', code: 'password_same_as_old' });
  }
  if (hasPassword) {
    if (!oldPassword) {
      fieldErrors.push({ field: 'password', code: 'password_required' });
    }
    if (oldPassword) {
      const oldPasswordOk = await verifyPassword(oldPassword, row.password_hash);
      if (!oldPasswordOk) {
        await writeAuthAuditLog(env, {
          request,
          eventType: 'password_change_failed',
          email: row.email,
          userId: row.id,
          metadata: { reason: 'old_password_mismatch' },
        });
        fieldErrors.push({ field: 'password', code: 'password_old_incorrect' });
      }
    }
  }

  if (fieldErrors.length > 0) {
    return error('Validation failed', 400, {
      fieldErrors,
    });
  }

  const now = nowSec();
  try {
    const nextPasswordHash = await hashPassword(newPassword);
    await env.DB
      .prepare(
        `INSERT INTO auth_credentials
          (user_id, password_hash, password_algo, password_updated_at, created_at)
         VALUES (?, ?, 'pbkdf2_sha256', ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           password_hash = excluded.password_hash,
           password_algo = excluded.password_algo,
           password_updated_at = excluded.password_updated_at`,
      )
      .bind(row.id, nextPasswordHash, now, now)
      .run();

    if (rawToken) {
      const currentTokenHash = await hashToken(rawToken);
      await env.DB
        .prepare('UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND refresh_token_hash <> ?')
        .bind(now, row.id, currentTokenHash)
        .run();
    }
  } catch {
    return error('Failed to update password', 500, {
      fieldErrors: [{ field: 'password', code: 'password_update_failed' }],
    });
  }

  await writeAuthAuditLog(env, {
    request,
    eventType: 'password_changed',
    email: row.email,
    userId: row.id,
    metadata: { sessionRevoked: true, keepCurrentSession: true },
  });

  const refreshed = await env.DB
    .prepare(
      `SELECT
         u.id,
         u.public_id,
         u.email,
         u.display_name,
         u.avatar_url,
         u.locale,
         u.status,
         u.email_verified_at,
         u.created_at,
         u.updated_at,
         c.password_updated_at,
         CASE WHEN c.password_hash IS NULL THEN 0 ELSE 1 END AS has_password,
         COALESCE(m.enabled, 0) AS mfa_enabled,
         m.enrolled_at AS mfa_enrolled_at,
         m.last_verified_at AS mfa_last_verified_at,
         (
           SELECT COUNT(1)
           FROM user_sessions s
           WHERE s.user_id = u.id
             AND s.revoked_at IS NULL
             AND s.expires_at > ?
         ) AS active_session_count
       FROM users u
       LEFT JOIN auth_credentials c ON c.user_id = u.id
       LEFT JOIN auth_mfa_totp m ON m.user_id = u.id
       WHERE u.id = ?
       LIMIT 1`,
    )
    .bind(now, row.id)
    .first();

  return json({
    ok: true,
    message: 'Password updated',
    user: toPublicUser(refreshed),
    passwordChanged: true,
    emailChanged: false,
    pendingEmail: null,
  });
}
