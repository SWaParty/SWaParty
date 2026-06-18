import { writeAuthAuditLog } from '../../_lib/audit';
import {
  hashToken,
  normalizeEmail,
  nowSec,
  validateEmail,
} from '../../_lib/auth';
import { error, json, readJson } from '../../_lib/http';
import { findUserBySessionToken, readSessionTokenFromRequest } from '../../_lib/session';
import { ensureSupportedLocale } from '../../_lib/locale';
import { publishRealtimeEvent } from '../../_lib/realtime';

function sanitizeDisplayName(input, fallbackEmail) {
  const trimmed = String(input ?? '').trim();
  if (trimmed) return trimmed.slice(0, 48);
  return String(fallbackEmail || '').split('@')[0] || 'Guest';
}

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

async function notifyProfileChanged(env, user) {
  if (!user?.id) return;
  try {
    await publishRealtimeEvent(env, {
      type: 'profile.updated',
      targets: [user.id],
      payload: {
        userId: user.id,
        publicId: user.publicId || null,
        email: user.email,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl || null,
        locale: user.locale || 'en',
      },
      ts: Date.now(),
    });
  } catch {
    // Profile save must not fail because realtime fanout failed.
  }
}

async function getCurrentSessionUser(context) {
  const { request, env } = context;
  const rawToken = readSessionTokenFromRequest(request);
  if (!rawToken) return null;
  const session = await findUserBySessionToken(env, rawToken);
  if (!session || session.status !== 'active') return null;
  return session;
}

export async function onRequestGet(context) {
  const { env } = context;
  if (!env.DB) return error('DB binding is missing', 500);

  const session = await getCurrentSessionUser(context);
  if (!session) return error('Unauthorized', 401);

  const now = nowSec();
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
    .bind(now, session.user_id)
    .first();

  if (!row) return error('User not found', 404);

  const identities = await env.DB
    .prepare(
      `SELECT provider
       FROM auth_identities
       WHERE user_id = ?
       ORDER BY linked_at DESC`,
    )
    .bind(session.user_id)
    .all();

  const providers = (identities?.results || []).map((item) => item.provider).filter(Boolean);

  return json({
    ok: true,
    user: toPublicUser(row),
    providers,
  });
}

