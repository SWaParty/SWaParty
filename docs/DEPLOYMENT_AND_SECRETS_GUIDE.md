# SWaParty Deployment And Secrets Guide

This guide explains the deployment surfaces, the secrets each surface needs, and how shared tokens must match across Cloudflare and VPS services.

Use this as the main configuration checklist before deploying. Service-specific runbooks are linked in each section.

## 1. Deployment Surfaces

Recommended production layout:

```text
Cloudflare Pages + Pages Functions
  Frontend, auth APIs, contacts, inbox, media APIs, room BFF proxy

Cloudflare D1
  Users, sessions, contacts, inbox, media metadata, upload sessions, transcode jobs

Cloudflare R2
  Avatar objects and private media objects

Cloudflare Cron Worker
  Scheduled invite expiration

VPS 1: Realtime
  WebSocket connections and authenticated /publish fanout

VPS 2: rmstate
  Spring Boot room-state service and PostgreSQL

VPS 3: Media transcoder
  ffmpeg worker for thumbnails and HLS renditions
```

Minimum deployment:

- Cloudflare Pages + Functions + D1 + R2 are the core app surface.
- Realtime VPS is required for live presence and pushed room/contact/media events.
- `rmstate` VPS is required for durable room state, synchronized playback, room chat, activity logs, and room lifecycle.
- Media transcoder VPS is optional if you do not need server-generated thumbnails/HLS renditions.

For testing, you can combine VPS services on one machine. For production, keep realtime, room-state, and transcoding separate because their workloads and failure modes are different.

## 2. Cloudflare Configuration

### 2.1 Bindings In [`wrangler.toml`](../wrangler.toml)

Replace these placeholders:

```toml
[[d1_databases]]
binding = "DB"
database_name = "CHANGE_ME_D1_DATABASE_NAME"
database_id = "CHANGE_ME_D1_DATABASE_ID"

[[r2_buckets]]
binding = "AVATARS"
bucket_name = "CHANGE_ME_AVATARS_BUCKET"

[[r2_buckets]]
binding = "MEDIA"
bucket_name = "CHANGE_ME_MEDIA_BUCKET"
```

Required changes:

- `CHANGE_ME_D1_DATABASE_NAME`: your Cloudflare D1 database name.
- `CHANGE_ME_D1_DATABASE_ID`: your Cloudflare D1 database ID.
- `CHANGE_ME_AVATARS_BUCKET`: your R2 bucket for avatars.
- `CHANGE_ME_MEDIA_BUCKET`: your R2 bucket for media originals, thumbnails, and HLS outputs.

Apply the D1 schema in [database.sql](database.sql).

### 2.2 Pages Functions Secrets

Configure these in Cloudflare Pages/Workers secrets, not in committed files:

```env
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
OAUTH_REDIRECT_BASE=
OAUTH_STATE_SECRET=

RESEND_API_KEY=
RESEND_FROM=

MFA_TOTP_SECRET_KEY=

REALTIME_WS_JWT_SECRET=
REALTIME_PUBLISH_URL=
REALTIME_PUBLISH_TOKEN=

MEDIA_PUBLIC_ORIGIN=
AVATAR_PUBLIC_ORIGIN=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=
R2_ENDPOINT=
R2_REGION=auto
R2_PRESIGN_EXPIRES_SEC=86400

RMSTATE_BASE_URL=
RMSTATE_INTERNAL_API_TOKEN=

CRON_SECRET=
```

What to change:

- OAuth values come from your Google/GitHub OAuth apps.
- `OAUTH_REDIRECT_BASE` is the public web origin, for example `https://example.com`.
- `OAUTH_STATE_SECRET` is a long random secret used only by Cloudflare Functions.
- `RESEND_API_KEY` and `RESEND_FROM` configure email delivery.
- `MFA_TOTP_SECRET_KEY` encrypts stored TOTP secrets and must remain stable.
- `REALTIME_WS_JWT_SECRET` must match the realtime VPS `JWT_SECRET`.
- `REALTIME_PUBLISH_URL` points to the realtime VPS publish endpoint.
- `REALTIME_PUBLISH_TOKEN` must match the realtime VPS `PUBLISH_TOKEN`.
- `MEDIA_PUBLIC_ORIGIN` and `AVATAR_PUBLIC_ORIGIN` are browser-accessible origins for R2-served objects.
- R2 S3 credentials are used for presigned browser uploads.
- `RMSTATE_BASE_URL` points to the Spring room backend.
- `RMSTATE_INTERNAL_API_TOKEN` must match `SWAPARTY_INTERNAL_API_TOKEN` on the rmstate VPS.
- `CRON_SECRET` must match the secret used by the Cron Worker request.

