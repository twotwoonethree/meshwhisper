# MeshWhisper — Codebase Overview

This document is intended for an AI or developer reviewing the codebase. It describes what has been built, where everything lives, what each piece does, what works, what is incomplete, and what the known gaps are.

---

## What it is

MeshWhisper is an open-source SDK and supporting infrastructure for adding end-to-end encrypted P2P messaging to any app. It implements the Signal protocol (X3DH + Double Ratchet) and routes messages through a relay Node that cannot decrypt them.

The intended use case is a developer who wants to add messaging to their existing app — PWA, React Native, or Node.js — without building cryptography, key exchange, push notifications, or message persistence themselves.

---

## Repository structure

```
/
├── src/                        @meshwhisper/sdk — client library
│   ├── sdk/index.ts            Main public API (1994 lines)
│   ├── types.ts                All shared TypeScript interfaces
│   ├── crypto/                 AES-256-GCM, BLAKE3, X25519, Ed25519
│   ├── x3dh/                   X3DH key exchange (Signal protocol)
│   ├── ratchet/                Double Ratchet algorithm
│   ├── packet/                 Wire format, compression, chaff
│   ├── namespace/              Identity management, LocalIdentity
│   ├── permissions/            Permission model, contact list
│   ├── persistence/            StorageBackend interface + implementations
│   │   ├── types.ts            StorageBackend interface, StoredMessage type
│   │   ├── idb-storage.ts      IndexedDB backend (browser/PWA)
│   │   ├── node-storage.ts     Filesystem backend (Node.js)
│   │   └── serialization.ts    RatchetState JSON serialization
│   ├── transport/
│   │   ├── browser/            BrowserTransport — native WebSocket
│   │   ├── node/               NodeTransport — ws package
│   │   ├── websocket/          WebSocketTransport (P2P direct) + serialize.ts
│   │   ├── local/              LAN transport (UDP discovery + TCP)
│   │   ├── p2p/                Platform P2P bridge (Multipeer/Nearby)
│   │   ├── negotiator/         BearerNegotiator — picks best transport
│   │   └── noop/               NoOpTransport stub for unavailable transports
│   ├── routing/                SocialGraphRouter, PeerProximityTable
│   ├── relay/                  Store-and-forward, RelayStore
│   ├── reciprocity/            Relay ledger (tracks bytes relayed)
│   ├── group/                  Group messaging manager
│   ├── cluster/                Multi-device cluster
│   ├── chaff/                  Traffic analysis resistance
│   ├── sybil/                  Entropy challenges, ZK relay reputation
│   ├── compliance/             Audit hooks (enterprise)
│   ├── browser/index.ts        @meshwhisper/sdk/browser entry point
│   └── node/index.ts           @meshwhisper/sdk/node entry point
│
├── node/                       @meshwhisper/node — relay server
│   └── src/index.ts            Single-file HTTP + WebSocket server (662 lines)
│
├── push-service/               @meshwhisper/push-service
│   └── src/
│       ├── index.ts            HTTP server, webhook handler
│       ├── apns.ts             APNs HTTP/2 JWT push
│       ├── fcm.ts              FCM v1 OAuth2 push
│       └── webpush.ts          Web Push VAPID
│
├── cli/                        @meshwhisper/cli
│   └── src/index.ts            npx @meshwhisper/cli init
│
├── service-worker/             @meshwhisper/service-worker
│   └── src/index.ts            PWA push event handler
│
├── tests/
│   ├── crypto.test.ts          26 tests — primitives
│   ├── x3dh.test.ts            22 tests — key exchange
│   ├── ratchet.test.ts         15 tests — Double Ratchet
│   └── packet.test.ts          24 tests — wire format
│
└── docs/
    ├── getting-started.md      Step-by-step integration guide
    ├── api.md                  Full SDK API reference
    ├── self-hosting.md         Deployment guide, all env vars
    └── shipping.md             Internal build plan (phases 1-3)
```

