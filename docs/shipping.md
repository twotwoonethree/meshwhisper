# MeshWhisper — Shipping Plan

What needs to happen before a real user can send a message and not notice anything is wrong.

---

## Current state

The protocol layer is complete and correct:

- X3DH key exchange (`src/x3dh/`) — tested, working
- Double Ratchet encryption (`src/ratchet/`) — tested, working, forward secrecy correct
- Packet framing, chaff, routing (`src/packet/`, `src/routing/`) — tested
- WebSocket relay + store-and-forward (`node/`) — working
- Prekey directory (`node/`) — working
- Push token registration and webhook dispatch (`node/`) — wired up
- Media upload/download (`node/`, `src/sdk/`) — working
- CLI onboarding (`cli/`) — working

What's missing is the production layer that sits on top: state that survives process restarts, and a notification pipeline that actually reaches Apple and Google.

---

## Phase 1 — Make it not broken

These four items must all be done before a real user touches the app. Each one produces visible, conversation-ending failures without it.

---

### 1.1 Session persistence

**The problem**

Ratchet sessions live in `sdk/index.ts → this.sessions: Map<string, RatchetState>`. When the app process dies, all session state is lost. The next message sent or received after a restart will either fail to decrypt (if the ratchet is out of sync) or produce garbage. The user sees nothing useful — messages silently break.

**What to build**

A `SessionStore` abstraction with two implementations:

```
src/persistence/
  session-store.ts       — interface + serialization helpers
  session-store-node.ts  — Node.js implementation (fs, encrypted with identity key)
  session-store-rn.ts    — React Native stub (AsyncStorage / SQLCipher)
```

The interface:

```typescript
interface SessionStore {
  load(peerId: string): Promise<RatchetState | null>;
  save(peerId: string, state: RatchetState): Promise<void>;
  delete(peerId: string): Promise<void>;
  loadAll(): Promise<Map<string, RatchetState>>;
}
```

The SDK's `sendMessage` and `ratchetDecrypt` paths already update `this.sessions` — those same call sites write through to the store. On startup, `SessionStore.loadAll()` repopulates the map.

Serialization: `RatchetState` contains `Map<string, Uint8Array>` (skipped keys) and `Uint8Array` fields. Serialize to JSON with hex encoding for byte arrays. Encrypt the file/record with a key derived from the local identity private key so session state is not readable without the identity.

**Complexity:** medium. The serialization is fiddly (Maps, Uint8Arrays). The encryption wrapper is straightforward. Platform implementations need to be written per-target.

**Files to change:** `src/sdk/index.ts` (wire store into encrypt/decrypt paths), new `src/persistence/` module.

---

### 1.2 Message history persistence

**The problem**

Received messages are delivered to `onMessage` and discarded. The SDK holds no message log. When the user backgrounds the app and returns, the conversation is empty. They cannot scroll back. Any message received while the app was suspended and before the push wake completes is unrecoverable.

**What to build**

A `MessageStore` abstraction alongside the session store:

```
src/persistence/
  message-store.ts       — interface
  message-store-node.ts  — Node.js / SQLite implementation
  message-store-rn.ts    — React Native stub
```

The interface:

```typescript
interface MessageStore {
  append(conversationId: string, message: StoredMessage): Promise<void>;
  load(conversationId: string, limit: number, before?: number): Promise<StoredMessage[]>;
  markDelivered(messageId: string): Promise<void>;
  markRead(messageId: string): Promise<void>;
}

interface StoredMessage {
  id: string;
  conversationId: string;
  senderId: string;
  payload: Uint8Array;
  timestamp: number;
  direction: 'inbound' | 'outbound';
  status: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
}
```

The SDK writes to the store in two places: on `sendMessage` (direction: outbound, status: sent) and on successful decrypt (direction: inbound). The app reads from the store to render the conversation view.

**Complexity:** low-medium. The interface is simple. The SQLite schema is three tables (conversations, messages, delivery_status). React Native's existing SQLite libraries handle the heavy lifting.

**Files to change:** `src/sdk/index.ts`, new `src/persistence/` module.

---

### 1.3 Silent session re-establishment

**The problem**

When a user reinstalls the app, their ratchet state is gone. Their contact's ratchet is still advanced. The next message their contact sends is encrypted with a key the reinstalled user cannot derive — decryption fails silently. There is no mechanism to recover. The user's only option today is to somehow convince their contact to also reinstall, or to implement manual session reset in the app layer.

This happens whenever:
- The user reinstalls the app
- The user gets a new device
- Local storage is cleared or corrupted
- Session state deserialization fails after an upgrade

**What to build**

When `ratchetDecrypt` throws, the SDK should:

1. Check whether the sender has a current prekey bundle in the directory.
2. If yes: silently initiate a new X3DH exchange, establish a fresh ratchet session, and queue a `SESSION_RESET` control message to the sender so their side also resets.
3. If no: surface the failure to the app layer with enough information to prompt re-registration.