### 2.3 Cron Worker

In [`wrangler.cron.toml`](../wrangler.cron.toml), replace:

```toml
CRON_TARGET_URL = "https://CHANGE_ME_DOMAIN/api/cron/invites-expire"
```

The Cron Worker also needs `CRON_SECRET`. It must match the Pages Functions `CRON_SECRET`.

## 3. Shared Secret Relationship Map

These values must match exactly:

| Purpose | Cloudflare value | VPS / worker value | Notes |
| --- | --- | --- | --- |
| Browser WS JWT signing | `REALTIME_WS_JWT_SECRET` | Realtime VPS `JWT_SECRET` | Cloudflare signs `/api/realtime/token`; realtime VPS verifies it. |
| Realtime publish auth | `REALTIME_PUBLISH_TOKEN` | Realtime VPS `PUBLISH_TOKEN` | Cloudflare, rmstate, and optional transcoder use this to call `/publish`. |
| rmstate internal API auth | `RMSTATE_INTERNAL_API_TOKEN` | rmstate `SWAPARTY_INTERNAL_API_TOKEN` | Cloudflare BFF calls Spring `/internal/rooms/*`. |
| Invite cron auth | Pages `CRON_SECRET` | Cron Worker `CRON_SECRET` | Cron Worker calls `/api/cron/invites-expire`. |
| Media bucket name | Pages `R2_BUCKET_NAME` | Transcoder `R2_BUCKET_NAME` | Both refer to the same R2 media bucket. |
| Media public origin | Pages `MEDIA_PUBLIC_ORIGIN` | Transcoder `MEDIA_PUBLIC_ORIGIN` | Both must generate URLs for the same public media origin. |
| Realtime URL | Pages `REALTIME_PUBLISH_URL` | rmstate/transcoder `*_PUBLISH_URL` | All publishers should call the same realtime `/publish` endpoint. |

Values that should be unique and not shared unnecessarily:

- OAuth client secrets.
- `OAUTH_STATE_SECRET`.
- `MFA_TOTP_SECRET_KEY`.
- R2 S3 access key and secret.
- Cloudflare API token for the transcoder.
- PostgreSQL password on the rmstate VPS.

## 4. VPS 1: Realtime Service

Purpose:

- Accept browser WebSocket connections.
- Validate short-lived JWTs issued by Cloudflare Functions.
- Receive internal `POST /publish` events.
- Fan out user-targeted realtime events.

Suggested size:

```text
1-2 vCPU
1-2 GB RAM
20+ GB disk
Ubuntu LTS
Docker + Docker Compose
```

Public hostname:

```text
rt.example.com
```

Realtime VPS values:

```env
JWT_SECRET=CHANGE_ME_SAME_AS_REALTIME_WS_JWT_SECRET
PUBLISH_TOKEN=CHANGE_ME_SAME_AS_REALTIME_PUBLISH_TOKEN
```

Related Cloudflare values:

```env
VITE_REALTIME_WS_URL=wss://rt.example.com
REALTIME_WS_JWT_SECRET=CHANGE_ME_SAME_AS_JWT_SECRET
REALTIME_PUBLISH_URL=https://rt.example.com/publish
REALTIME_PUBLISH_TOKEN=CHANGE_ME_SAME_AS_PUBLISH_TOKEN
```

Validation:

```bash
curl -i https://rt.example.com/healthz
```

Then verify that the frontend can call `/api/realtime/token` and connect to `VITE_REALTIME_WS_URL`.

Detailed runbook:

