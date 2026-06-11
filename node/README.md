# @meshwhisper/node

The [MeshWhisper](https://github.com/twotwoonethree/meshwhisper) relay node — packet relay, store-and-forward, push-notification forwarding, encrypted media storage, encrypted archive storage, username/prekey directory, and relay-to-relay federation, in a single binary.

The node never holds a decryption key. Everything it relays, stores, or queues is opaque ciphertext; clients encrypt on-device with PQXDH + Double Ratchet via [`@meshwhisper/sdk`](https://www.npmjs.com/package/@meshwhisper/sdk).

## Quickstart

The easiest path is the CLI, which writes a Docker Compose deployment around this package:

```bash
npx @meshwhisper/cli init
```

Or run it directly:

```bash
npm install -g @meshwhisper/node
BASE_URL=https://relay.myapp.com DB_PATH=./meshwhisper.db meshwhisper-node
```

Listens on port 8080 (`PORT` to change). Put TLS in front of it (Caddy: `reverse_proxy localhost:8080`). Verify with `curl https://relay.myapp.com/health` or `npx @meshwhisper/cli doctor`.

## Key environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP/WebSocket listen port |
| `BASE_URL` | — | Public URL; **required** for media download links to be reachable |
| `DB_PATH` | `./meshwhisper.db` | SQLite database location |
| `BLOB_TTL_HOURS` | `720` | How long queued messages wait for offline recipients (30 days) |
| `MEDIA_TTL_HOURS` | `168` | Encrypted media retention |
| `PUSH_WEBHOOK_URL` | — | `@meshwhisper/push-service` endpoint for offline wake signals |
| `TRUST_PROXY` | unset | Set to `1` behind a reverse proxy so rate limiting sees real client IPs |
| `FEDERATION_MODE` | off | `open` joins the relay mesh — your node forwards packets for other relays and they for yours; `allowlist` for explicit peering |

Full reference, including federation, backups, and metrics: [self-hosting guide](https://github.com/twotwoonethree/meshwhisper/blob/main/docs/self-hosting.md).

## Operational features

- Per-IP rate limiting on every endpoint
- Prometheus metrics at `/metrics`, health at `/health`
- Hot backup via bundled sqlite: `sqlite3 meshwhisper.db ".backup backup.db"`
- Federation wire protocol specified in [docs/federation.md](https://github.com/twotwoonethree/meshwhisper/blob/main/docs/federation.md)

MIT