---

## What is fully implemented and tested

### Cryptography (`src/crypto/`)
- AES-256-GCM encrypt/decrypt
- BLAKE3 hashing (via @noble/hashes)
- X25519 Diffie-Hellman key exchange
- Ed25519 signing and verification
- Destination hash derivation (truncated BLAKE3, rotates hourly)
- 26 passing tests covering all primitives

### X3DH Key Exchange (`src/x3dh/`)
- Full Signal X3DH implementation
- Generates identity key, signed pre-key, one-time pre-keys
- `generatePreKeyBundle()` returns private keys (bug fixed — they were previously discarded)
- `initiateKeyExchange()` and `completeKeyExchange()` both sides implemented
- Pre-key bundle serialization/deserialization
- 22 passing tests covering both sides of the handshake

### Double Ratchet (`src/ratchet/`)
- Full Signal Double Ratchet implementation
- `initSender()`, `initReceiver()`, `ratchetEncrypt()`, `ratchetDecrypt()`
- DH ratchet step, symmetric-key ratchet, message key derivation
- 15 passing tests including bidirectional message exchange

### Packet layer (`src/packet/`)
- Binary wire format: version, flags, destHash, senderEphemeralId, TTL, payload
- LZ4 compression/decompression
- Chaff packet generation (traffic analysis resistance)
- `Math.random()` replaced with `crypto.getRandomValues()` throughout
- 24 passing tests

### SDK public API (`src/sdk/index.ts`)
- `MeshWhisper.init(config)` — singleton initialisation, auto-detects browser vs Node.js
- `MeshWhisper.send(recipientId, payload)` — E2EE send, auto-initiates X3DH on first contact
- `MeshWhisper.onMessage` — decrypted inbound message callback
- `MeshWhisper.sendMedia()` / `downloadMedia()` — two-part encrypted media upload
- `MeshWhisper.getMessages(peerId, options)` — message history from storage
- `MeshWhisper.markRead(messageId, peerId)` — read receipts
- `MeshWhisper.getLocalPeerId()` — stable peer ID (hex Ed25519 public key)
- `MeshWhisper.getPresence()`, `onPresence` — presence tracking
- `MeshWhisper.generateContactQR()`, `acceptContact()` — contact exchange
- `MeshWhisper.createGroup()` — group messaging
- `MeshWhisper.shutdown()` — graceful stop + state persistence

### Persistence (`src/persistence/`)
- `StorageBackend` interface — 4 methods: get, set, delete, keys(prefix)
- `IDBStorage` — IndexedDB backend, browser/PWA, auto-selected in browser
- `NodeStorage` — filesystem backend, atomic writes (temp+rename), mode 0600, path traversal protection
- `serializeRatchetState()` / `deserializeRatchetState()` — versioned JSON (v1), all Uint8Arrays as hex
- Persisted: identity key, sessions, prekey bundles, peers, contacts, message history, seen message IDs

### Delivery receipts
- DELIVERED sent automatically when recipient decrypts a message
- READ sent when `markRead()` is called
- Receipts travel through the Double Ratchet channel as `__mw_ctrl` JSON control messages
- `onMessageStatus` callback fires on the sender's device

### Deduplication
- 24-hour rolling window of seen message IDs
- Prevents duplicate delivery if the same blob is received twice
- Persisted to storage as `seen_ids`

### Session re-establishment
- On startup with empty sessions but existing contacts, re-initiates X3DH automatically
- Handles storage wipe and new-device-with-same-identity scenarios
- Uses persisted prekey bundles (`prekeys/<peerId>` storage keys)

