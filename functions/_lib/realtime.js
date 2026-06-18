function toNonEmptyString(value) {
  const text = String(value || '').trim();
  return text ? text : '';
}

function normalizeTargets(targets) {
  if (!Array.isArray(targets)) return [];
  const out = [];
  const seen = new Set();
  for (const item of targets) {
    const id = toNonEmptyString(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function resolveRealtimeConfig(env) {
  const url = toNonEmptyString(env?.REALTIME_PUBLISH_URL);
  const token = toNonEmptyString(env?.REALTIME_PUBLISH_TOKEN);
  return { url, token };
}

export function isRealtimePublishEnabled(env) {
  const { url, token } = resolveRealtimeConfig(env);
  return Boolean(url && token);
}

export function buildRealtimeEvent({ type, targets, payload = {}, ts = Date.now() }) {
  const eventType = toNonEmptyString(type);
  return {
    type: eventType || 'unknown',
    targets: normalizeTargets(targets),
    payload: payload && typeof payload === 'object' ? payload : {},
    ts: Number.isFinite(Number(ts)) ? Number(ts) : Date.now(),
  };
}

export async function publishRealtimeEvent(env, event, options = {}) {
  const { timeoutMs = 4000 } = options;
  const { url, token } = resolveRealtimeConfig(env);
  if (!url || !token) {
    return { ok: false, skipped: true, status: 0, error: 'realtime_publish_not_configured' };
  }

  const body = buildRealtimeEvent(event || {});
  if (!body.type || body.type === 'unknown') {
    return { ok: false, skipped: true, status: 0, error: 'realtime_publish_invalid_type' };
  }
  if (!Array.isArray(body.targets) || body.targets.length === 0) {
    return { ok: false, skipped: true, status: 0, error: 'realtime_publish_empty_targets' };
  }

  let timer = null;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  if (controller && timeoutMs > 0) {
    timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  }

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller?.signal,
    });

    return {
      ok: resp.ok,
      skipped: false,
      status: resp.status,
      error: resp.ok ? '' : `realtime_publish_http_${resp.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      status: 0,
      error: toNonEmptyString(err?.message) || 'realtime_publish_failed',
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

