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
│   ├── sdk/index.ts            Main public API (~1700 lines)
│   ├── types.ts                All shared TypeScript interfaces
│   ├── crypto/                 AES-256-GCM, BLAKE3, X25519, Ed25519
│   ├── x3dh/                   X3DH / PQXDH key exchange
│   ├── ratchet/                Double Ratchet algorithm
│   ├── packet/                 Wire format, compression, chaff
│   ├── fingerprint/            Safety numbers (Signal-style 60-digit codes)
│   ├── namespace/              Identity management, LocalIdentity
│   ├── permissions/            Permission model, contact list
│   ├── persistence/            StorageBackend interface + implementations
│   │   ├── types.ts            StorageBackend interface, StoredMessage, Conversation types
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
│   ├── node/index.ts           @meshwhisper/sdk/node entry point
│   └── react-native/index.ts   @meshwhisper/sdk/react-native entry point
│
├── node/                       @meshwhisper/node — relay server
│   └── src/index.ts            Single-file HTTP + WebSocket server (~880 lines)
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
│   ├── crypto.test.ts          27 tests — primitives
│   ├── x3dh.test.ts            34 tests — X3DH + PQXDH key exchange
│   ├── ratchet.test.ts         20 tests — Double Ratchet
│   ├── packet.test.ts          24 tests — wire format
│   ├── fingerprint.test.ts     13 tests — safety numbers
│   ├── conversations.test.ts   8 tests  — conversation list + deleteMessage
│   ├── message-features.test.ts 13 tests — expiry, typing, delivery receipts
│   ├── groups-contacts.test.ts 7 tests  — groups + contact management
│   └── integration.test.ts     4 tests  — full-stack SDK ↔ relay ↔ SDK
│
└── docs/
    ├── getting-started.md      Step-by-step integration guide
    ├── api.md                  Full SDK API reference
    ├── self-hosting.md         Deployment guide, all env vars
    ├── shipping.md             Internal build plan (phases 1-3)
    ├── whitepaper.md           Protocol whitepaper
    └── pq3-ratchet-spec.md     PQXDH ratchet spec notes
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

### X3DH / PQXDH Key Exchange (`src/x3dh/`)
- Full Signal X3DH implementation (3-DH and 4-DH with one-time pre-key)
- Hybrid PQXDH: X3DH + ML-KEM-768 encapsulation. When Bob's bundle includes a `pqPublicKey`, Alice encapsulates to it and the final shared secret mixes all X25519 DH outputs with the ML-KEM shared secret under BLAKE3 domain separation. Matches Signal's PQXDH specification.
- Bundle version byte: `0x01` = classical X3DH, `0x02` = PQXDH
- `generatePreKeyBundle()` returns private keys (bug fixed — they were previously discarded)
- `initiateKeyExchange()` and `completeKeyExchange()` both sides implemented
- Pre-key bundle serialization/deserialization for both bundle versions
- 34 passing tests covering classical and PQ paths, both sides of the handshake, and bundle serialization

### Double Ratchet (`src/ratchet/`)
- Full Signal Double Ratchet implementation
- `initSender()`, `initReceiver()`, `ratchetEncrypt()`, `ratchetDecrypt()`
- DH ratchet step, symmetric-key ratchet, message key derivation
- Skipped-message-key store, MAX_SKIP DoS guard, out-of-order delivery
- 20 passing tests including bidirectional exchange and out-of-order delivery

### Packet layer (`src/packet/`)
- Binary wire format: version, flags, destHash, senderEphemeralId, TTL, payload
- LZ4 compression/decompression
- Chaff packet generation (traffic analysis resistance)
- `Math.random()` replaced with `crypto.getRandomValues()` throughout
- 24 passing tests

