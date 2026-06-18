import { createId, nowSec } from './auth';

export async function writeAuthAuditLog(env, payload) {
  if (!env?.DB) return;

  const {
    request = null,
    eventType,
    email = null,
    userId = null,
    metadata = null,
  } = payload || {};

  if (!eventType) return;

  const ip = request?.headers?.get('CF-Connecting-IP') || null;
  const userAgent = request?.headers?.get('user-agent') || null;
  const metadataJson = metadata ? JSON.stringify(metadata) : null;

  try {
    await env.DB.prepare(
      `INSERT INTO auth_audit_logs
        (id, event_type, email, user_id, ip, user_agent, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(createId(), eventType, email, userId, ip, userAgent, metadataJson, nowSec())
      .run();
  } catch {
    // Audit logging must not break auth flow.
  }
}

