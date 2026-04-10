# MeshWhisper SDK — API Reference

## Installation

```bash
npm install @meshwhisper/sdk
```

Import from the right entry point for your environment:

| Environment | Import |
|---|---|
| Browser / PWA | `@meshwhisper/sdk` *(auto-detected)* or `@meshwhisper/sdk/browser` |
| Node.js | `@meshwhisper/sdk` *(auto-detected)* or `@meshwhisper/sdk/node` |
| React Native | `@meshwhisper/sdk` + custom `StorageBackend` |

---

## `MeshWhisper.init(config)`

Initializes the SDK. Must be called before any other method. Returns the instance (also accessible as `MeshWhisper.instance`).

```ts
const mw = await MeshWhisper.init(config: MeshWhisperConfig): Promise<MeshWhisper>
```

**Auto-detection behaviour:**
- In a browser (`window` + `indexedDB` present): uses `IDBStorage` and `BrowserTransport` automatically. No storage or transport configuration needed.
- In Node.js: uses `NodeTransport`. Storage is `null` unless you pass `storage: new NodeStorage(path)`.

### `MeshWhisperConfig`

```ts
interface MeshWhisperConfig {
  namespace: string;
  node?: string | string[];
  developerKey?: string;
  permissionModel?: 'open' | 'mutual' | 'introduction' | 'transactional' | 'custom';
  push?: PushConfig;
  storage?: StorageBackend;
  onMessage?: (message: Message) => void;
  onPresence?: (peerId: string, status: PresenceStatus) => void;
  onMessageStatus?: (messageId: string, status: MessageStatus) => void;
  config?: {
    relayWillingness?: 'auto' | 'eager' | 'willing' | 'reluctant' | 'unavailable';
    chaffRate?: 'low' | 'normal' | 'high';
    storeTTL?: number;        // blob TTL hours, default 72
    clusterEnabled?: boolean;
  };
}
```