### SDK public API (`src/sdk/index.ts`)
- `MeshWhisper.init(config)` — singleton initialisation, auto-detects browser / Node.js / React Native
- `MeshWhisper.send(recipientId, payload, options?)` — E2EE send, auto-initiates X3DH on first contact; `options.expiry` sets message TTL
- `MeshWhisper.onMessage` — decrypted inbound message callback; `message.groupId` + `message.groupSenderId` set for group messages
- `MeshWhisper.sendMedia()` / `downloadMedia()` — two-part encrypted media upload
- `MeshWhisper.getMessages(peerId, options)` — message history from storage
- `MeshWhisper.getConversations()` — all conversations sorted by recency
- `MeshWhisper.deleteMessage(messageId, conversationId)` — delete stored message
- `MeshWhisper.markRead(messageId, peerId)` — read receipts
- `MeshWhisper.getLocalPeerId()` — stable peer ID (hex Ed25519 public key)
- `MeshWhisper.getPresence()`, `onPresence` — presence tracking
- `MeshWhisper.sendTypingIndicator(peerId, isTyping)` — ephemeral typing events; `onTyping` callback
- `MeshWhisper.generateContactQR()`, `acceptContact()` — QR-based contact exchange
- `MeshWhisper.addContactByKey(query)` — add contact by peer ID or `@username` (relay directory lookup)
- `MeshWhisper.removeContact(peerId)`, `getContacts()` — contact list management
- `MeshWhisper.introduceContacts(peerA, peerB)` — mutual introduction; triggers `onContactRequest` on both peers
- `MeshWhisper.createGroup()`, `getGroup()`, `getGroups()`, `sendToGroup()` — group messaging
- `MeshWhisper.acceptGroupInvite(groupId)`, `getPendingGroupInvites()` — group invite flow; `onGroupInvite` callback
- `MeshWhisper.getSafetyNumber(peerId)`, `verifySafetyNumber(peerId, candidate)` — Signal-style safety numbers
- `MeshWhisper.exportArchive()` / `importArchive()` / `pushArchive()` / `pullArchive()` — encrypted archive backed by the relay; merge-based restore so multi-device state converges
- `MeshWhisper.deriveBackupKey(identityKeyBytes)` — static HKDF derivation used by the archive subsystem
- `MeshWhisper.shutdown()` — graceful stop + state persistence

### Persistence (`src/persistence/`)
- `StorageBackend` interface — 4 methods: get, set, delete, keys(prefix)
- `IDBStorage` — IndexedDB backend, browser/PWA, auto-selected in browser
- `NodeStorage` — filesystem backend, atomic writes (temp+rename), mode 0600, path traversal protection
- `serializeRatchetState()` / `deserializeRatchetState()` — versioned JSON (v1), all Uint8Arrays as hex
- Persisted: identity key, sessions, prekey bundles, peers, contacts, message history, seen message IDs

### Archive (`src/sdk/archive.ts`)
- HKDF-derived backup key and write-auth token, both rooted in the identity key (never sent to the relay)
- AES-GCM blob format: `nonce(12) | ciphertext+tag`
- `collectKv()` selects archive-eligible storage keys (`contacts`, `peers/*`, `messages/*`, `seen_ids`, `blocked`); identity, sessions, and short-lived key material are excluded
- `mergeKv()` merges remote KV into local storage: arrays are unioned, `messages/*` deduplicated by id, peers updated from remote — used on restore so multi-device state converges
- Relay endpoints: `PUT /archive/:peerId` (auth via `Bearer` of the HKDF-derived token, first writer claims the slot), `GET /archive/:peerId` (unauthenticated, content is encrypted)

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
- `addContactByKey` and `ensureSession` detect receive-only sessions (sending chain never initialised because no inbound ratchet message has yet arrived) and re-initiate. A receive-only session is a stuck state; overwriting it loses nothing
- After every outbound `x3dh_init` the SDK sends a `__mw_ctrl: 'handshake_activate'` ratchet message immediately. Decrypting it on the receiver runs the first DH ratchet step and creates their sending chain — without this, the receiver could be stuck in receive-only mode until the initiator happened to send some application-level message
- Inbound `x3dh_init` from a previously-unknown peer fires `onContactRequest(peerId, peerId, undefined)` so apps can surface a contact-request UI even if the peer's application-level follow-up never arrives

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
- SQLite persistence (`better-sqlite3`, WAL mode): blobs, push registrations, prekey bundles, and media all survive container restarts. `DB_PATH` env var controls location (default `./meshwhisper.db`; mount `/data` volume in Docker)
- Blob store: queues encrypted blobs for offline recipients, TTL 72h, max 500/hash, max 256KB/blob
- Push token store: persisted to SQLite, survives WebSocket disconnect and server restart
- Prekey directory: `POST /directory`, `GET /directory` — rate limited, persisted to SQLite
- Media store: `POST /media`, `GET /media/:id` — TTL 7 days, max 50MB/file, persisted to SQLite
- Archive store: `PUT /archive/:peerId`, `GET /archive/:peerId` — encrypted user backup, max 12MB/blob, SQLite-persisted, write-authenticated by SHA-256 of HKDF-derived token (first writer claims the slot)
- Push webhook: POSTs to `PUSH_WEBHOOK_URL` when blob arrives for offline device
- Rate limiting: sliding window per IP, configurable via env vars, `X-Forwarded-For` aware (in-memory, intentionally — ephemeral)
- CORS: all HTTP endpoints include `Access-Control-Allow-Origin: *` and handle OPTIONS preflight
- Health check: `GET /health` returns clients, blobs, prekeys, push registrations, media counts
- Graceful shutdown on SIGINT/SIGTERM — closes SQLite connection cleanly

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

