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
      BLOB_TTL_HOURS: "720"                 # how long to queue messages for offline devices (default 30 days)
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
| `BLOB_TTL_HOURS` | `720` (30 days) | How long to queue encrypted blobs for offline recipients (hours) |
| `MAX_BLOB_SIZE` | `262144` (256 KB) | Maximum size of a single queued blob (bytes) |
| `MAX_BLOBS_PER_HASH` | `500` | Maximum queued blobs per destination hash |
| `MEDIA_TTL_HOURS` | `168` (7 days) | How long to retain uploaded media blobs (hours) |
| `MAX_MEDIA_SIZE` | `52428800` (50 MB) | Maximum size of a single media upload (bytes) |
| `RATE_LIMIT_MEDIA` | `20` | Max media uploads per IP per minute (`POST /media`) |
| `RATE_LIMIT_DIR` | `60` | Max writes per IP per minute on directory / opks / namespace-policy endpoints (`POST /directory`, `POST /namespace-policy`, `POST /opks`, `DELETE /opks`, `GET /opks/claim`). Note: `GET /opks/claim` is bucketed here because each call atomically consumes a one-time prekey. |
| `RATE_LIMIT_READ` | `300` | Max reads per IP per minute on GET endpoints (`GET /events`, `GET /directory`, `GET /namespace-policy`, `GET /media/<id>`, `GET /archive/<peerId>`). Reads share a separate bucket from writes so a busy lookup workload can't starve registrations and vice versa. |
| `RATE_LIMIT_ARCHIVE` | `30` | Max archive uploads per IP per minute (`PUT /archive/<peerId>`) |
| `TRUST_PROXY` | *(unset)* | Set to `1` / `true` when the node is behind a reverse proxy that sets `X-Forwarded-For`. Default is OFF so a direct-exposed node can't have its rate-limit per-IP key spoofed via the header. **Production deployments behind nginx / Caddy / Cloudflare should set this to `1`.** |

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

### Rate-limiting notes

