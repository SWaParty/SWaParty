# SWaParty Realtime VPS Guide

Last updated: 2026-04-17 (includes realtime presence: `presence.snapshot` / `presence.update`)

Use this document when you are ready to deploy the realtime VPS. If you are still deciding which machines and secrets are needed, start with the [Deployment and Secrets Guide](DEPLOYMENT_AND_SECRETS_GUIDE.md).

This VPS has one job: keep WebSocket clients connected and fan out events sent to `/publish`. It should not store room state, media metadata, files, or chat history.

## What You Need Before Starting

- One Ubuntu VPS for realtime fanout.
- A domain such as `rt.example.com` pointing to this VPS.
- Docker and Docker Compose.
- A long random `JWT_SECRET`.
- A long random `PUBLISH_TOKEN`.
- Matching Cloudflare app settings:
  - `VITE_REALTIME_WS_URL=wss://rt.example.com`
  - `REALTIME_WS_JWT_SECRET=<same as JWT_SECRET>`
  - `REALTIME_PUBLISH_URL=https://rt.example.com/publish`
  - `REALTIME_PUBLISH_TOKEN=<same as PUBLISH_TOKEN>`

Follow the sections below in order. After each major step, run the validation command before moving on.

## 1) Base setup on Ubuntu VPS

```bash
sudo apt update && sudo apt -y upgrade
```

If apt lock issue appears:

```bash
ps -fp 1275
sudo killall apt apt-get 2>/dev/null; sudo dpkg --configure -a; sudo apt update
```

Install required packages:

```bash
sudo apt -y install docker.io docker-compose-v2 curl
```

Create workdir:

```bash
mkdir -p /opt/swaparty-realtime && cd /opt/swaparty-realtime
```

## 2) DNS and domain

Recommended subdomain:

- `rt.example.com` -> A record -> VPS public IP
- Cloudflare proxy: **DNS only** (gray cloud) for initial setup/debug

Check DNS:

```bash
dig +short rt.example.com
```

## 3) docker-compose.yml

Create file:

```bash
cat > /opt/swaparty-realtime/docker-compose.yml <<'YAML'
services:
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - redis_data:/data
    networks:
      - internal

  realtime:
    image: node:20-alpine
    restart: unless-stopped
    working_dir: /app
    command: sh -c "npm install && node server.js"
    environment:
      PORT: "8080"
      REDIS_URL: "redis://redis:6379"
      JWT_SECRET: "CHANGE_ME_SUPER_LONG_RANDOM"
      PUBLISH_TOKEN: "CHANGE_ME_PUBLISH_TOKEN"
    volumes:
      - ./realtime:/app
    depends_on:
      - redis
    networks:
      - internal

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - realtime
    networks:
      - internal

networks:
  internal:

volumes:
  redis_data:
  caddy_data:
  caddy_config:
YAML
```

## 4) Caddyfile

```bash
cat > /opt/swaparty-realtime/Caddyfile <<'CADDY'
rt.example.com {
  encode gzip

  @ws path /ws
  reverse_proxy @ws realtime:8080

  reverse_proxy realtime:8080
}
CADDY
```

## 5) Realtime app files

Create package file:

```bash
mkdir -p /opt/swaparty-realtime/realtime && cat > /opt/swaparty-realtime/realtime/package.json <<'JSON'
{
  "name": "swaparty-realtime",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "ioredis": "^5.4.1",
    "jsonwebtoken": "^9.0.2",
    "ws": "^8.18.0"
  }
}
JSON
```

Create server:

```bash
cat > /opt/swaparty-realtime/realtime/server.js <<'JS'
import http from 'http';
import jwt from 'jsonwebtoken';
import Redis from 'ioredis';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8080);
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_SUPER_LONG_RANDOM';
const PUBLISH_TOKEN = process.env.PUBLISH_TOKEN || '';

const redisSub = new Redis(REDIS_URL);
const redisPub = new Redis(REDIS_URL);
const clientsByUserId = new Map();

function addClient(userId, ws) {
  if (!clientsByUserId.has(userId)) clientsByUserId.set(userId, new Set());
  clientsByUserId.get(userId).add(ws);
}
function removeClient(userId, ws) {
  const set = clientsByUserId.get(userId);
  if (!set) return false;
  set.delete(ws);
  if (set.size === 0) {
    clientsByUserId.delete(userId);
    return true;
  }
  return false;
}
function broadcastToUser(userId, payload) {
  const set = clientsByUserId.get(String(userId));
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}
function broadcastAll(payload) {
  const data = JSON.stringify(payload);
  for (const set of clientsByUserId.values()) {
    for (const ws of set) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }
}
function getOnlineUserIds() {
  return Array.from(clientsByUserId.keys());
}
function verifyWsToken(req) {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const userId = decoded?.uid || decoded?.userId || decoded?.sub;
    return userId ? String(userId) : null;
  } catch {
    return null;
  }
}
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error('body_too_large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST' && req.url === '/publish') {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!PUBLISH_TOKEN || token !== PUBLISH_TOKEN) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }

    try {
      const body = await readJsonBody(req);
      const evt = {
        type: String(body?.type || 'unknown'),
        targets: Array.isArray(body?.targets) ? body.targets.map(String) : [],
        payload: body?.payload ?? {},
        ts: Number(body?.ts || Date.now()),
      };
      await redisPub.publish('swaparty:events', JSON.stringify(evt));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(err?.message || 'bad_request') }));
    }
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not_found' }));
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const userId = verifyWsToken(req);
  if (!userId) {
    ws.close(1008, 'unauthorized');
    return;
  }

  const wasOnline = clientsByUserId.has(userId) && clientsByUserId.get(userId)?.size > 0;
  addClient(userId, ws);

  ws.send(JSON.stringify({ type: 'system.connected', ts: Date.now() }));
  ws.send(JSON.stringify({
    type: 'presence.snapshot',
    payload: { onlineUserIds: getOnlineUserIds() },
    ts: Date.now(),
  }));

  if (!wasOnline) {
    broadcastAll({
      type: 'presence.update',
      payload: { userId, online: true },
      ts: Date.now(),
    });
  }

  let finalized = false;
  const cleanup = () => {
    if (finalized) return;
    finalized = true;

    const becameOffline = removeClient(userId, ws);
    if (becameOffline) {
      broadcastAll({
        type: 'presence.update',
        payload: { userId, online: false },
        ts: Date.now(),
      });
    }
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

await redisSub.subscribe('swaparty:events');
redisSub.on('message', (_channel, message) => {
  try {
    const evt = JSON.parse(message);
    const targets = Array.isArray(evt?.targets) ? evt.targets : [];
    for (const uid of targets) broadcastToUser(String(uid), evt);
  } catch {}
});

server.listen(PORT, () => {
  console.log(`[realtime] listening on :${PORT}`);
});
JS
```

## 6) Start services

```bash
cd /opt/swaparty-realtime && sudo docker compose up -d --force-recreate
sudo docker compose ps
```

Health check:

```bash
curl -i https://rt.example.com/healthz
```

Expected: `HTTP/2 200` and JSON body.

## 7) Publish token generation

Generate:

```bash
openssl rand -hex 32
```

Put into `docker-compose.yml` -> `realtime.environment.PUBLISH_TOKEN` and restart:

```bash
cd /opt/swaparty-realtime
sudo docker compose up -d --force-recreate realtime
```

## 8) Redis / publish tests

Redis channel direct test:

```bash
sudo docker compose exec redis redis-cli PUBLISH swaparty:events '{"type":"contact.added","targets":["USER_ID_A","USER_ID_B"],"payload":{"contactUserId":"123","displayName":"Test User"},"ts":'$(date +%s%3N)'}'
```

Expected: `(integer) 1` (one subscriber, realtime server).

HTTP publish endpoint test:

```bash
curl -i -X POST https://rt.example.com/publish \
  -H "Authorization: Bearer YOUR_PUBLISH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"invite.created","targets":["123"],"payload":{"inviteId":"inv_test_1"}}'
```

Expected: `HTTP/2 200`.

## 9) Presence checks (online bubble)

After deploying the presence-enabled `server.js`, run:

```bash
cd /opt/swaparty-realtime
sudo docker compose exec realtime sh -lc "grep -n 'presence.snapshot\\|presence.update\\|broadcastAll' /app/server.js"
sudo docker compose logs --tail=120 realtime
curl -i https://rt.example.com/healthz
```

Expected:

- grep output includes `presence.snapshot`, `presence.update`, `broadcastAll`
- logs contain `[realtime] listening on :8080`
- health endpoint returns `HTTP/2 200`

## 10) Common issues and fixes

### A) apt lock error
- Do not delete lock file manually.
- Use:
  ```bash
  sudo killall apt apt-get 2>/dev/null; sudo dpkg --configure -a; sudo apt update
  ```

### B) `npm ci` fails (`no package-lock.json`)
- Use `npm install` in compose command:
  ```yaml
  command: sh -c "npm install && node server.js"
  ```

### C) 502 from Caddy
Check:
```bash
sudo docker compose logs caddy --tail=120
sudo docker compose logs realtime --tail=120
sudo docker compose ps
```

Usually one of:
- `realtime` restarting/crashed
- bad `docker-compose.yml` YAML
- `realtime` not listening on 8080

### D) malformed compose after sed edits
- Recreate `docker-compose.yml` from this runbook exactly.

## 11) Main app backend integration (your existing backend)

Add env in backend (not VPS realtime container):

```env
REALTIME_PUBLISH_URL=https://rt.example.com/publish
REALTIME_PUBLISH_TOKEN=YOUR_PUBLISH_TOKEN
```

On invite/contact state changes, backend should POST:

```json
{
  "type": "invite.created | invite.updated | contact.added | contact.removed",
  "targets": ["receiverUserId", "senderUserId"],
  "payload": { "inviteId": "...", "status": "pending|accepted|rejected", "contactUserId": "..." },
  "ts": 1776220000000
}
```

Auth header:

```http
Authorization: Bearer YOUR_PUBLISH_TOKEN
```