### Transport layer
- `BrowserTransport` — native WebSocket, no Node.js dependencies, browser/PWA safe
- `NodeTransport` — ws package, Node.js only
- `NoOpTransport` — stub for unavailable transports (e.g. LAN transport in browser)
- `WebSocketTransport` — direct P2P WebSocket (Node.js only, used for mesh networking)
- `LocalTransport` — LAN UDP discovery + TCP (Node.js only)
- `PlatformP2PTransport` — bridge for native P2P (Apple Multipeer, Google Nearby)
- `BearerNegotiator` — selects best available transport
- `init()` dynamically imports platform-appropriate transports — browser bundles never include `ws` or `fs`

### Node relay server (`node/src/index.ts`)
- WebSocket relay: routes binary packets by destination hash
- Blob store: queues encrypted blobs for offline recipients, TTL 72h, max 500/hash, max 256KB/blob
- Push token store: survives WebSocket disconnect (tokens needed for offline delivery)
- Prekey directory: `POST /directory`, `GET /directory` — rate limited
- Media store: `POST /media`, `GET /media/:id` — TTL 7 days, max 50MB/file
- Push webhook: POSTs to `PUSH_WEBHOOK_URL` when blob arrives for offline device
- Rate limiting: sliding window per IP, configurable via env vars, `X-Forwarded-For` aware
- CORS: all HTTP endpoints include `Access-Control-Allow-Origin: *` and handle OPTIONS preflight
- Health check: `GET /health` returns clients, blobs, prekeys, push registrations, media counts
- Graceful shutdown on SIGINT/SIGTERM

### Push service (`push-service/`)
- APNs: HTTP/2 provider API, JWT auth, `.p8` key, silent background push (`apns-priority: 5`), JWT cached 55 minutes, H2 session pooling
- FCM v1: `google-auth-library` OAuth2, data-only message
- Web Push: VAPID via `web-push` package, 24h TTL, minimal payload (`{type: 'meshwhisper:wake', destHash}`)
- `GET /health` reports which providers are configured
- Returns 200 even on push failure — Node should not retry

### Service worker (`service-worker/`)
- Handles `push` events: wakes open windows via `postMessage`, shows generic notification if app is closed
- Handles `notificationclick`: focuses existing window or opens `/`
- Built with esbuild to 1.6KB IIFE bundle

### CLI (`cli/`)
- `npx @meshwhisper/cli init` — interactive scaffolding
- Generates developer key (32 bytes base64) and salt (32 bytes hex)
- Prints `.env` block and SDK init snippet
- For self-hosted: generates `docker-compose.yml` with Node + push services

### Browser/PWA support
- Zero-config: `MeshWhisper.init()` auto-detects `window` + `indexedDB`, selects `IDBStorage` + `BrowserTransport`
- No `ws`, `fs`, `dgram`, or `net` in browser bundles — all Node.js-only imports are dynamic
- Packet serialization extracted to `websocket/serialize.ts` — shared, no platform dependencies
- All `Buffer.from()` calls replaced with browser-compatible hex/base64 helpers
- `PushConfig` is a discriminated union: `apns | fcm | webpush`

---

## What is scaffolded but not production-complete

These modules exist with correct interfaces and reasonable implementations but have not been fully exercised or tested:

- **`src/routing/`** — SocialGraphRouter and PeerProximityTable exist; routing decisions in `sendMessage()` fall back to broadcasting rather than optimally routing
- **`src/cluster/`** — DeviceCluster scaffolded; multi-device sync (same identity, two devices) not implemented
- **`src/group/`** — GroupManager exists; sender key ratchet for groups is basic
- **`src/sybil/`** — EntropyChallenger and ZKRelayReputation scaffolded; not wired into the Node
- **`src/compliance/`** — audit hooks scaffolded; not production-hardened
- **`src/reciprocity/`** — RelayLedger tracks bytes relayed; no enforcement logic

---

## Known gaps and limitations

### Critical for production

1. **Node is in-memory only** — server restart loses all queued blobs, push registrations, and prekey bundles. No database backend. Acceptable for development and low-stakes deployments, not for production at scale.