### Safety numbers (`src/fingerprint/`)
- Signal-style 60-digit verification codes derived from a sorted BLAKE3 hash of two Ed25519 identity keys
- Format: 12 groups of 5 decimal digits, space-separated
- Identical regardless of which peer calls it first (sorted before hashing)
- `computeFingerprint(keyA, keyB)` and `verifySafetyNumber(peerId, candidate)` exported from `src/fingerprint/index.ts`
- 13 passing tests

### Browser/PWA and React Native support
- Zero-config: `MeshWhisper.init()` auto-detects `window` + `indexedDB`, selects `IDBStorage` + `BrowserTransport`
- React Native: `@meshwhisper/sdk/react-native` entry point. Auto-detected via absence of both `window.indexedDB` and `process.versions.node`. Uses native WebSocket API (`BrowserTransport`). Requires explicit `StorageBackend` (no IndexedDB).
- No `ws`, `fs`, `dgram`, or `net` in browser/RN bundles — all Node.js-only imports are dynamic
- Packet serialization extracted to `websocket/serialize.ts` — shared, no platform dependencies
- All `Buffer.from()` calls replaced with browser-compatible hex/base64 helpers
- `PushConfig` is a discriminated union: `apns | fcm | webpush`

---

## What is scaffolded but not production-complete

Some modules exist as designs awaiting the conditions under which they need to be activated. The whitepaper is honest about this: the protocol's design is broader than the implementation, and load-bearing claims are kept tight.

- **`src/routing/`** — SocialGraphRouter and PeerProximityTable. `sendMessage()` currently routes via dest-hash broadcast; optimal routing becomes meaningful only at high mesh density (Stage 3 in the adoption arc). Kept as-is; not load-bearing yet.
- **`src/sybil/`** — EntropyChallenger and ZKRelayReputation. The defence becomes meaningful when many independent relay operators exist; with one bootstrap operator there is nothing to attack and nothing to defend against. Kept; should not be claimed as production-grade sybil resistance until enforcement is wired into a multi-operator network.
- **`src/compliance/`** — audit-log hooks. Scaffolded interfaces only; not production-hardened. Should be described as a planned interface in external materials, not a shipped feature.
- **`src/reciprocity/`** — RelayLedger byte-tracking. The current direction is the Tor middle-node model: open forwarding without enforced tit-for-tat. The byte-tracking primitives may become inputs to future adaptive throttling; the BitTorrent-style enforcement scaffolding will not be used.
- **`src/cluster/`** — DeviceCluster (primary-receiver election for same-identity-on-two-devices). **Orthogonal** to the linked-devices multi-device implementation that has since shipped (`src/permissions/`, the `device_*` control messages, `createDeviceLinkOffer` / `acceptDeviceLinkOffer`). Cluster solves "two devices share one key and need to elect a receiver"; linked-devices solves "each device has its own key and the contact registry tracks them." Both can coexist in principle; Prudence uses cluster for its password-derived same-identity flow, and the `examples/linked-devices/` reference uses the linked-devices path. Candidate for clarification or removal in a future cleanup.
- **`src/permissions/`** — only the `open` and `mutual` permission models are exercised. `introduction`, `transactional`, and `custom` are scaffolded modes that should not be claimed as features until something actually uses them.