The `SESSION_RESET` message type needs to be added to the packet protocol. It carries the initiator's new ephemeral public key so the other party can complete X3DH and synchronise to the new session.

This also requires the Node's prekey directory to hold fresh bundles — which means the SDK needs to re-register its prekey bundle after session re-establishment, not just at first launch.

**Complexity:** high. This is the most complex item in Phase 1. The state machine for "decrypt failed, attempt re-establishment, retry queued messages once session is live" has several edge cases. Signal's implementation of this (sealed sender + session reset) is well-documented and worth reading before implementing.

**Files to change:** `src/sdk/index.ts` (decrypt error handling, re-establishment flow), `src/packet/index.ts` (SESSION_RESET type), `src/x3dh/index.ts` (already supports re-initiation).

---

### 1.4 End-to-end push notifications

**The problem**

The Node correctly stores push tokens and fires a POST to `PUSH_WEBHOOK_URL` when a blob arrives for an offline device. But there is no webhook implementation. No APNs call happens. No FCM call happens. iOS and Android users receive nothing when the app is closed.

**What to build**

A push service — a small standalone HTTP server or serverless function — that accepts the Node's webhook payload and dispatches to APNs/FCM:

```
push-service/
  src/index.ts     — HTTP server, accepts POST { token, platform, topic?, destHash }
  src/apns.ts      — APNs HTTP/2 dispatch (uses @parse/node-apns or http2 directly)
  src/fcm.ts       — FCM v1 API dispatch (uses google-auth-library for OAuth2)
```

The push payload sent to both platforms should be a **silent notification** — no visible alert, just a background wake signal. The app wakes, connects to the Node WebSocket, sends `{ type: "pull" }`, and receives the queued blobs. The actual message content is never in the push payload.

APNs requirements:
- Apple Developer account
- APNs auth key (`.p8` file) or certificate
- Bundle ID of the host app
- `apns-push-type: background`, `apns-priority: 5`

FCM requirements:
- Firebase project
- Service account JSON for FCM v1 API
- `priority: normal` for background delivery

The push service can be deployed as a sidecar container alongside the Node, or as a separate service. It holds the APNs/FCM credentials and should not be the Node itself (credentials are per-app, not per-infrastructure).

**Complexity:** medium. APNs HTTP/2 is well-understood. FCM v1 is straightforward. The main complexity is credential management — the push service needs to securely hold signing keys for every app it serves.

---

### 1.5 Encrypted push payloads (rich notifications)

**The problem**

The current push pipeline is intentionally content-blind: when a blob arrives for an offline device, the relay fires a wake-only webhook and the receiver's service worker shows a generic "You have a new message" notification. Mobile users opening their phones see no sender name and no message preview, which is a noticeable UX deficit compared to WhatsApp / Signal / iMessage.

The reason is structural — neither the relay, the push service, nor the SW has the ratchet keys to decrypt anything. So the foreground tier (Phase 1.5 partial — already shipped: in-app rich notifications when Prudence is open in any tab) covers the case where the app is loaded, but the closed-app case still falls back to the generic notification.

**What to build**

The standard pattern (this is how WhatsApp does it): the encrypted blob rides inside the Web Push payload, not stored at the relay for later fetch.

1. **Relay** — the existing push webhook payload changes from `{ destHash, push }` to `{ destHash, push, blob }` where `blob` is the base64-encoded ratchet-encrypted packet. The relay already has it (`storeBlob` just stored it); now it forwards it.
2. **Push service** — when dispatching the Web Push, include the blob in the payload. Web Push payloads are encrypted on the wire by the browser's push subscription keys and are limited to ~3-4 KB after that envelope, so most text messages fit. Media messages degrade gracefully to a generic notification.
3. **Service worker** — receives the push with ciphertext, reads the relevant ratchet state from IDB, runs the decrypt, then calls `showNotification()` with the actual sender + message preview.

The SW will need a stripped-down subset of the SDK in its bundle — at minimum the ratchet decrypt path, the storage helpers for reading sessions, and the seen-message dedup. Most of the SDK doesn't need to ship; we only need decrypt-and-display, not send/connect/handshake.

**Privacy delta**

The push service currently sees only the recipient's destHash. After this change it would also see ratchet-encrypted blob bytes. The push service still cannot read content (the blob is encrypted with the recipient's session key) but it gains visibility into message *sizes*. This is a small leak relative to the metadata the relay already handles. Web Push's wire encryption protects against passive observers between the push service and the device.

APNs / FCM payloads have the same property — the encrypted blob is opaque to Apple / Google.

**What it does not solve**

- Group messages: the SW would need to also have the group sender keys and the inner-decrypt path. Doable but adds bundle weight. The first iteration can fall back to "Bob sent a message in #group" without the content.
- Media: pointer messages decrypt fine, but the actual media file is fetched separately. Notification body becomes "Photo" or "File" — same as WhatsApp.
- Push retention: APNs/FCM may drop background pushes if the device has been offline a long time. The 30-day blob queue covers the recipient eventually opening the app and draining via WebSocket.

