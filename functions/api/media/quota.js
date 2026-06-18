import {
  DEFAULT_MEDIA_DURATION_QUOTA_SEC,
  DEFAULT_MEDIA_STORAGE_QUOTA_BYTES,
  requireSessionUser,
} from '../../_lib/media';
import { json } from '../../_lib/http';

function numberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export async function onRequestGet(context) {
  const { env } = context;
  if (!env.DB) return json({ ok: false, error: 'DB binding is missing' }, { status: 500 });

  const session = await requireSessionUser(context);
  if (!session) return json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const result = await env.DB
    .prepare(
      `SELECT max_storage_bytes, max_duration_sec, used_storage_bytes, used_duration_sec
       FROM user_media_quota
       WHERE user_id = ?
       LIMIT 1`,
    )
    .bind(session.user_id)
    .first();

  const maxStorageBytes = numberOrDefault(result?.max_storage_bytes, DEFAULT_MEDIA_STORAGE_QUOTA_BYTES);
  const maxDurationSec = numberOrDefault(result?.max_duration_sec, DEFAULT_MEDIA_DURATION_QUOTA_SEC);
  const usedStorageBytes = Math.min(numberOrDefault(result?.used_storage_bytes, 0), maxStorageBytes);
  const usedDurationSec = Math.min(numberOrDefault(result?.used_duration_sec, 0), maxDurationSec);

  return json({
    ok: true,
    quota: {
      maxStorageBytes,
      usedStorageBytes,
      availableStorageBytes: Math.max(maxStorageBytes - usedStorageBytes, 0),
      storagePercent: maxStorageBytes > 0 ? Math.min((usedStorageBytes / maxStorageBytes) * 100, 100) : 0,
      maxDurationSec,
      usedDurationSec,
      availableDurationSec: Math.max(maxDurationSec - usedDurationSec, 0),
    },
  });
}