The honest framing across the codebase: layers that ship in real deployments are production. Layers that exist for problems emerging at scale are scaffolded, named clearly, and will be hardened in step with the conditions that make them necessary.

---

## Known gaps and limitations

### Minor

1. **`ws` is an optional dependency** — moved from `dependencies` to `optionalDependencies`. In some environments this may not install automatically for Node.js users who need `NodeTransport`.

2. **Service worker requires manual copy** — `dist/meshwhisper-sw.js` must be copied to the public directory manually. No automated step.

3. **No developer key validation on the Node** — the `developerKey` field exists in the SDK config but the Node does not validate it. Rate limiting is IP-based only.

4. **Multi-device persistence gaps** — the linked-devices flow (`createDeviceLinkOffer` / `acceptDeviceLinkOffer`) ships in v1; the per-(account, device) LWW replay-protection map is in-memory only, so a fresh device boot has no historical protection. Per-device signing certificates aren't implemented yet either — only the primary device (whose `peerId === accountKey`) can broadcast `device_added` / `device_revoked` announcements. See [multi-device.md](multi-device.md#whats-not-in-qr-pairing-v1) for the full list of deferred items.

---

## Package summary

| Package | npm | Version | Purpose |
|---|---|---|---|
| `@meshwhisper/sdk` | published | 0.1.1 | Client library — browser, Node.js, React Native |
| `@meshwhisper/node` | published | 0.1.1 | Relay server binary |
| `@meshwhisper/push-service` | published | 0.1.0 | APNs / FCM / Web Push dispatcher |
| `@meshwhisper/cli` | published | 0.1.0 | `npx @meshwhisper/cli init` scaffolding |
| `@meshwhisper/service-worker` | published | 0.1.0 | PWA push event handler (1.6KB) |

---

## Technology choices

| Concern | Choice | Reason |
|---|---|---|
| Crypto primitives | `@noble/curves`, `@noble/ciphers`, `@noble/hashes`, `@noble/post-quantum` | Audited, pure JS, browser + Node.js compatible, no WASM |
| Compression | `lz4js` | Fast, browser-compatible |
| Node.js WebSocket | `ws` | Mature, widely used |
| Node persistence | `better-sqlite3` | Embedded, single-file, no external service, survives restarts |
| FCM auth | `google-auth-library` | Official Google library |
| Web Push | `web-push` | Standard VAPID implementation |
| Service worker build | `esbuild` | Fast, produces small IIFE bundle |
| Language | TypeScript strict mode throughout | |
| Test runner | Vitest | Fast, ESM-native |

---

## File sizes (source, excluding tests)

| File | Lines |
|---|---|
| `src/sdk/index.ts` | ~1700 |
| `node/src/index.ts` | ~880 |
| `src/transport/websocket/index.ts` | ~620 |
| `src/transport/local/index.ts` | ~400 |
| `src/ratchet/index.ts` | ~350 |
| `src/x3dh/index.ts` | ~330 |
| All SDK source combined | ~11,000 |
| All packages combined | ~14,000 |

---

## What a reviewer should focus on

1. **Cryptography correctness** — `src/crypto/`, `src/x3dh/`, `src/ratchet/`. These are the most security-critical files. The test suites cover the happy path; edge cases (malformed packets, replayed messages, key compromise) need review.

2. **RatchetState serialization** — `src/persistence/serialization.ts`. Correct serialization of ratchet state is critical for session persistence. A bug here silently breaks all messaging after a restart.

3. **Node relay security** — `node/src/index.ts`. Rate limiting, input validation, blob size limits. The Node is internet-facing.

4. **Private key handling** — identity private keys are stored in the `StorageBackend`. In `IDBStorage` this means they are in IndexedDB in plaintext. Acceptable for a browser environment but worth noting.

5. **The `__mw_ctrl` control message protocol** — `src/sdk/index.ts` around `tryParseControl()`. Control messages (delivery receipts) travel through the same encrypted channel as user messages. A malformed control message should not crash the SDK.
