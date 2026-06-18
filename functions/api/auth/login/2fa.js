import { error, json, readJson } from '../../../_lib/http';
import { nowSec } from '../../../_lib/auth';
import { buildSessionSetCookie, createUserSession } from '../../../_lib/session';
import { appendRecoveryCodes, decryptRecoveryCode, decryptTotpSecret, verifyTotpCode } from '../../../_lib/mfa';
import { writeAuthAuditLog } from '../../../_lib/audit';

const enc = new TextEncoder();

function normalizeBackupCode(input) {
  return String(input || '').replace(/\D/g, '').slice(0, 8);
}

async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(String(input || '')));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return error('DB binding is missing', 500);

  const body = await readJson(request);
  if (!body) return error('Invalid JSON body', 400);

  const challengeId = String(body.challengeId || '').trim();
  const code = String(body.code || '').trim();
  const backupCode = normalizeBackupCode(body.backupCode);
  const useTotp = /^\d{6}$/.test(code);
  const useBackupCode = /^\d{8}$/.test(backupCode);
  if (!challengeId || (!useTotp && !useBackupCode)) return error('Invalid challenge or code', 400);

  const now = nowSec();
  const challenge = await env.DB
    .prepare(
      `SELECT c.id, c.user_id, c.expires_at, c.consumed_at, c.attempts, u.email, u.display_name, u.avatar_url, u.public_id, u.status
       FROM auth_mfa_challenges c
       JOIN users u ON u.id = c.user_id
       WHERE c.id = ? AND c.purpose = 'login'
       LIMIT 1`,
    )
    .bind(challengeId)
    .first();

  if (!challenge) return error('Challenge not found', 404);
  if (challenge.status !== 'active') return error('Account is not active', 403);
  if (challenge.consumed_at) return error('Challenge already used', 400);
  if (now > challenge.expires_at) return error('Challenge expired', 400);
  if (Number(challenge.attempts || 0) >= 8) return error('Too many attempts', 429);

  const mfa = await env.DB
    .prepare(
      `SELECT enabled, secret_ciphertext
       FROM auth_mfa_totp
       WHERE user_id = ?
       LIMIT 1`,
    )
    .bind(challenge.user_id)
    .first();
  if (!mfa?.enabled || !mfa?.secret_ciphertext) return error('2FA is not enabled', 400);

  let recoveryCodeRecord = null;

  if (useTotp) {
    let secret;
    try {
      secret = await decryptTotpSecret(env, mfa.secret_ciphertext);
    } catch {
      return error('2FA secret decrypt failed', 500);
    }

    const valid = await verifyTotpCode({ secret, code, atSec: now });
    if (!valid) {
      await env.DB
        .prepare('UPDATE auth_mfa_challenges SET attempts = attempts + 1 WHERE id = ?')
        .bind(challenge.id)
        .run();
      await writeAuthAuditLog(env, {
        request,
        eventType: 'login_2fa_failed',
        email: challenge.email,
        userId: challenge.user_id,
        metadata: { challengeId, reason: 'code_mismatch', method: 'totp' },
      });
      return error('Invalid code', 401);
    }
  } else {
    const hash = await sha256Hex(backupCode);
    recoveryCodeRecord = await env.DB
      .prepare(
        `SELECT id
         FROM auth_mfa_recovery_codes
         WHERE user_id = ? AND code_hash = ? AND used_at IS NULL
         LIMIT 1`,
      )
      .bind(challenge.user_id, hash)
      .first();

    if (!recoveryCodeRecord) {
      await env.DB
        .prepare('UPDATE auth_mfa_challenges SET attempts = attempts + 1 WHERE id = ?')
        .bind(challenge.id)
        .run();
      await writeAuthAuditLog(env, {
        request,
        eventType: 'login_2fa_failed',
        email: challenge.email,
        userId: challenge.user_id,
        metadata: { challengeId, reason: 'backup_code_mismatch', method: 'backup_code' },
      });
      return error('Invalid code', 401);
    }
  }

  const { rawToken, expiresAt } = await createUserSession(env, { userId: challenge.user_id, request });
  const headers = new Headers();
  headers.append('Set-Cookie', buildSessionSetCookie(rawToken, request.url));

  const successWrites = [
    env.DB
      .prepare('UPDATE auth_mfa_challenges SET consumed_at = ? WHERE id = ?')
      .bind(now, challenge.id),
    env.DB
      .prepare('UPDATE auth_mfa_totp SET last_verified_at = ?, updated_at = ? WHERE user_id = ?')
      .bind(now, now, challenge.user_id),
  ];

  if (recoveryCodeRecord?.id) {
    successWrites.push(
      env.DB
        .prepare('UPDATE auth_mfa_recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL')
        .bind(now, recoveryCodeRecord.id),
    );
  }

  await env.DB.batch(successWrites);

  let backupTopUpSucceeded = true;
  let recoveryCodes = null;
  if (recoveryCodeRecord?.id) {
    try {
      await appendRecoveryCodes(env, challenge.user_id, { count: 1 });
    } catch {
      backupTopUpSucceeded = false;
    }

    const rows = await env.DB
      .prepare(
        `SELECT code_ciphertext
         FROM auth_mfa_recovery_codes
         WHERE user_id = ? AND used_at IS NULL
         ORDER BY created_at ASC`,
      )
      .bind(challenge.user_id)
      .all();
    const codes = [];
    for (const item of rows?.results || []) {
      if (!item?.code_ciphertext) continue;
      try {
        codes.push(await decryptRecoveryCode(env, item.code_ciphertext));
      } catch {
        // skip invalid row
      }
    }
    recoveryCodes = codes;
  }

  await writeAuthAuditLog(env, {
    request,
    eventType: 'login_2fa_succeeded',
    email: challenge.email,
    userId: challenge.user_id,
    metadata: {
      challengeId,
      expiresAt,
      method: useTotp ? 'totp' : 'backup_code',
      backupTopUpSucceeded,
    },
  });

  return json(
    {
      ok: true,
      message: '2FA verification successful',
      session: { expiresAt },
      user: {
        id: challenge.user_id,
        publicId: challenge.public_id || null,
        email: challenge.email,
        displayName: challenge.display_name,
        avatarUrl: challenge.avatar_url || null,
      },
      recoveryCodes,
    },
    { headers },
  );
}
