# Getting Started with MeshWhisper

This guide takes you from zero to a working PWA with end-to-end encrypted messaging. Follow every step in order.

**What you will have at the end:**
- Two Docker containers running on your server — your complete messaging backend
- A PWA that sends and receives encrypted messages
- Push notifications that wake the app when a message arrives while it is closed

**What you need:**
- A server you already have (any VPS — 1 CPU, 512MB RAM is enough)
- Docker and Docker Compose on that server
- A domain or subdomain pointing at it (e.g. `relay.myapp.com`)
- Node.js 18+ on your development machine

**Time required:** 1–2 hours on a first deployment. Under 30 minutes once you've done it before.

---

## Step 1 — Scaffold your project

On your development machine:

```bash
mkdir my-chat-app && cd my-chat-app
npm init -y
npx @meshwhisper/cli init
```

The CLI asks a few questions:

1. **App namespace / bundle ID** — reverse-domain format, e.g. `com.example.mychatapp`
2. **Node** — choose `2` (self-hosted), then enter `wss://relay.myapp.com` (your subdomain).
   (Choosing `1` connects you to the Foundation relay with zero setup — fine for development; come back to self-hosting when you go to production.)
3. **Web Push** — say yes; the CLI generates your VAPID keys for you
4. **Join the relay mesh** — say yes to participate in [open federation](federation.md); your node will forward packets for other relays and they for you
5. **App platform** — Browser/PWA or Node.js

It writes everything it needs:

- **`meshwhisper-node/`** — your complete server deployment: `docker-compose.yml`, standalone Dockerfiles (they install the published `@meshwhisper/node` package — no repo checkout needed), a `.env` with your generated VAPID keys and `BASE_URL`, and `federation-peers.json` bootstrapped against the Foundation relay
- **`src/meshwhisper.ts`** (browser) or **`meshwhisper-chat.mts`** (Node.js) — a working SDK skeleton with your namespace and node URL already threaded in
- **`.gitignore`** entries for the `.env` and local identity stores

> `meshwhisper-node/.env` contains your VAPID private key. The CLI gitignores it for you — keep it that way.

---

## Step 2 — Deploy your Node

Your Node is your messaging backend. It runs on your server, serves only your app, and cannot read any messages that pass through it.

### 2a — Copy and review

Copy the `meshwhisper-node/` directory to your server. Open `.env` and confirm `BASE_URL` matches your domain exactly (no trailing slash) — the CLI derived it from your `wss://` URL, so it usually already does. The VAPID keys are already in there; if you ever need fresh ones: `npx @meshwhisper/cli vapid`.

> `BASE_URL` is required. Without it, media download URLs will use the internal container address and be unreachable from the internet.

### 2b — Set up your reverse proxy

Your Node listens on port 8080. Your reverse proxy handles TLS.

**Caddy** (recommended — gets a TLS certificate automatically):

Add to your `Caddyfile`:
```
relay.myapp.com {
    reverse_proxy localhost:8080
}
```
```bash
sudo systemctl reload caddy
```

**nginx** — see [docs/self-hosting.md](self-hosting.md) for the full config block.

### 2c — Start it

```bash
docker compose up -d
```

Verify:
```bash
curl https://relay.myapp.com/health
```

Expected:
```json
{"status":"ok","clients":0,"storedBlobs":0,"prekeyEntries":0,"pushRegistrations":0,"mediaEntries":0}
```

If you see a connection error, check `docker compose logs node`.

---

## Step 3 — Install the SDK and service worker

On your development machine:

```bash
npm install @meshwhisper/sdk @meshwhisper/service-worker
```

Copy the service worker into your public directory:

```bash
cp node_modules/@meshwhisper/service-worker/dist/meshwhisper-sw.js public/
```

The service worker must be served from the **root** of your domain (`https://myapp.com/meshwhisper-sw.js`). Adjust the destination path if your public directory has a different name (`static/`, `www/`, etc.).

---

## Step 4 — Add messaging to your app

The CLI already generated a starter module at `src/meshwhisper.ts` with your namespace and node URL threaded in — wire that into your app and paste in your VAPID public key. The expanded version below shows the full surface (media, history, delivery status) if you want to build it out by hand:

