# SWaParty rmstate

`rmstate` is the Spring Boot room-state backend for SWaParty.

It owns room runtime data only:

- rooms
- room members
- playback state
- chat and danmaku messages
- activity logs
- room invitations

It must not serve video bytes, HLS playlists, HLS segments, thumbnails, or R2
objects. Browser playback still resolves media through the existing Cloudflare
Pages Functions media APIs.

## Public Host

DNS record:

```text
rmstate.example.com -> CHANGE_ME_VPS_PUBLIC_IP
```

The first production integration should call this service through Cloudflare
Pages Functions as a same-origin BFF. The browser should call `/api/rooms/*`;
Cloudflare validates the existing `swaparty_session` cookie, then forwards to
`https://rmstate.example.com/internal/rooms/*` with internal headers.

## Internal Headers

Every `/internal/**` request must include:

```http
Authorization: Bearer <SWAPARTY_INTERNAL_API_TOKEN>
X-SWaParty-User-Id: <authenticated user id>
X-SWaParty-User-Name: <display name>
X-SWaParty-User-Avatar: <avatar url>
```

Spring does not trust a browser-submitted user id.

## Build

```bash
mvn clean package
```

## Deploy

```bash
cp .env.example .env
nano .env
mvn clean package
docker compose up -d --build
curl -i https://rmstate.example.com/actuator/health
```

## Core API

```http
POST /internal/rooms
GET /internal/rooms/{roomHash}
GET /internal/rooms/active
POST /internal/rooms/{roomHash}/join
POST /internal/rooms/{roomHash}/dismiss
POST /internal/rooms/{roomHash}/close
POST /internal/rooms/{roomHash}/leave
POST /internal/rooms/{roomHash}/heartbeat
POST /internal/rooms/{roomHash}/media
POST /internal/rooms/{roomHash}/playback
POST /internal/rooms/{roomHash}/messages
GET /internal/rooms/{roomHash}/activity-logs?limit=30
```

Lifecycle rules:

- `POST /internal/rooms` is idempotent for hosts. If the caller already hosts a
  live room, the existing room snapshot is returned instead of creating another
  room.
- `POST /internal/rooms/{roomHash}/join` rejects a user who is already hosting a
  different live room with `active_host_room_exists`. To intentionally dismiss
  the hosted room and join the target room, send:

```json
{ "dismissHostedRoom": true }
```

- `dismiss` is the host-only destructive action. `close` remains as a backward
  compatible alias for existing clients.
- `leave` is non-destructive. A guest is marked as left. A host puts the room
  into `host_disconnected`, pauses playback, and sets `expiresAt`.
- `heartbeat` is host-only. It refreshes host presence and reopens a suspended
  room.
- Suspended rooms are automatically dismissed after
  `SWAPARTY_HOST_DISCONNECT_GRACE_SECONDS` seconds. The cleanup job runs every
  `SWAPARTY_ROOM_CLEANUP_FIXED_DELAY_MS` milliseconds.

All successful mutations persist first, then publish a `room.*` event to:

```text
https://rt.example.com/publish
```
