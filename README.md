# MeshWhisper

Serverless P2P end-to-end encrypted messaging SDK. Drop messaging into any app — PWA, React Native, Node.js — without building or operating a message server that can read your users' messages.

## How it works

```
Alice's device                Node (relay)              Bob's device
──────────────                ────────────              ────────────
MeshWhisper.init()  ──ws──►  stores blob          ◄──ws──  MeshWhisper.init()
send(bobId, msg)    ──────►  routes by destHash   ──────►  onMessage(msg)
                             (cannot decrypt)
```

- **X3DH** key exchange on first contact — no prior communication needed
- **Double Ratchet** per message — forward secrecy, break-in recovery
- **Destination hash routing** — the Node knows *where* to route, never *who* sent what
- **Store and forward** — messages queue on the Node while the recipient is offline
- **Push wake** — Node triggers a silent APNs/FCM/Web Push when a message arrives for an offline device

The Node relay and push service are the only infrastructure you run. They are intentionally dumb: they relay encrypted bytes and ring a doorbell. They cannot read messages.

---

## Repository layout

```
@meshwhisper/sdk             — client SDK (browser + Node.js)
  src/sdk/index.ts           — public API surface
  src/transport/browser/     — BrowserTransport (native WebSocket)
  src/transport/node/        — NodeTransport (ws package)
  src/persistence/idb-*      — IndexedDB storage backend
  src/persistence/node-*     — Filesystem storage backend

@meshwhisper/node  (node/)   — relay server (WebSocket + HTTP)
@meshwhisper/push-service    — APNs / FCM / Web Push dispatcher
@meshwhisper/cli   (cli/)    — npx @meshwhisper/cli init
@meshwhisper/service-worker  — PWA service worker helper
```

---

## Quick start — PWA

```ts
import { MeshWhisper } from '@meshwhisper/sdk';

// Auto-detects browser: uses IDBStorage + BrowserTransport
const mw = await MeshWhisper.init({
  namespace: 'com.example.myapp',
  node: 'wss://relay.myapp.com',       // your self-hosted Node, or 'mesh'
  onMessage: (message) => {
    const text = new TextDecoder().decode(new Uint8Array(message.payload));
    appendToChat(message.senderId, text);
  },
});

const myId = mw.getLocalPeerId();      // share this with contacts

// First message to a new contact initiates X3DH automatically
await MeshWhisper.send(contactId, new TextEncoder().encode('Hello!'));
```

## Quick start — Node.js

```ts
import { MeshWhisper } from '@meshwhisper/sdk/node';
import { NodeStorage } from '@meshwhisper/sdk/node';

const mw = await MeshWhisper.init({
  namespace: 'com.example.myapp',
  node: 'wss://relay.myapp.com',
  storage: new NodeStorage('./data'),   // persists identity + sessions to disk
  onMessage: (message) => {
    const text = new TextDecoder().decode(new Uint8Array(message.payload));
    console.log(`[${message.senderId}]: ${text}`);
  },
});
```

---

## New to MeshWhisper?

See **[docs/getting-started.md](docs/getting-started.md)** — a complete step-by-step walkthrough from zero to a working PWA with push notifications.

## Self-hosting in 5 minutes

See **[docs/self-hosting.md](docs/self-hosting.md)** for the full guide.

The short version — copy this `docker-compose.yml` and fill in the push credentials you need:

```yaml
services:
  node:
    image: ghcr.io/meshwhisper/node:latest   # or build from node/Dockerfile
    ports: ["8080:8080"]
    environment:
      BASE_URL: "https://relay.myapp.com"
      PUSH_WEBHOOK_URL: "http://push:4000/notify"

  push:
    image: ghcr.io/meshwhisper/push-service:latest
    environment:
      VAPID_PUBLIC_KEY: "..."
      VAPID_PRIVATE_KEY: "..."
      VAPID_SUBJECT: "mailto:ops@myapp.com"
      # APNS_KEY_ID / APNS_TEAM_ID / APNS_KEY_PATH / APNS_BUNDLE_ID (iOS)
      # FCM_SERVICE_ACCOUNT_PATH / FCM_PROJECT_ID (Android)
```

```bash
docker compose up -d
```

---

## Scaffolding a new project

```bash
npx @meshwhisper/cli init
```

Prompts for your bundle ID and node URL, then prints your `.env` block, SDK init snippet, and (optionally) a `docker-compose.yml`.

---

## Full API reference

See **[docs/api.md](docs/api.md)**.

---

## Security model

- The relay Node sees only encrypted ciphertext and truncated destination hashes. It cannot link a message to a sender identity.
- Destination hashes rotate every hour, limiting traffic-analysis correlation windows.
- The push service receives a token/subscription and a destination hash — no message content.
- Identity keys are generated on-device and never leave the device. The private key is stored in the configured `StorageBackend` only.
- Media blobs are encrypted locally before upload. The Node stores ciphertext; the decryption key is sent through the ratchet-encrypted message channel, never via the Node's HTTP API.

For a detailed threat model see the PRD at `meshwhisper-prd-v1.2.md`.
