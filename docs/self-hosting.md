# Self-hosting MeshWhisper

This guide covers running the Node relay and push service in production. You need both unless you are only testing locally (push is optional for local dev).

---

## Prerequisites

- Docker + Docker Compose (or a container runtime of your choice)
- A domain name with a TLS certificate (required for WebSocket over WSS and for APNs/Web Push)
- One of: APNs credentials (iOS), FCM service account (Android), or VAPID keys (PWA/Web Push)

---

## Architecture

```
Internet
   │
   ▼
[Reverse proxy — nginx / Caddy]  ← handles TLS termination
   │               │
   ▼               ▼
[Node :8080]   [Push service :4000]
WebSocket +    Receives webhook POSTs
HTTP relay     from Node, dispatches
               APNs / FCM / Web Push
```

The Node and push service never need to be publicly accessible directly — only the reverse proxy does. The push service port should not be exposed to the internet.

---

## Docker Compose

Create a `docker-compose.yml`:

```yaml
services:
  node:
    build:
      context: .
      dockerfile: node/Dockerfile
    restart: unless-stopped
    environment:
      PORT: "8080"
      BASE_URL: "https://relay.myapp.com"   # ← your public HTTPS URL (no trailing slash)
      PUSH_WEBHOOK_URL: "http://push:4000/notify"
      DB_PATH: "/data/meshwhisper.db"       # persist data across restarts
      BLOB_TTL_HOURS: "72"                  # how long to queue messages for offline devices
      MEDIA_TTL_HOURS: "168"               # how long to keep uploaded media (7 days)
    volumes:
      - node_data:/data
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8080/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  push:
    build:
      context: .
      dockerfile: push-service/Dockerfile
    restart: unless-stopped
    environment:
      PUSH_PORT: "4000"

      # --- Web Push (PWA) ---
      VAPID_PUBLIC_KEY: "${VAPID_PUBLIC_KEY}"
      VAPID_PRIVATE_KEY: "${VAPID_PRIVATE_KEY}"
      VAPID_SUBJECT: "mailto:ops@myapp.com"  # contact URI, required by spec

      # --- APNs (iOS) ---
      # APNS_KEY_ID: "XXXXXXXXXX"           # 10-char key ID from Apple Developer portal
      # APNS_TEAM_ID: "YYYYYYYYYY"          # 10-char team ID
      # APNS_KEY_PATH: "/run/secrets/apns"  # path to .p8 file inside container
      # APNS_BUNDLE_ID: "com.example.myapp"
      # APNS_PRODUCTION: "true"             # omit or "false" for sandbox

      # --- FCM (Android) ---
      # FCM_SERVICE_ACCOUNT_PATH: "/run/secrets/fcm"
      # FCM_PROJECT_ID: "my-firebase-project"
    # secrets:
    #   - apns
    #   - fcm

# secrets:
#   apns:
#     file: ./AuthKey_XXXXXXXXXX.p8
#   fcm:
#     file: ./firebase-service-account.json

volumes:
  node_data:   # SQLite database — survives container restarts and upgrades
```

Store secrets in a `.env` file (do not commit it):

```bash
VAPID_PUBLIC_KEY=BExamplePublicKeyBase64url...
VAPID_PRIVATE_KEY=examplePrivateKeyBase64url...
```

Start:

```bash
docker compose up -d
docker compose logs -f
```

---

## Generating VAPID keys (Web Push)

Run once and store the output in your `.env`:

```bash
npx web-push generate-vapid-keys
```

Output:

```
Public Key:
BExamplePublicKeyBase64url...

Private Key:
examplePrivateKeyBase64url...
```

The public key is also embedded in your PWA (passed to `pushManager.subscribe()`). Keep the private key secret — it signs push messages.

---

## Reverse proxy

### Caddy (recommended — automatic TLS)

```caddyfile
relay.myapp.com {
  reverse_proxy node:8080
}
```

That's it. Caddy handles TLS via Let's Encrypt automatically.

### nginx

```nginx
server {
    listen 443 ssl;
    server_name relay.myapp.com;

    ssl_certificate     /etc/letsencrypt/live/relay.myapp.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.myapp.com/privkey.pem;

    location / {
        proxy_pass http://node:8080;
        proxy_http_version 1.1;

        # Required for WebSocket upgrade
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        proxy_read_timeout 3600s;   # keep WebSocket connections alive
        proxy_send_timeout 3600s;
    }
}
```

> **Important:** Set `BASE_URL` to your public HTTPS URL (e.g. `https://relay.myapp.com`). Without it, media download URLs will use the internal HTTP address and be unreachable from the internet.

---

## Environment variable reference

### Node relay (`node/`)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP + WebSocket listen port |
| `BASE_URL` | *(host header)* | Public-facing HTTPS base URL. Required behind a proxy. Example: `https://relay.myapp.com` |
| `PUSH_WEBHOOK_URL` | *(none)* | URL of the push service `/notify` endpoint. Required for offline push delivery. Example: `http://push:4000/notify` |
| `BLOB_TTL_HOURS` | `72` | How long to queue encrypted blobs for offline recipients (hours) |
| `MAX_BLOB_SIZE` | `262144` (256 KB) | Maximum size of a single queued blob (bytes) |
| `MAX_BLOBS_PER_HASH` | `500` | Maximum queued blobs per destination hash |
| `MEDIA_TTL_HOURS` | `168` (7 days) | How long to retain uploaded media blobs (hours) |
| `MAX_MEDIA_SIZE` | `52428800` (50 MB) | Maximum size of a single media upload (bytes) |
| `RATE_LIMIT_MEDIA` | `20` | Max media uploads per IP per minute |
| `RATE_LIMIT_DIR` | `60` | Max prekey directory registrations per IP per minute |

