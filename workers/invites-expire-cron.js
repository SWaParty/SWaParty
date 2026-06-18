function trimText(value) {
  return String(value || '').trim();
}

async function triggerExpireJob(env) {
  const targetUrl = trimText(env?.CRON_TARGET_URL);
  if (!targetUrl) {
    return { ok: false, status: 500, error: 'missing CRON_TARGET_URL' };
  }

  const secret = trimText(env?.CRON_SECRET);
  const headers = {
    'content-type': 'application/json',
  };
  if (secret) {
    headers.authorization = `Bearer ${secret}`;
  }

  try {
    const resp = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ source: 'cloudflare-cron-worker' }),
    });
    const data = await resp.json().catch(() => ({}));
    return {
      ok: resp.ok,
      status: resp.status,
      data,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: trimText(err?.message) || 'fetch_failed',
    };
  }
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(triggerExpireJob(env));
  },

  async fetch(_request, env) {
    const result = await triggerExpireJob(env);
    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 500,
      headers: {
        'content-type': 'application/json; charset=utf-8',
      },
    });
  },
};