```ts
import { MeshWhisper } from '@meshwhisper/sdk';
import type { WebPushSubscription } from '@meshwhisper/sdk';

// Your VAPID public key from Step 2a
const VAPID_PUBLIC_KEY = 'your_vapid_public_key_here';

// Your Node URL from Step 1
const NODE_URL = 'wss://relay.myapp.com';

// Your bundle ID from Step 1
const NAMESPACE = 'com.example.mychatapp';

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function initMessaging(
  onMessage: (senderId: string, text: string) => void,
  onStatusChange: (messageId: string, status: string) => void,
) {
  // Register service worker for push notifications
  const registration = await navigator.serviceWorker.register('/meshwhisper-sw.js');

  // Subscribe to Web Push
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  });

  // Initialize MeshWhisper
  // In a browser this auto-selects IndexedDB for storage and the native WebSocket API
  const mw = await MeshWhisper.init({
    namespace: NAMESPACE,
    node: NODE_URL,
    push: {
      platform: 'webpush',
      subscription: subscription.toJSON() as WebPushSubscription,
    },
    onMessage: async (message) => {
      // Media messages
      const media = await MeshWhisper.downloadMedia(message);
      if (media) {
        console.log('Received media from', message.senderId, '— handle as needed');
        await MeshWhisper.markRead(message.id, message.senderId);
        return;
      }

      // Text messages
      const text = new TextDecoder().decode(new Uint8Array(message.payload));
      onMessage(message.senderId, text);
      await MeshWhisper.markRead(message.id, message.senderId);
    },
    onMessageStatus: (messageId, status) => {
      onStatusChange(messageId, status); // 'sent' → 'delivered' → 'read'
    },
    onPresence: (peerId, status) => {
      console.log(`${peerId} is ${status}`);
    },
  });

  return mw;
}

// Your peer ID — share this with contacts so they can message you
export function getMyId(): string {
  return MeshWhisper.instance.getLocalPeerId();
}

// Send a text message
export async function sendMessage(recipientId: string, text: string): Promise<void> {
  await MeshWhisper.send(recipientId, new TextEncoder().encode(text));
}

// Send a file
export async function sendFile(recipientId: string, file: File): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  await MeshWhisper.sendMedia(recipientId, bytes, { mimeType: file.type });
}

// Load message history for a conversation
export async function loadHistory(peerId: string) {
  return MeshWhisper.getMessages(peerId, { limit: 50 });
}
```

Wire it into your app:

```ts
import { initMessaging, getMyId, sendMessage } from './messaging';

const mw = await initMessaging(
  (senderId, text) => appendMessage({ from: senderId, text }),
  (messageId, status) => updateDeliveryTick(messageId, status),
);

// Show the user their peer ID so they can share it with contacts
document.getElementById('my-id').textContent = getMyId();

// Send on button click
document.getElementById('send-btn').addEventListener('click', async () => {
  const recipientId = document.getElementById('recipient-id').value;
  const text = document.getElementById('message-input').value;
  await sendMessage(recipientId, text);
});
```

---

## Step 5 — Test it

Open your PWA in **two different browsers** (or two devices).

1. Copy the peer ID shown in browser A
2. Paste it as the recipient in browser B and send a message
3. It should appear in browser A within one or two seconds

**Test offline delivery:**
1. Close browser A's tab completely
2. Send a message from browser B
3. Browser A should show a "New message" notification
4. Click it — the app opens and the message is there

---

## Step 6 — Verify the stack is healthy

```bash
# Your Node (public)
curl https://relay.myapp.com/health

# Your push service (on the server)
curl http://localhost:4000/health
# {"status":"ok","apns":false,"fcm":false,"webpush":true}
```

---

## Common problems

**Messages not delivering**
- `docker compose logs node` — look for startup errors
- Confirm `BASE_URL` in `docker-compose.yml` matches your public HTTPS domain exactly, no trailing slash
- Confirm the SDK `node` URL starts with `wss://` not `ws://`

**Push notifications not arriving**
- `docker compose logs push` — look for errors
- Confirm `VAPID_PUBLIC_KEY` in your PWA code exactly matches the value in your server `.env` — one character off and it silently fails
- Open `https://myapp.com/meshwhisper-sw.js` in a browser — if it 404s, the service worker isn't being served from the right location

**"NotAllowedError" on push subscribe**
- The page must be served over HTTPS
- Call `await Notification.requestPermission()` before subscribing and confirm the user grants it

**Identity resets on every page load**
- The site is probably running in private/incognito mode — IndexedDB writes are blocked in that mode in most browsers
- Check the browser console for IndexedDB errors

**`npm install @meshwhisper/sdk` fails**
- Requires Node.js 18 or higher — `node --version` to check

---

## iOS and Android push notifications

Web Push works for PWAs. For native iOS and Android apps, replace the `push` config:

**iOS (APNs):**
```ts
push: {
  platform: 'apns',
  token: deviceToken,       // from native APNs registration
  topic: 'com.example.app', // your bundle ID
}
```

Add to your push service environment:
```bash
APNS_KEY_ID=XXXXXXXXXX
APNS_TEAM_ID=YYYYYYYYYY
APNS_KEY_PATH=/run/secrets/apns_key
APNS_BUNDLE_ID=com.example.app
APNS_PRODUCTION=true
```

**Android (FCM):**
```ts
push: {
  platform: 'fcm',
  token: fcmToken,          // from Firebase SDK
}
```

Add to your push service environment:
```bash
FCM_SERVICE_ACCOUNT_PATH=/run/secrets/fcm_service_account
FCM_PROJECT_ID=my-firebase-project
```

See [docs/self-hosting.md](self-hosting.md) for the complete environment variable reference.

---

## Next steps

- **Message history** — `MeshWhisper.getMessages(peerId, { limit: 50 })` to populate a conversation on load
- **Contact sharing** — `MeshWhisper.generateContactQR()` to produce a shareable contact card
- **Group chats** — `MeshWhisper.createGroup({ name, members })` — see [docs/api.md](api.md)
- **React Native** — use an `AsyncStorage` wrapper as the storage backend — see the React Native section in [docs/api.md](api.md)
- **Full API reference** — [docs/api.md](api.md)
- **All server options** — [docs/self-hosting.md](self-hosting.md)
