import { nowSec } from '../../../_lib/auth';
import { error, json } from '../../../_lib/http';
import { publishRealtimeEvent } from '../../../_lib/realtime';
import { findUserBySessionToken, readSessionTokenFromRequest } from '../../../_lib/session';
import { normalizePublicOrigin } from '../../../_lib/media';

const MAX_AVATAR_BYTES = 10 * 1024 * 1024;

function avatarFieldError(message, status = 400, code = 'avatar_failed') {
  return error(message, status, {
    fieldErrors: [{ field: 'avatar', code }],
    errorCode: code,
  });
}

function extFromMime(mime) {
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'image/avif') return 'avif';
  const subtype = String(mime || '').split('/')[1] || '';
  const sanitized = subtype.split('+')[0].replace(/[^a-z0-9]/gi, '').toLowerCase();
  return sanitized || 'img';
}

function getAvatarPublicOrigin(env) {
  return normalizePublicOrigin(env?.AVATAR_PUBLIC_ORIGIN || 'https://avatars.example.com');
}

function keyFromPublicUrl(url, baseUrl) {
  const normalizedBase = normalizePublicOrigin(baseUrl);
  if (!normalizedBase || !url || !String(url).startsWith(`${normalizedBase}/`)) return null;
  return String(url).slice(normalizedBase.length + 1);
}

async function notifyProfileChanged(env, session, avatarUrl) {
  try {
    await publishRealtimeEvent(env, {
      type: 'profile.updated',
      targets: [session.user_id],
      payload: {
        userId: session.user_id,
        publicId: session.public_id || null,
        email: session.email,
        displayName: session.display_name || session.email?.split('@')[0] || 'Guest',
        avatarUrl,
        locale: session.locale || 'en',
      },
      ts: Date.now(),
    });
  } catch {
    // Profile save must not fail because realtime fanout failed.
  }
}

async function getCurrentSessionUser(context) {
  const rawToken = readSessionTokenFromRequest(context.request);
  if (!rawToken) return null;
  const session = await findUserBySessionToken(context.env, rawToken);
  if (!session || session.status !== 'active') return null;
  return session;
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return avatarFieldError('DB binding is missing', 500, 'missing_db_binding');
  if (!env.AVATARS) return avatarFieldError('R2 binding is missing', 500, 'missing_r2_binding');

  const session = await getCurrentSessionUser(context);
  if (!session) return error('Unauthorized', 401, { errorCode: 'unauthorized' });

  const rawContentType = String(request.headers.get('content-type') || '');
  const contentTypeMain = rawContentType.split(';')[0].trim().toLowerCase();
  let avatar = null;

  if (contentTypeMain.startsWith('multipart/form-data')) {
    let form;
    try {
      form = await request.formData();
    } catch {
      return avatarFieldError('Invalid form data', 400, 'invalid_form_data');
    }

    const formAvatar = form.get('avatar');
    if (!formAvatar || typeof formAvatar.arrayBuffer !== 'function') {
      return avatarFieldError('Avatar file is required', 400, 'avatar_file_missing');
    }
    avatar = formAvatar;
  } else if (contentTypeMain.startsWith('image/')) {
    const rawBytes = await request.arrayBuffer();
    let fileNameHeader = String(request.headers.get('x-avatar-filename') || '').trim();
    try {
      fileNameHeader = decodeURIComponent(fileNameHeader);
    } catch {
      // ignore malformed header value
    }
    avatar = {
      type: contentTypeMain,
      size: rawBytes.byteLength,
      name: fileNameHeader || `avatar-${Date.now()}`,
      arrayBuffer: async () => rawBytes,
    };
  } else {
    return avatarFieldError('Invalid avatar content type', 400, 'invalid_avatar_content_type');
  }

  const mimeType = String(avatar.type || '').toLowerCase();
  if (!mimeType.startsWith('image/')) {
    return avatarFieldError('Unsupported avatar type', 400, 'avatar_type_not_allowed');
  }

  if (!Number.isFinite(Number(avatar.size)) || Number(avatar.size) <= 0) {
    return avatarFieldError('Avatar file is required', 400, 'avatar_file_missing');
  }

  if (avatar.size > MAX_AVATAR_BYTES) {
    return avatarFieldError('Avatar file too large', 400, 'avatar_file_too_large');
  }

  const now = nowSec();
  const currentUser = await env.DB
    .prepare('SELECT avatar_url FROM users WHERE id = ? LIMIT 1')
    .bind(session.user_id)
    .first();
  if (!currentUser) return avatarFieldError('User not found', 404, 'user_not_found');

  const ext = extFromMime(mimeType);
  const randomPart = (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '');
  const objectKey = `users/${session.user_id}/${now}-${randomPart}.${ext}`;

  const bytes = await avatar.arrayBuffer();
  try {
    await env.AVATARS.put(objectKey, bytes, {
      httpMetadata: {
        contentType: mimeType,
        cacheControl: 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return avatarFieldError('Failed to upload avatar', 500, 'r2_put_failed');
  }

  const publicBaseUrl = getAvatarPublicOrigin(env);
  const avatarUrl = `${publicBaseUrl}/${objectKey}`;

  try {
    await env.DB
      .prepare('UPDATE users SET avatar_url = ?, updated_at = ? WHERE id = ?')
      .bind(avatarUrl, now, session.user_id)
      .run();
  } catch {
    return avatarFieldError('Failed to save avatar', 500, 'db_update_failed');
  }

  const oldKey = keyFromPublicUrl(currentUser.avatar_url, publicBaseUrl);
  if (oldKey && oldKey !== objectKey) {
    try {
      await env.AVATARS.delete(oldKey);
    } catch {
      // ignore old object cleanup failures
    }
  }

  context.waitUntil?.(notifyProfileChanged(env, session, avatarUrl));

  return json({
    ok: true,
    avatarUrl,
    user: {
      id: session.user_id,
      publicId: session.public_id || null,
      email: session.email,
      displayName: session.display_name,
      avatarUrl,
      locale: session.locale || 'en',
    },
  });
}