**Dependencies**

- 1.4 (push pipeline exists) — done.
- The decrypt-in-SW work needs the SDK's ratchet code to be bundleable into a worker context. Currently the SDK has imports that assume browser globals. Some modules pull in things like `Buffer` polyfills that need to either be available in the SW or replaced.

**Complexity:** medium-high. The cryptographic plumbing is well-understood. The complexity is in keeping the SW bundle small and making the decrypt path robust across edge cases (out-of-order delivery, missed-but-then-arriving messages, ratchet step skips).

---

## Phase 2 — Make it feel complete

These are visible gaps that users notice within the first day. None of them break the app; all of them make it feel unfinished.

---

### 2.1 Delivery receipts

**What:** When a message is successfully decrypted, the recipient sends a `DELIVERED` ACK back through the ratchet session. When the sender reads it, the sender sends a `READ` receipt. Both update `StoredMessage.status` in the message store.

**What already exists:** `MessageUrgency` and message IDs are already in the envelope. The packet type for control messages exists. This is mostly wiring.

**Complexity:** low.

---

### 2.2 Deduplication

**The problem:** A message can arrive via multiple paths — direct P2P and Node relay simultaneously. Without deduplication, the user sees the same message twice.

**What:** A seen-set of message IDs (keyed by `envelope.id`) checked before delivering to `onMessage` and before writing to the message store. Persist the seen-set with a rolling window of ~24h to bound memory.

**Complexity:** low.

---

### 2.3 Multi-device

**The problem:** A user's phone and tablet have different key pairs and different dest hashes. Messages sent to the phone don't appear on the tablet. There is no device linking concept.

**What this requires:**
- A device registry per identity (held in the prekey directory or a new endpoint)
- The SDK sends a copy of each outbound message to all linked devices, encrypted to each device's key
- Linked device sessions are managed separately from contact sessions
- A device linking flow (QR code scan, similar to Signal's linked devices)

**Complexity:** high. This is a significant protocol extension. Flag for a later milestone.

---

### 2.4 Typing indicators and presence

**What:** Ephemeral control messages sent through the ratchet session. `TYPING_START`, `TYPING_STOP`, `PRESENCE_ONLINE`. These do not need to be stored or reliable — fire-and-forget through the existing `sendMessage` path with `urgency: 'background'`.

**What already exists:** `onPresence` callback is already in `MeshWhisperConfig`. The plumbing exists; the message types and emit logic need to be added.

**Complexity:** low.

---

## Phase 3 — Make it trustworthy

These items do not affect the user experience directly but matter before any serious deployment.

---

### 3.1 Key verification

Without safety numbers or a key verification flow, the X3DH handshake is vulnerable to a MITM who controls the prekey directory. An attacker who can intercept the `GET /directory` response can substitute their own prekey bundle. The ratchet session is then established with the attacker, not the intended recipient.

**What:** Expose a fingerprint (truncated hash of both parties' identity public keys) that users can compare out-of-band. Display it in the app as a numeric code or QR code. This is already standard UX in Signal, WhatsApp, and Telegram.

**Complexity:** low (the fingerprint computation is trivial). The UX design is the actual work.

---

### 3.2 Rate limiting on the Node

`POST /media` and `POST /directory` have no rate limiting. A single client can fill the media store or flood the prekey directory. Add per-IP and per-dest-hash rate limits before any public deployment.

**Complexity:** low.

---

### 3.3 Foundation node deployment

The `FOUNDATION_RELAY_NODES` constant in `src/transport/node/index.ts` points to `wss://relay.meshwhisper.io` which does not exist. Until at least one Foundation node is running, `node: "mesh"` silently fails and the SDK falls back to direct P2P only.

**What:** Deploy at least one Node instance. One Hetzner CAX11 (€4/month) running the Docker image is sufficient to validate the full end-to-end flow.

---

## Dependencies and order

```
1.2 Message history    ←─ no dependencies, start immediately
1.1 Session persist    ←─ no dependencies, start immediately
1.4 Push service       ←─ no dependencies, start immediately
1.3 Session re-estab   ←─ depends on 1.1 (needs persistent sessions to be worth re-establishing)

2.2 Deduplication      ←─ depends on 1.2 (needs message store for seen-set)
2.1 Delivery receipts  ←─ depends on 1.2
2.4 Typing/presence    ←─ no hard dependencies

3.1 Key verification   ←─ no hard dependencies
3.2 Rate limiting      ←─ no hard dependencies
3.3 Foundation node    ←─ depends on 1.4 (needs push working to be useful)
2.3 Multi-device       ←─ depends on all of Phase 1
```

## What is explicitly out of scope

- Native iOS (Swift) and Android (Kotlin) SDKs — the TypeScript SDK works in React Native via the existing WebSocket and crypto APIs
- ZK relay reputation and Sybil resistance — correct direction, not blocking anything
- S3/R2 media backend — in-memory media store is fine for early deployments
- End-to-end encrypted backups — important eventually, not Phase 1