- All limits are per-IP per-minute sliding windows, in-memory (don't survive a restart). For a small/single-instance node this is sufficient; for a horizontally-scaled deployment, terminate at a shared rate-limit layer (e.g. nginx `limit_req`, Cloudflare) instead of relying on per-node state.
- `GET /health` is deliberately NOT rate-limited so Docker/k8s/load-balancer liveness probes can poll freely. If you expose `/health` to the internet and worry about probe-based fingerprinting, gate it at the reverse proxy.
- 429 responses include both a `Retry-After` header (seconds, RFC 7231) and a `retryAfter` field in the JSON body for clients that don't surface response headers.
- If you raise `RATE_LIMIT_*` defaults to accommodate a heavy workload, consider also enabling per-IP rate limits at the reverse proxy as a second layer — defense in depth costs little.

---

## Isolated networks (no internet at all)

Everything above also works on a network that never touches the internet — the node is just a process, and it doesn't need a domain, a public IP, or a certificate authority. On top of that, the SDK's LAN bearer lets established conversations continue peer-to-peer even when the node is down. See **[local-networks.md](local-networks.md)** for the on-site / air-gapped deployment guide (including machine-to-machine use).

---

## Federation (peering with other relay operators)

Two or more `meshwhisper-node` instances can peer so packets route across operators — the protocol is specified in [federation.md](federation.md). Federation is **off by default** and has two active modes:

- **`open`** (recommended) — accept any peer that completes the cryptographic handshake. This is the "relay promiscuously" posture from the whitepaper: joining the mesh requires no bilateral agreement. Per-peer rate limiting is the abuse boundary; a pubkey blocklist handles bad actors reactively.
- **`allowlist`** — only pre-approved pubkeys may connect. For operators who want explicit control (corporate deployments, cautious first steps).

### Joining the mesh (open mode — the two-minute version)

```sh
# In your compose environment:
FEDERATION_MODE: "open"
```

Then add one bootstrap peer to `federation-peers.json` next to your database. The Foundation relay runs in open mode and accepts peers — or use any operator you know:

```json
{
  "peers": [
    {
      "pubkey": "34904664a3b5b0b35a8eb41bd3b1d493b79981af2a47069e246db28854d6ce23",
      "url": "wss://relay.meshwhisper.org"
    }
  ]
}
```

Restart. Your node dials the bootstrap peer, the handshake proves key possession on both sides, and you're forwarding. Other open-mode operators can dial *you* without any pre-arrangement — your node admits them dynamically up to `FEDERATION_MAX_PEERS`.

### Allowlist mode (explicit control)

Same peers-file shape, but set `FEDERATION_MODE=allowlist` (or leave `FEDERATION_MODE` unset — a non-empty peers file implies allowlist for backwards compatibility). Only pubkeys in the file may connect; **both sides must list each other**. Exchange pubkeys out-of-band like SSH keys — the `publicKeyHex` field of your auto-generated `federation-key.json`.

### Blocking a misbehaving peer

Write `federation-blocklist.json` next to your database:

```json
{ "blocked": ["<their-64-char-hex>"] }
```

Blocked pubkeys are rejected at handshake regardless of mode. Evicting an already-connected peer requires a restart in v1.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `FEDERATION_MODE` | *(unset)* | `open` / `allowlist` / `off`. Unset = allowlist if the peers file has entries, else off |
| `FEDERATION_KEY_FILE` | `<db-dir>/federation-key.json` | Ed25519 keypair; auto-generated (mode 0600) if missing |
| `FEDERATION_PEERS_FILE` | `<db-dir>/federation-peers.json` | Outbound bootstrap list (open mode) / allow-list (allowlist mode) |
| `FEDERATION_BLOCKLIST_FILE` | `<db-dir>/federation-blocklist.json` | Pubkeys rejected at handshake regardless of mode |
| `FEDERATION_MAX_PEERS` | `64` | Open mode: cap on simultaneously-tracked peers; handshakes beyond it are rejected |
| `FEDERATION_RATE_LIMIT` | `6000` | PacketForward frames accepted per peer per minute (~100/sec); excess silently dropped |
| `FEDERATION_MAX_HOPS` | `3` | Hop-count cap on forwarded packets |

#### DNS-free relay location ([ADR-010](adr/010-dns-free-relay-location.md), all opt-in)

Unset, the node routes exactly as before (flood + configured URLs). Set these to participate in key-addressed routing, NAT traversal and onion-routed transit:

| Variable | Default | Description |
|---|---|---|
| `FEDERATION_ADVERTISE_URL` | *(unset)* | This node's own reachable `ws(s)://` endpoint. When set, it is signed + gossiped so peers can locate this relay **by key, not DNS**, and dial it on demand. A NAT'd node omits it and is reached via its `via` anchors instead |
| `FEDERATION_ONION_TRANSIT` | `off` | `1`/`true` wraps transit hops in per-hop onion encryption — a transit relay sees only "deliver to relay X", never the packet or destHash |
| `FEDERATION_ONION_HOPS` | `1` | Extra intermediate relay hops inserted before the anchor in an onion path (clamped 0–4), so a non-adjacent intermediate never learns the destination |
| `FEDERATION_TRANSIT_ONLY` | `off` | Restricted-egress mode: never dial on demand, route only over the configured uplink. Forces rendezvous/bridge routing for both-ends-NAT topologies |
| `FEDERATION_GOSSIP_INTERVAL_MS` | `10000` | Periodic anti-entropy: re-push the address book to peers so the overlay self-heals after a dropped gossip |
| `FEDERATION_LEARNED_PEER_IDLE_MS` | `300000` | Evict a gossip-learned (on-demand-dialed) peer after this long with no routing traffic, so connections don't accumulate. Configured peers are never evicted |
| `FEDERATION_GOSSIP_BATCH_MAX` | *(fits a frame)* | Max address records per gossip frame; gossip paginates across frames so a large book fully propagates |
| `FEDERATION_MAX_TRANSIT_HOPS` | `3` | Cap on transit/bridge hops, bounding routed-packet loops/amplification |

### Behaviour notes

- Federation shares the client-relay port — peers connect with the `meshwhisper-federation.v1` WebSocket subprotocol; no extra port to open.
- A packet from one of your clients whose destination is unknown locally (no connected client, no push registration) is forwarded best-effort to every peer. Packets arriving FROM peers are delivered to your connected clients, stored + push-woken for your registered-but-offline devices, or forwarded onward (TTL-limited, loop-protected) — never stored for devices that aren't yours.
- If a federation link is down at the moment of forwarding, that copy is dropped — there's no cross-node retry queue in v1. The sender's own relay still stores everything per its normal TTL.
- Docker note: persist the federation key by keeping it in the mounted data volume (the default location does this automatically).

---

## Backup and recovery

The relay's SQLite database (`/data/meshwhisper.db` inside the container, by default backed by a Docker named volume) holds all server-side state that isn't reproducible from client devices: store-and-forward blob queue, push registrations, prekey directory, OPK pool, archive blobs, namespace policy. Losing it means users miss queued messages, push wake stops working until devices reconnect, and freshly-installed devices can't restore from archive until their owner re-pushes one. Worth backing up.

### Hot backup (no downtime)

The repository ships a script at [`scripts/relay-backup.sh`](../scripts/relay-backup.sh) that runs `sqlite3 .backup` inside the live container. SQLite's `.backup` command is atomic and online — the relay keeps serving traffic while it runs.

Typical setup (host running docker compose):

```sh
# Run once to test
sudo /opt/meshwhisper/repo/scripts/relay-backup.sh

# Schedule via a /etc/cron.d/ drop-in (cleaner than editing /etc/crontab —
# easy to remove, doesn't conflict with other operators):
sudo tee /etc/cron.d/meshwhisper-backup > /dev/null <<'EOF'
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
0 3 * * * root /opt/meshwhisper/repo/scripts/relay-backup.sh >> /var/log/meshwhisper-backup.log 2>&1
EOF

# And rotate the backup log so it doesn't grow unbounded:
sudo tee /etc/logrotate.d/meshwhisper-backup > /dev/null <<'EOF'
/var/log/meshwhisper-backup.log {
    weekly
    rotate 8
    compress
    delaycompress
    missingok
    notifempty
    create 0640 root root
}
EOF
```

Knobs (set as environment variables before invoking the script):

| Variable | Default | Description |
|---|---|---|
| `COMPOSE_DIR` | `/opt/meshwhisper` | Directory containing your `docker-compose.yml` |
| `SERVICE` | `node` | Compose service name running the relay |
| `DB_PATH` | `/data/meshwhisper.db` | DB path inside the container |
| `BACKUP_DIR` | `/opt/meshwhisper/backups` | Host directory to write backups to |
| `RETAIN` | `14` | Number of most-recent backups to keep; older deleted |
| `COMPRESS` | `1` | Gzip backups after creation |

Backups land as `meshwhisper-<UTC-timestamp>.db.gz`. For a 24-hour-RPO setup, daily cron + 14-day retention is a reasonable starting point; tighten on both axes if your data is more valuable.

For off-host backups (highly recommended for any non-toy deployment), pipe the latest file to `rclone`, `restic`, S3, or whichever object store you trust. The relay backup file is encrypted-at-the-application-layer only for archive contents (`archives` table); the rest is plaintext SQLite, so encrypt the file at rest if you're shipping it to cloud storage.

### Recovery

Recovery is offline — stop the relay, restore the file, start it again:

```sh
cd /opt/meshwhisper

# Stop the relay
docker compose stop node

# Find the backup volume mount point on the host (depends on Docker storage driver)
VOLUME=$(docker volume inspect meshwhisper_node_data -f '{{.Mountpoint}}')

# Restore (replace the path with your chosen backup file)
gunzip -c /opt/meshwhisper/backups/meshwhisper-20260609T030000Z.db.gz \
  > "${VOLUME}/meshwhisper.db"

# Remove WAL/SHM if present (they'd be stale relative to the restored .db)
sudo rm -f "${VOLUME}/meshwhisper.db-wal" "${VOLUME}/meshwhisper.db-shm"

# Restart
docker compose start node
docker compose logs -f node   # watch for the "Listening on..." line
```

What survives a restore:

- All prekey directory entries (so users remain discoverable)
- Push registrations (so push wake keeps working)
- Stored blobs younger than the restored snapshot (recipients pull them when they reconnect)
- Archive contents up to the backup time
- Namespace policy
- OPK pool

What's lost:

- Anything between the backup time and the restore moment (typical "you lost N hours" RPO)
- The in-memory rate-limit state — irrelevant, it resets on every restart anyway
- The in-memory `/metrics` counters — same

A device that pulls right after recovery sees the relay as it was at backup time, which it transparently handles — the SDK's reconnect logic doesn't notice anything unusual.

---

## Observability

The relay exposes Prometheus-format metrics at `/metrics`. Scrape it on your normal Prometheus / VictoriaMetrics / managed-monitoring cadence (15-60s is fine; the endpoint is cheap).

Example scrape config:

```yaml
scrape_configs:
  - job_name: meshwhisper-relay
    metrics_path: /metrics
    static_configs:
      - targets: ['relay.myapp.com:443']
    scheme: https
```

### Metrics surface

| Metric | Type | Labels | Description |
|---|---|---|---|
| `meshwhisper_uptime_seconds` | gauge | — | Seconds since the node started |
| `meshwhisper_clients_connected` | gauge | — | Currently-connected WebSocket clients |
| `meshwhisper_stored_blobs` | gauge | — | Encrypted blobs queued for offline delivery |
| `meshwhisper_prekey_entries` | gauge | — | Prekey-bundle entries in the directory |
| `meshwhisper_push_registrations` | gauge | — | Active push registrations |
| `meshwhisper_media_entries` | gauge | — | Encrypted media blobs stored |
| `meshwhisper_opk_entries` | gauge | — | One-time prekeys in the pool |
| `meshwhisper_archive_entries` | gauge | — | Per-identity encrypted archives stored |
| `meshwhisper_http_requests_total` | counter | — | Total HTTP requests served since startup |
| `meshwhisper_http_responses_total` | counter | `status` (`2xx` / `3xx` / `4xx` / `5xx` / `429`) | HTTP responses broken down by status family (429 broken out separately because operators alert on it) |
| `meshwhisper_rate_limit_rejections_total` | counter | `bucket` (`dir` / `media` / `read` / `archive`) | Per-bucket 429 rejections |
| `meshwhisper_websocket_connections_total` | counter | — | Total WebSocket connections accepted since startup |

Counters reset to zero on every restart (which is what Prometheus expects). Pair with Prometheus' `rate()` / `increase()` functions for meaningful queries.

### Suggested alerts

A starting set worth wiring up:

- **Sustained 5xx**: `rate(meshwhisper_http_responses_total{status="5xx"}[5m]) > 0.1` for 10 minutes. Real server bug.
- **Persistent 429 spike**: `rate(meshwhisper_rate_limit_rejections_total[5m]) > 5` for 30 minutes. Either a real attack or your limits are too tight.
- **Stored-blob growth**: `meshwhisper_stored_blobs` rising monotonically. Indicates recipients aren't draining their queues — possibly a push pipeline failure.
- **Node restart**: `meshwhisper_uptime_seconds < 300` after being healthy. The node restarted; check why.

### Privacy of /metrics

The endpoint returns aggregate counts only — no peerIds, no destination hashes, no message content, no IPs. It's safe to expose to a scraper without further auth, but operators who'd rather keep their traffic shape private should restrict it at the reverse proxy (e.g. nginx `allow 10.0.0.0/8; deny all;` in a `location /metrics` block).

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