2. **No Foundation relay** — `FOUNDATION_RELAY_NODES = ['wss://relay.meshwhisper.io']` — this domain does not exist. `node: 'mesh'` silently fails. Every developer must self-host.

3. **No end-to-end integration tests** — 87 unit tests covering crypto, X3DH, ratchet, and packet layers. No test exercises the full stack: SDK → Node → push service → SDK.

4. **No multi-device support** — the same identity key on two devices is not handled. Device 2 would generate a different identity and appear as a different user.

### Minor

5. **`ws` is an optional dependency** — moved from `dependencies` to `optionalDependencies`. In some environments this may not install automatically for Node.js users who need `NodeTransport`.

6. **Service worker requires manual copy** — `dist/meshwhisper-sw.js` must be copied to the public directory manually. No automated step.

7. **Node registry / mesh routing** — `node: 'mesh'` picks `FOUNDATION_RELAY_NODES[0]` blindly. No health checking, no geographic routing, no fallback.

8. **No developer key validation on the Node** — the `developerKey` field exists in the SDK config but the Node does not validate it. Rate limiting is IP-based only.

9. **RatchetState serialization uses private field access** — `identity['edPrivateKey']` accesses a private TypeScript field with bracket notation. Works at runtime but bypasses type safety.

---

## Package summary

| Package | npm | Version | Purpose |
|---|---|---|---|
| `@meshwhisper/sdk` | published | 0.1.0 | Client library — browser, Node.js, React Native |
| `@meshwhisper/node` | published | 0.1.0 | Relay server binary |
| `@meshwhisper/push-service` | published | 0.1.0 | APNs / FCM / Web Push dispatcher |
| `@meshwhisper/cli` | published | 0.1.0 | `npx @meshwhisper/cli init` scaffolding |
| `@meshwhisper/service-worker` | published | 0.1.0 | PWA push event handler (1.6KB) |

---

## Technology choices

| Concern | Choice | Reason |
|---|---|---|
| Crypto primitives | `@noble/curves`, `@noble/ciphers`, `@noble/hashes` | Audited, pure JS, browser + Node.js compatible, no WASM |
| Compression | `lz4js` | Fast, browser-compatible |
| Node.js WebSocket | `ws` | Mature, widely used |
| FCM auth | `google-auth-library` | Official Google library |
| Web Push | `web-push` | Standard VAPID implementation |
| Service worker build | `esbuild` | Fast, produces small IIFE bundle |
| Language | TypeScript strict mode throughout | |
| Test runner | Vitest | Fast, ESM-native |

---

## File sizes (source, excluding tests)

| File | Lines |
|---|---|
| `src/sdk/index.ts` | 1994 |
| `node/src/index.ts` | 662 |
| `src/transport/websocket/index.ts` | ~620 |
| `src/transport/local/index.ts` | ~400 |
| `src/ratchet/index.ts` | ~350 |
| `src/x3dh/index.ts` | ~300 |
| All SDK source combined | ~11,000 |
| All packages combined | ~14,000 |

---

## What a reviewer should focus on

1. **Cryptography correctness** — `src/crypto/`, `src/x3dh/`, `src/ratchet/`. These are the most security-critical files. The test suites cover the happy path; edge cases (malformed packets, replayed messages, key compromise) need review.

2. **RatchetState serialization** — `src/persistence/serialization.ts`. Correct serialization of ratchet state is critical for session persistence. A bug here silently breaks all messaging after a restart.

3. **Node relay security** — `node/src/index.ts`. Rate limiting, input validation, blob size limits. The Node is internet-facing.

4. **Private key handling** — identity private keys are stored in the `StorageBackend`. In `IDBStorage` this means they are in IndexedDB in plaintext. Acceptable for a browser environment but worth noting.

5. **The `__mw_ctrl` control message protocol** — `src/sdk/index.ts` around `tryParseControl()`. Control messages (delivery receipts) travel through the same encrypted channel as user messages. A malformed control message should not crash the SDK.
