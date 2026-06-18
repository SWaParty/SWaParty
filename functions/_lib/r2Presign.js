const enc = new TextEncoder();

function toHex(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function encodeRfc3986(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeS3Path(pathname) {
  return String(pathname || '')
    .split('/')
    .map((segment) => encodeRfc3986(segment))
    .join('/');
}

async function sha256Hex(message) {
  const data = typeof message === 'string' ? enc.encode(message) : message;
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(digest);
}

async function hmacSha256Raw(keyBytes, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', key, enc.encode(message));
}

async function getSigningKey(secretAccessKey, shortDate, region, service = 's3') {
  const kDate = await hmacSha256Raw(enc.encode(`AWS4${secretAccessKey}`), shortDate);
  const kRegion = await hmacSha256Raw(kDate, region);
  const kService = await hmacSha256Raw(kRegion, service);
  return hmacSha256Raw(kService, 'aws4_request');
}

function xmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeEndpoint(rawValue, bucketName) {
  const value = String(rawValue || '').trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    const pathSegments = url.pathname.split('/').filter(Boolean);
    const normalizedBucketName = String(bucketName || '').trim();
    const basePath = pathSegments[0] === normalizedBucketName
      ? `/${encodeS3Path(pathSegments.join('/'))}`
      : '';
    url.pathname = '';
    url.search = '';
    url.hash = '';
    url.basePath = basePath;
    return url;
  } catch {
    return null;
  }
}

function isCloudflareR2S3Endpoint(endpoint) {
  return String(endpoint?.hostname || '').toLowerCase().endsWith('.r2.cloudflarestorage.com');
}

export function getMediaPresignConfig(env) {
  const accessKeyId = String(env.R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY || '').trim();
  const bucketName = String(env.R2_BUCKET_NAME || '').trim();
  const endpoint = normalizeEndpoint(env.R2_S3_ENDPOINT || env.R2_ENDPOINT, bucketName);
  const region = String(env.R2_REGION || 'auto').trim() || 'auto';
  const expiresInSec = Math.max(60, Math.min(7 * 24 * 60 * 60, Number(env.R2_PRESIGN_EXPIRES_SEC || 86400) || 86400));

  if (!endpoint || !accessKeyId || !secretAccessKey || !bucketName) return null;
  if (!isCloudflareR2S3Endpoint(endpoint)) return null;

  return {
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucketName,
    region,
    expiresInSec,
  };
}

export async function createR2UploadPartPresignedUrl({
  endpoint,
  accessKeyId,
  secretAccessKey,
  bucketName,
  objectKey,
  uploadId,
  partNumber,
  region = 'auto',
  expiresInSec = 86400,
  now = new Date(),
}) {
  const requestDate = new Date(now);
  const iso = requestDate.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const amzDate = iso.slice(0, 15) + 'Z';
  const shortDate = amzDate.slice(0, 8);
  const credentialScope = `${shortDate}/${region}/s3/aws4_request`;
  const host = endpoint.host;
  const cleanObjectKey = String(objectKey || '').replace(/^\/+/, '');
  const bucketPath = endpoint.basePath || `/${encodeS3Path(bucketName)}`;
  const canonicalUri = `${bucketPath}/${encodeS3Path(cleanObjectKey)}`;

  const query = new URLSearchParams();
  query.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  query.set('X-Amz-Content-Sha256', 'UNSIGNED-PAYLOAD');
  query.set('X-Amz-Credential', `${accessKeyId}/${credentialScope}`);
  query.set('X-Amz-Date', amzDate);
  query.set('X-Amz-Expires', String(expiresInSec));
  query.set('X-Amz-SignedHeaders', 'host');
  query.set('partNumber', String(partNumber));
  query.set('uploadId', String(uploadId || ''));

  const canonicalQuery = Array.from(query.entries())
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)])
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey === rightKey) return leftValue < rightValue ? -1 : (leftValue > rightValue ? 1 : 0);
      return leftKey < rightKey ? -1 : 1;
    })
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  const canonicalHeaders = `host:${host}\n`;
  const canonicalRequest = [
    'PUT',
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = await getSigningKey(secretAccessKey, shortDate, region);
  const signature = toHex(await hmacSha256Raw(signingKey, stringToSign));

  return `${endpoint.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

async function signR2S3Request({
  config,
  method,
  objectKey,
  queryParams = {},
  headers = {},
  body = '',
  now = new Date(),
}) {
  const endpoint = config.endpoint;
  const requestDate = new Date(now);
  const iso = requestDate.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const amzDate = iso.slice(0, 15) + 'Z';
  const shortDate = amzDate.slice(0, 8);
  const credentialScope = `${shortDate}/${config.region}/s3/aws4_request`;
  const host = endpoint.host;
  const cleanObjectKey = String(objectKey || '').replace(/^\/+/, '');
  const bucketPath = endpoint.basePath || `/${encodeS3Path(config.bucketName)}`;
  const canonicalUri = `${bucketPath}/${encodeS3Path(cleanObjectKey)}`;
  const payloadHash = await sha256Hex(typeof body === 'string' ? body : new Uint8Array(body || []));

  const signedHeaders = {
    ...headers,
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const canonicalHeaderEntries = Object.entries(signedHeaders)
    .map(([key, value]) => [String(key).trim().toLowerCase(), String(value).trim().replace(/\s+/g, ' ')])
    .sort(([leftKey], [rightKey]) => (leftKey < rightKey ? -1 : (leftKey > rightKey ? 1 : 0)));
  const signedHeaderNames = canonicalHeaderEntries.map(([key]) => key).join(';');
  const canonicalHeaders = canonicalHeaderEntries.map(([key, value]) => `${key}:${value}\n`).join('');
  const canonicalQuery = Object.entries(queryParams || {})
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)])
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey === rightKey) return leftValue < rightValue ? -1 : (leftValue > rightValue ? 1 : 0);
      return leftKey < rightKey ? -1 : 1;
    })
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaderNames,
    payloadHash,
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');
  const signingKey = await getSigningKey(config.secretAccessKey, shortDate, config.region);
  const signature = toHex(await hmacSha256Raw(signingKey, stringToSign));
  const authorization = [
    'AWS4-HMAC-SHA256 ',
    `Credential=${config.accessKeyId}/${credentialScope}, `,
    `SignedHeaders=${signedHeaderNames}, `,
    `Signature=${signature}`,
  ].join('');
  const query = canonicalQuery ? `?${canonicalQuery}` : '';

  return {
    url: `${endpoint.origin}${canonicalUri}${query}`,
    headers: {
      ...headers,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      Authorization: authorization,
    },
  };
}

async function parseR2Error(response) {
  const text = await response.text().catch(() => '');
  const code = text.match(/<Code>([^<]+)<\/Code>/i)?.[1] || '';
  const message = text.match(/<Message>([^<]+)<\/Message>/i)?.[1] || '';
  return `${response.status} ${response.statusText}${code ? ` ${code}` : ''}${message ? `: ${message}` : ''}`.trim();
}

export async function createR2MultipartUpload({ config, objectKey, contentType, cacheControl }) {
  const signed = await signR2S3Request({
    config,
    method: 'POST',
    objectKey,
    queryParams: { uploads: '' },
    headers: {
      ...(contentType ? { 'content-type': contentType } : {}),
      ...(cacheControl ? { 'cache-control': cacheControl } : {}),
    },
    body: '',
  });
  const response = await fetch(signed.url, {
    method: 'POST',
    headers: signed.headers,
  });
  const text = await response.text();
  if (!response.ok) {
    const code = text.match(/<Code>([^<]+)<\/Code>/i)?.[1] || '';
    const message = text.match(/<Message>([^<]+)<\/Message>/i)?.[1] || '';
    throw new Error(`r2_create_multipart_failed_${response.status}${code ? `_${code}` : ''}${message ? `_${message}` : ''}`);
  }
  const uploadId = text.match(/<UploadId>([^<]+)<\/UploadId>/i)?.[1] || '';
  if (!uploadId) throw new Error('r2_create_multipart_missing_upload_id');
  return { uploadId };
}

export async function completeR2MultipartUpload({ config, objectKey, uploadId, parts }) {
  const body = [
    '<CompleteMultipartUpload>',
    ...(parts || []).map((part) => (
      `<Part><PartNumber>${Number(part.partNumber)}</PartNumber><ETag>${xmlEscape(part.etag)}</ETag></Part>`
    )),
    '</CompleteMultipartUpload>',
  ].join('');
  const signed = await signR2S3Request({
    config,
    method: 'POST',
    objectKey,
    queryParams: { uploadId },
    headers: { 'content-type': 'application/xml' },
    body,
  });
  const response = await fetch(signed.url, {
    method: 'POST',
    headers: signed.headers,
    body,
  });
  if (!response.ok) {
    throw new Error(`r2_complete_multipart_failed_${await parseR2Error(response)}`);
  }
}

export async function abortR2MultipartUpload({ config, objectKey, uploadId }) {
  const signed = await signR2S3Request({
    config,
    method: 'DELETE',
    objectKey,
    queryParams: { uploadId },
    body: '',
  });
  const response = await fetch(signed.url, {
    method: 'DELETE',
    headers: signed.headers,
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`r2_abort_multipart_failed_${await parseR2Error(response)}`);
  }
}

export async function createMultipartUploadPartUrlMap({
  config,
  objectKey,
  uploadId,
  partsTotal,
  excludePartNumbers = [],
}) {
  const uploaded = new Set(
    (excludePartNumbers || [])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0),
  );
  const signedPartUrls = {};

  for (let partNumber = 1; partNumber <= partsTotal; partNumber += 1) {
    if (uploaded.has(partNumber)) continue;
    signedPartUrls[String(partNumber)] = await createR2UploadPartPresignedUrl({
      endpoint: config.endpoint,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      bucketName: config.bucketName,
      objectKey,
      uploadId,
      partNumber,
      region: config.region,
      expiresInSec: config.expiresInSec,
    });
  }

  return signedPartUrls;
}