### Push service (`push-service/`)

| Variable | Default | Description |
|---|---|---|
| `PUSH_PORT` | `4000` | HTTP listen port |
| **Web Push** | | |
| `VAPID_PUBLIC_KEY` | *(none)* | Base64url VAPID public key |
| `VAPID_PRIVATE_KEY` | *(none)* | Base64url VAPID private key |
| `VAPID_SUBJECT` | *(none)* | `mailto:` or `https:` contact URI (required by spec) |
| **APNs (iOS)** | | |
| `APNS_KEY_ID` | *(none)* | 10-character key ID from Apple Developer portal |
| `APNS_TEAM_ID` | *(none)* | 10-character Apple team ID |
| `APNS_KEY_PATH` | *(none)* | Absolute path to the `.p8` private key file |
| `APNS_BUNDLE_ID` | *(none)* | App bundle ID (e.g. `com.example.myapp`) |
| `APNS_PRODUCTION` | `false` | Set to `"true"` for production APNs endpoint |
| **FCM (Android)** | | |
| `FCM_SERVICE_ACCOUNT_PATH` | *(none)* | Absolute path to Firebase service account JSON |
| `FCM_PROJECT_ID` | *(none)* | Firebase project ID |

At least one push provider must be configured for offline delivery. You can configure multiple simultaneously (e.g. VAPID + APNs + FCM for a cross-platform app).

---

## Health checks

Both services expose a `/health` endpoint:

```bash
# Node relay
curl https://relay.myapp.com/health
# {"status":"ok","clients":3,"storedBlobs":12,"prekeyEntries":8,"pushRegistrations":5,"mediaEntries":2}

# Push service (internal only — not exposed to internet)
curl http://localhost:4000/health
# {"status":"ok","apns":false,"fcm":false,"webpush":true}
```

---

## Node HTTP API

The Node exposes these HTTP endpoints in addition to the WebSocket relay:

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health and metrics |
| `POST` | `/directory` | Register a prekey bundle for X3DH key exchange |
| `GET` | `/directory?namespace=&publicKey=` | Fetch a prekey bundle |
| `POST` | `/media` | Upload an encrypted media blob (binary body, returns `{id, url, expiresAt}`) |
| `GET` | `/media/:id` | Download an encrypted media blob |
| `PUT` | `/archive/:peerId` | Upload encrypted user archive (binary body, requires `Authorization: Bearer <token>`) |
| `GET` | `/archive/:peerId` | Download encrypted user archive (unauthenticated; content is encrypted) |

The SDK calls these automatically. You do not need to call them directly.

**CORS preflight.** All HTTP endpoints respond to `OPTIONS` with `Access-Control-Allow-Origin: *`,
methods `GET, POST, PUT, OPTIONS`, and headers `Content-Type, Authorization`. If you front the Node
with a reverse proxy that rewrites or strips CORS headers, archive uploads will fail silently in the
browser — preserve the response headers from the Node verbatim.

**Archive endpoint authentication.** The `PUT /archive/:peerId` endpoint stores `SHA-256(token)`
on first write. Subsequent writes must present the same token; mismatches return `403`. Tokens are
derived by the client via HKDF from the user's identity key — the relay never sees the raw token,
the identity key, or the archive plaintext. The slot is rate-limited to one write per second per
peer ID.

**Storage sizing.** Each archive is capped at 12 MB on the relay (10 MB plaintext ceiling on the
client side). Plan capacity at roughly `12 MB × active users × 1.2` (SQLite overhead) for the
archives table at saturation. Archives are not auto-expired — they persist indefinitely until the
client overwrites them.

---

## WebSocket protocol

Clients connect to the Node at `ws(s)://your-node/`. The connection is a binary relay channel with one JSON control message on open:

**Client → Node (on connect):**
```json
{
  "type": "hello",
  "destHashes": ["a1b2c3d4e5f60718", "..."],
  "pushPlatform": "webpush",
  "pushSubscription": "{\"endpoint\":\"...\",\"keys\":{...}}"
}
```

For APNs/FCM:
```json
{
  "type": "hello",
  "destHashes": ["a1b2c3d4e5f60718"],
  "pushPlatform": "apns",
  "pushToken": "device-token-hex",
  "pushTopic": "com.example.myapp"
}
```

All subsequent messages on the connection are binary packet frames (see `src/transport/websocket/serialize.ts` for wire format).

---

## Scaling considerations

The Node keeps all state in memory. For high availability or horizontal scaling:

- Run multiple Node instances behind a load balancer with session affinity (sticky sessions)
- Or replace the in-memory blob/media/prekey stores with a shared Redis/PostgreSQL backend

The current implementation is designed for single-instance deployments. Multi-instance support is a Phase 3 item in `docs/shipping.md`.