| Field | Required | Default | Description |
|---|---|---|---|
| `namespace` | Yes | — | Your app bundle ID, e.g. `"com.example.myapp"`. Namespaces identities so users of different apps can't message each other accidentally. |
| `node` | No | `"mesh"` | Relay URL(s). `"mesh"` uses Foundation-hosted relays. Pass `"wss://relay.myapp.com"` for self-hosted, or an array for redundancy. |
| `developerKey` | No | random | Base64-encoded developer public key. Tie to a stable key in production so sessions survive app updates. |
| `permissionModel` | No | `"open"` | Who can send messages. `"open"` = anyone. `"mutual"` = only existing contacts. |
| `push` | No | — | Push notification configuration. Required for offline delivery. See [`PushConfig`](#pushconfig). |
| `storage` | No | auto | Storage backend. Auto-selected in browser (IDBStorage) and Node.js (null). Pass explicitly to override. See [`StorageBackend`](#storagebackend). |
| `onMessage` | No | — | Called when a message is received. |
| `onPresence` | No | — | Called when a peer's online status changes. |
| `onMessageStatus` | No | — | Called when an outbound message's delivery status changes (`sent` → `delivered` → `read`). |

---

## Messaging

### `MeshWhisper.send(recipientId, payload, options?)`

Send an encrypted message. Initiates X3DH key exchange automatically on first contact.

```ts
await MeshWhisper.send(
  recipientId: string,      // peer ID (hex Ed25519 public key)
  payload: Uint8Array,
  options?: SendOptions,
): Promise<void>
```

```ts
interface SendOptions {
  urgency?: 'background' | 'normal' | 'urgent' | 'critical';  // default: 'normal'
  expiry?: number;   // seconds from now, after which the message should be discarded
}
```

**Example:**
```ts
await MeshWhisper.send(
  bobId,
  new TextEncoder().encode('Hello!'),
  { urgency: 'normal' },
);
```

### `MeshWhisper.onMessage` (config callback)

Registered in `init()`. Called for every decrypted inbound message.

```ts
onMessage: (message: Message) => void
```

```ts
interface Message {
  id: string;
  senderId: string;          // peer ID of the sender
  recipientId: string;       // your peer ID
  payload: Uint8Array;       // decrypted message bytes
  timestamp: number;         // Unix ms (sender's clock)
  urgency: MessageUrgency;
  expiry?: number;
}
```

**Example:**
```ts
const mw = await MeshWhisper.init({
  namespace: 'com.example.app',
  onMessage: (message) => {
    const text = new TextDecoder().decode(new Uint8Array(message.payload));
    console.log(`[${message.senderId}]: ${text}`);
  },
});
```

---

## Message history

### `MeshWhisper.getMessages(peerId, options?)`

Returns stored messages for a conversation. Requires `storage` to be configured.

```ts
const messages = await MeshWhisper.getMessages(
  peerId: string,
  options?: { limit?: number; before?: number }
): Promise<StoredMessage[]>
```

Returns messages sorted newest-first.

```ts
interface StoredMessage {
  id: string;
  conversationId: string;      // the peer ID
  senderId: string;
  recipientId: string;
  payload: number[];           // Uint8Array as plain array (JSON-serialisable)
  timestamp: number;
  direction: 'inbound' | 'outbound';
  status: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
}
```

**Example:**
```ts
const history = await MeshWhisper.getMessages(peerId, { limit: 50 });
for (const msg of history.reverse()) {
  renderMessage(msg);
}
```

### `MeshWhisper.markRead(messageId, peerId)`

Mark an inbound message as read. Sends a read receipt to the sender.

```ts
await MeshWhisper.markRead(messageId: string, peerId: string): Promise<void>
```

Triggers `onMessageStatus` on the sender's device with `status: 'read'`.

### `onMessageStatus` (config callback)

Called when an outbound message's delivery status changes.

```ts
onMessageStatus: (messageId: string, status: 'sent' | 'delivered' | 'read' | 'failed') => void
```

Status flow: `sending` → `sent` → `delivered` (automatic on decrypt by recipient) → `read` (on `markRead()` call).

---

## Media

### `MeshWhisper.sendMedia(recipientId, data, options?)`

Send a media file using the two-part encrypted upload flow. The Node never receives the decryption key.

```ts
await MeshWhisper.sendMedia(
  recipientId: string,
  data: Uint8Array,
  options?: MediaSendOptions,
): Promise<void>
```

```ts
interface MediaSendOptions extends SendOptions {
  mimeType?: string;                                    // e.g. 'image/jpeg', 'video/mp4'
  upload?: (encryptedData: Uint8Array) => Promise<string>;  // custom upload handler
}
```

The flow:
1. Encrypt `data` locally with a random AES-256-GCM key
2. Upload ciphertext to the Node (or your `upload` handler) → get URL
3. Send `{ url, key }` through the normal encrypted message channel

### `MeshWhisper.downloadMedia(message)`

Detect and download a media message. Returns `null` if the message is not a media pointer.

```ts
const bytes = await MeshWhisper.downloadMedia(message: Message): Promise<Uint8Array | null>
```

**Example:**
```ts
onMessage: async (message) => {
  const media = await MeshWhisper.downloadMedia(message);
  if (media) {
    displayImage(media);
  } else {
    const text = new TextDecoder().decode(new Uint8Array(message.payload));
    displayText(text);
  }
}
```

---

## Contacts

### `MeshWhisper.generateContactQR()`

Returns a QR code payload string (the local peer ID) for sharing as a contact.

```ts
const qrData = MeshWhisper.generateContactQR(): string
```

### `MeshWhisper.acceptContact(scannedQRData)`

Accept a contact from a scanned QR code. Initiates X3DH key exchange.

```ts
await MeshWhisper.acceptContact(scannedQRData: string): Promise<void>
```

---

## Identity

### `mw.getLocalPeerId()`

Returns the local peer ID — the hex-encoded Ed25519 public key. Share this with contacts so they can message you.

```ts
const myId = mw.getLocalPeerId(): string
```

The peer ID is stable as long as the storage backend persists. On a browser with `IDBStorage` it survives page reloads. On Node.js with `NodeStorage` it survives process restarts.

---

## Presence

### `MeshWhisper.getPresence(peerId)`

```ts
const status = MeshWhisper.getPresence(peerId: string): 'online' | 'recently_seen' | 'offline' | 'unknown'
```

### `onPresence` (config callback)

```ts
onPresence: (peerId: string, status: PresenceStatus) => void
```

---

## Push notifications

### `PushConfig`

```ts
type PushConfig =
  | { platform: 'apns';    token: string; topic?: string }
  | { platform: 'fcm';     token: string }
  | { platform: 'webpush'; subscription: WebPushSubscription };

interface WebPushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}
```

**Web Push (PWA):**
```ts
const registration = await navigator.serviceWorker.ready;
const subscription = await registration.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
});

const mw = await MeshWhisper.init({
  namespace: 'com.example.app',
  push: {
    platform: 'webpush',
    subscription: subscription.toJSON() as WebPushSubscription,
  },
  // ...
});
```

**APNs (iOS):**
```ts
// Get device token from native layer
const mw = await MeshWhisper.init({
  namespace: 'com.example.app',
  push: {
    platform: 'apns',
    token: deviceToken,
    topic: 'com.example.myapp',
  },
});
```

**FCM (Android):**
```ts
const mw = await MeshWhisper.init({
  namespace: 'com.example.app',
  push: {
    platform: 'fcm',
    token: fcmToken,
  },
});
```

---

## Storage backends

### `StorageBackend` interface

Implement this to use your own storage. Values are always JSON strings.

```ts
interface StorageBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;  // all keys starting with prefix
}
```

### `IDBStorage` (browser)

```ts
import { IDBStorage } from '@meshwhisper/sdk/browser';

const storage = new IDBStorage('com.example.myapp');  // namespace = IndexedDB database name
```

Auto-selected when `window` and `indexedDB` are present. The `namespace` argument namespaces the database so multiple apps on the same origin don't collide.

### `NodeStorage` (Node.js)

```ts
import { NodeStorage } from '@meshwhisper/sdk/node';

const storage = new NodeStorage('./data');
```

Filesystem key-value store. Files are written atomically (temp → rename) with `mode 0600`. The data directory is created if it doesn't exist.

### React Native

Wrap `AsyncStorage` or `SQLCipher`:

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { StorageBackend } from '@meshwhisper/sdk';

const rnStorage: StorageBackend = {
  get: (key) => AsyncStorage.getItem(key),
  set: (key, value) => AsyncStorage.setItem(key, value),
  delete: (key) => AsyncStorage.removeItem(key),
  keys: async (prefix) => {
    const all = await AsyncStorage.getAllKeys();
    return all.filter((k) => k.startsWith(prefix));
  },
};

const mw = await MeshWhisper.init({ namespace: 'com.example.app', storage: rnStorage });
```

---

## Groups

### `MeshWhisper.createGroup(options)`

```ts
const group = MeshWhisper.createGroup({
  name: 'Team Chat',
  members: [aliceId, bobId],
  permissionModel: 'open',
}): GroupHandle
```

### `GroupHandle`

```ts
group.id: string
group.name: string
group.members: string[]
await group.send(payload: Uint8Array): Promise<void>
group.addMember(peerId: string): void
group.removeMember(peerId: string): void
```

---

## Lifecycle

### `MeshWhisper.shutdown()`

Gracefully stops all transports, persists state, and clears the singleton.

```ts
await MeshWhisper.shutdown(): Promise<void>
```

Call before your app exits or before calling `init()` again.

---

## PWA service worker

Register the MeshWhisper service worker to handle push events when the app is closed:

```ts
// In your app
await navigator.serviceWorker.register('/meshwhisper-sw.js');

// Listen for wake events when the app is open
navigator.serviceWorker.addEventListener('message', (event) => {
  if (event.data?.type === 'meshwhisper:wake') {
    // Service worker woke us — reconnect if needed (SDK reconnects automatically)
  }
});
```

The service worker (`@meshwhisper/service-worker`) handles:
- **App open:** posts `meshwhisper:wake` to the active window — SDK reconnects and pulls queued messages
- **App closed:** shows a generic "New message" notification — user taps it, app opens, messages decrypt

Build and serve the service worker file:

```bash
cd node_modules/@meshwhisper/service-worker
npm run build
# Outputs dist/meshwhisper-sw.js — copy to your public/ directory
```

---

## Complete PWA example

```ts
import { MeshWhisper } from '@meshwhisper/sdk';

// Helper: convert VAPID public key for pushManager.subscribe
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const VAPID_PUBLIC_KEY = 'BExamplePublicKeyBase64url...';

async function startMessaging() {
  // Register service worker
  const registration = await navigator.serviceWorker.register('/meshwhisper-sw.js');

  // Subscribe to Web Push
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  });

  // Initialize SDK
  const mw = await MeshWhisper.init({
    namespace: 'com.example.myapp',
    node: 'wss://relay.myapp.com',
    push: {
      platform: 'webpush',
      subscription: subscription.toJSON() as WebPushSubscription,
    },
    onMessage: async (message) => {
      // Try media first
      const media = await MeshWhisper.downloadMedia(message);
      if (media) {
        displayMedia(media);
        await MeshWhisper.markRead(message.id, message.senderId);
        return;
      }

      // Plain text
      const text = new TextDecoder().decode(new Uint8Array(message.payload));
      displayMessage({ from: message.senderId, text, id: message.id });
      await MeshWhisper.markRead(message.id, message.senderId);
    },
    onMessageStatus: (messageId, status) => {
      updateMessageStatus(messageId, status); // update UI tick marks
    },
    onPresence: (peerId, status) => {
      updatePresenceIndicator(peerId, status);
    },
  });

  console.log('My peer ID:', mw.getLocalPeerId());
  return mw;
}
```