export async function onRequestPatch(context) {
  const { env, request } = context;
  if (!env.DB) return error('DB binding is missing', 500);

  const session = await getCurrentSessionUser(context);
  if (!session) return error('Unauthorized', 401);

  const body = await readJson(request);
  if (!body) return error('Invalid JSON body', 400);

  const includesPasswordFields = ['oldPassword', 'newPassword', 'confirmPassword']
    .some((field) => Object.prototype.hasOwnProperty.call(body, field));
  if (includesPasswordFields) {
    return error('Use /api/auth/profile/password for password changes', 400, {
      fieldErrors: [{ field: 'password', code: 'password_failed' }],
    });
  }

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

  const displayNameProvided = Object.prototype.hasOwnProperty.call(body, 'displayName');
  const displayName = sanitizeDisplayName(displayNameProvided ? body.displayName : row.display_name, row.email);
  const localeProvided = Object.prototype.hasOwnProperty.call(body, 'locale');
  const nextLocale = localeProvided ? ensureSupportedLocale(body.locale, row.locale || 'en') : (row.locale || 'en');
  const nextEmailRaw = Object.prototype.hasOwnProperty.call(body, 'newEmail') ? body.newEmail : null;
  const nextEmail = nextEmailRaw == null ? null : normalizeEmail(nextEmailRaw);
  const emailCode = String(body.emailCode || '').trim();
  const wantsEmailChange = Boolean(nextEmail && nextEmail !== row.email);

  const fieldErrorFields = new Set();
  const now = nowSec();
  let verifiedEmailChangeRequest = null;

  if (wantsEmailChange) {
    const emailFormatOk = validateEmail(nextEmail);
    const emailCodeFormatOk = /^\d{6}$/.test(emailCode);
    if (!emailFormatOk) {
      fieldErrorFields.add('email');
    }
    if (!emailCodeFormatOk) {
      fieldErrorFields.add('email');
    }

    const existingUser = await env.DB
      .prepare('SELECT id FROM users WHERE email = ? AND id <> ? LIMIT 1')
      .bind(nextEmail, row.id)
      .first();
    if (existingUser) {
      fieldErrorFields.add('email');
    }

    if (emailFormatOk && emailCodeFormatOk && !existingUser) {
      const codeHash = await hashToken(emailCode);
      const pendingReq = await env.DB
        .prepare(
          `SELECT id, token_hash, token_expires_at
           FROM email_change_requests
           WHERE user_id = ? AND new_email = ? AND status = 'pending'
           ORDER BY requested_at DESC
           LIMIT 1`,
        )
        .bind(row.id, nextEmail)
        .first();
      if (!pendingReq) {
        fieldErrorFields.add('email');
      } else if (now > pendingReq.token_expires_at) {
        await env.DB
          .prepare(`UPDATE email_change_requests SET status = 'expired', consumed_at = ? WHERE id = ?`)
          .bind(now, pendingReq.id)
          .run();
        fieldErrorFields.add('email');
      } else if (pendingReq.token_hash !== codeHash) {
        await writeAuthAuditLog(env, {
          request,
          eventType: 'email_change_verify_failed',
          email: row.email,
          userId: row.id,
          metadata: { reason: 'code_mismatch', newEmail: nextEmail },
        });
        fieldErrorFields.add('email');
      } else {
        verifiedEmailChangeRequest = pendingReq;
      }
    }
  }

  if (fieldErrorFields.size > 0) {
    return error('Validation failed', 400, {
      fieldErrors: Array.from(fieldErrorFields).map((field) => ({
        field,
        code: `${field}_failed`,
      })),
    });
  }

  if (displayName !== (row.display_name || row.email.split('@')[0] || 'Guest')) {
    try {
      await env.DB
        .prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?')
        .bind(displayName, now, row.id)
        .run();
    } catch {
      return error('Failed to update display name', 500, {
        fieldErrors: [{ field: 'displayName', code: 'displayName_failed' }],
      });
    }

    await writeAuthAuditLog(env, {
      request,
      eventType: 'profile_updated',
      email: row.email,
      userId: row.id,
      metadata: { fields: ['display_name'] },
    });
  }

  let emailChanged = false;
  let pendingEmail = null;
  if (wantsEmailChange) {
    const pendingReq = verifiedEmailChangeRequest;
    if (!pendingReq) {
      return error('Email verification failed', 400, {
        fieldErrors: [{ field: 'email', code: 'email_failed' }],
      });
    }

    try {
      await env.DB.batch([
        env.DB
          .prepare('UPDATE users SET email = ?, email_verified_at = ?, updated_at = ? WHERE id = ?')
          .bind(nextEmail, now, now, row.id),
        env.DB
          .prepare(`UPDATE auth_identities SET provider_email = ?, provider_email_verified = 1 WHERE user_id = ? AND provider = 'email'`)
          .bind(nextEmail, row.id),
        env.DB
          .prepare(`UPDATE email_change_requests SET status = 'verified', consumed_at = ? WHERE id = ?`)
          .bind(now, pendingReq.id),
        env.DB
          .prepare(`UPDATE email_change_requests SET status = 'canceled', consumed_at = ? WHERE user_id = ? AND status = 'pending' AND id <> ?`)
          .bind(now, row.id, pendingReq.id),
      ]);
    } catch {
      return error('Failed to update email', 500, {
        fieldErrors: [{ field: 'email', code: 'email_failed' }],
      });
    }

    await writeAuthAuditLog(env, {
      request,
      eventType: 'email_changed',
      email: nextEmail,
      userId: row.id,
      metadata: { oldEmail: row.email, newEmail: nextEmail, requestId: pendingReq.id },
    });

    emailChanged = true;
    pendingEmail = nextEmail;
  }

  if (nextLocale !== (row.locale || 'en')) {
    try {
      await env.DB
        .prepare('UPDATE users SET locale = ?, updated_at = ? WHERE id = ?')
        .bind(nextLocale, now, row.id)
        .run();
    } catch {
      return error('Failed to update locale', 500, {
        fieldErrors: [{ field: 'locale', code: 'locale_failed' }],
      });
    }
  }

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

  const publicUser = toPublicUser(refreshed);
  context.waitUntil?.(notifyProfileChanged(env, publicUser));

  return json({
    ok: true,
    message: emailChanged ? 'Profile and email updated' : 'Profile updated',
    user: publicUser,
    passwordChanged: false,
    emailChanged,
    pendingEmail,
  });
}