- [Realtime VPS Deploy Guide](VPS_REALTIME_DEPLOY.md)

## 5. VPS 2: rmstate Room Backend

Purpose:

- Store room runtime state.
- Store room members, playback state, messages, danmaku data, activity logs, and room invitations.
- Publish `room.*` events to the realtime VPS after durable mutations.

What it must not do:

- Do not serve MP4 files.
- Do not proxy HLS playlists or segments.
- Do not duplicate the Cloudflare media library as source of truth.

Suggested size:

```text
1-2 vCPU
2+ GB RAM
40+ GB disk
Ubuntu LTS
Docker + Docker Compose
PostgreSQL
Caddy or Nginx
```

Public hostname:

```text
rmstate.example.com
```

Copy [`rmstate/.env.example`](../rmstate/.env.example) to `rmstate/.env`, then replace:

```env
RMSTATE_DOMAIN=rmstate.example.com
POSTGRES_PASSWORD=CHANGE_ME_POSTGRES_PASSWORD
SPRING_DATASOURCE_PASSWORD=CHANGE_ME_POSTGRES_PASSWORD
APP_CORS_ALLOWED_ORIGINS=https://example.com,http://localhost:5173
SWAPARTY_INTERNAL_API_TOKEN=CHANGE_ME_INTERNAL_TOKEN
SWAPARTY_REALTIME_PUBLISH_URL=https://rt.example.com/publish
SWAPARTY_REALTIME_PUBLISH_TOKEN=CHANGE_ME_REALTIME_PUBLISH_TOKEN
```

Related Cloudflare values:

```env
RMSTATE_BASE_URL=https://rmstate.example.com
RMSTATE_INTERNAL_API_TOKEN=CHANGE_ME_SAME_AS_SWAPARTY_INTERNAL_API_TOKEN
```

Important matches:

- `SWAPARTY_INTERNAL_API_TOKEN` must equal Cloudflare `RMSTATE_INTERNAL_API_TOKEN`.
- `SWAPARTY_REALTIME_PUBLISH_TOKEN` must equal realtime VPS `PUBLISH_TOKEN`.
- `SWAPARTY_REALTIME_PUBLISH_URL` should point to the realtime VPS `/publish` endpoint.

Validation:

```bash
curl -i https://rmstate.example.com/actuator/health
```

Then verify from the main app that `/api/rooms/*` works through the Cloudflare BFF. The browser should not call Spring internal endpoints directly.

Quick start from this repository:

```bash
cd rmstate
cp .env.example .env
nano .env
mvn clean package
docker compose up -d --build
curl -i https://rmstate.example.com/actuator/health
```

Before running it, replace the values copied from [`rmstate/.env.example`](../rmstate/.env.example) into `rmstate/.env`, then make sure Cloudflare Pages Functions has matching `RMSTATE_BASE_URL` and `RMSTATE_INTERNAL_API_TOKEN`.

More details:

- [rmstate README](../rmstate/README.md)

## 6. VPS 3: Media Transcoder

Purpose:

- Poll media transcode jobs from D1.
- Download originals from R2.
- Run ffmpeg for thumbnails and HLS renditions.
- Upload generated outputs back to R2.
- Update D1 job/media state.

What it must not do:

- Do not serve user playback traffic.
- Do not become the media origin.
- Do not own room playback state.

Suggested size:

```text
4+ vCPU
8+ GB RAM
100+ GB disk
Ubuntu LTS
Docker
ffmpeg inside container
```

Copy [`workers/media-transcoder/.env.example`](../workers/media-transcoder/.env.example) to `workers/media-transcoder/.env`, then replace:

```env
CLOUDFLARE_ACCOUNT_ID=CHANGE_ME_ACCOUNT_ID
CLOUDFLARE_D1_DATABASE_ID=CHANGE_ME_D1_DATABASE_ID
CLOUDFLARE_API_TOKEN=CHANGE_ME_API_TOKEN

R2_ENDPOINT=https://CHANGE_ME_ACCOUNT_ID.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=CHANGE_ME_R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY=CHANGE_ME_R2_SECRET_ACCESS_KEY
R2_BUCKET_NAME=CHANGE_ME_MEDIA_BUCKET

MEDIA_PUBLIC_ORIGIN=https://media.example.com
REALTIME_PUBLISH_URL=https://rt.example.com/publish
REALTIME_PUBLISH_TOKEN=CHANGE_ME_REALTIME_PUBLISH_TOKEN
```

Important matches:

- `CLOUDFLARE_D1_DATABASE_ID` must be the same D1 database used by the app.
- `R2_BUCKET_NAME` must be the same media R2 bucket bound as `MEDIA`.
- `MEDIA_PUBLIC_ORIGIN` should match Cloudflare `MEDIA_PUBLIC_ORIGIN`.
- `REALTIME_PUBLISH_TOKEN`, if used, must equal realtime VPS `PUBLISH_TOKEN`.

Validation:

```bash
docker logs -f swaparty-media-transcoder
```

Expected:

```text
started worker=media-worker-1
```

Then upload a video and check D1:

```sql
SELECT id, media_id, job_type, status, attempts, error_message
FROM transcode_jobs
ORDER BY created_at DESC
LIMIT 20;
```

Quick start from this repository:

```bash
cd workers/media-transcoder
cp .env.example .env
npm install
npm run check
docker build -t swaparty-media-transcoder .
docker run -d \
  --name swaparty-media-transcoder \
  --restart unless-stopped \
  --env-file .env \
  swaparty-media-transcoder
docker logs -f swaparty-media-transcoder
```

Before running it, replace the values copied from [`workers/media-transcoder/.env.example`](../workers/media-transcoder/.env.example) into `workers/media-transcoder/.env`, verify ffmpeg is available inside the Docker image, and make sure the Cloudflare API token can update the target D1 database.

More details:

- [Media Pipeline Guide](MEDIA_PIPELINE_GUIDE.md)

## 7. Deployment Order

1. Create Cloudflare D1 and R2 resources.
2. Update [`wrangler.toml`](../wrangler.toml) bindings.
3. Apply [database.sql](database.sql) to D1.
4. Configure Cloudflare Pages Functions secrets.
5. Deploy the frontend and Pages Functions.
6. Deploy the realtime VPS and verify `/healthz`.
7. Sync realtime secrets between Cloudflare and the realtime VPS.
8. Deploy `rmstate` and verify `/actuator/health`.
9. Sync internal rmstate token between Cloudflare and `rmstate`.
10. Verify room creation/join/playback through the main app.
11. Deploy the media transcoder if generated thumbnails/HLS renditions are needed.
12. Configure and deploy the Cron Worker for invite expiration.

## 8. Quick Replacement Map

```text
example.com
  Replace with your main web app domain.

rt.example.com
  Replace with realtime VPS domain.

rmstate.example.com
  Replace with Spring room backend domain.

media.example.com
  Replace with public media object origin.

avatars.example.com
  Replace with public avatar object origin.

CHANGE_ME_D1_DATABASE_ID
  Replace with Cloudflare D1 database ID.

CHANGE_ME_MEDIA_BUCKET
  Replace with R2 media bucket name.

CHANGE_ME_AVATARS_BUCKET
  Replace with R2 avatar bucket name.

CHANGE_ME_INTERNAL_TOKEN
  Use one long random value for Cloudflare RMSTATE_INTERNAL_API_TOKEN and rmstate SWAPARTY_INTERNAL_API_TOKEN.

CHANGE_ME_REALTIME_PUBLISH_TOKEN
  Use one long random value for realtime PUBLISH_TOKEN and every REALTIME_PUBLISH_TOKEN/SWAPARTY_REALTIME_PUBLISH_TOKEN.
```

## 9. Security Rules

- Never commit real `.env` files.
- Store Cloudflare/Resend/OAuth/R2 tokens in deployment secrets.
- Keep the realtime publish endpoint authenticated.
- Keep `rmstate` internal endpoints behind Cloudflare BFF authentication and the internal token.
- Use separate tokens for unrelated trust boundaries.
- Rotate tokens if they were ever copied into logs, screenshots, or public commits.
