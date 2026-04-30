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
| React Native | `@meshwhisper/sdk/react-native` + custom `StorageBackend` |

---

## `MeshWhisper.init(config)`

Initializes the SDK. Must be called before any other method. Returns the instance (also accessible as `MeshWhisper.instance`).

```ts
const mw = await MeshWhisper.init(config: MeshWhisperConfig): Promise<MeshWhisper>
```

**Auto-detection behaviour:**
- In a browser (`window` + `indexedDB` present): uses `IDBStorage` and `BrowserTransport` automatically. No storage or transport configuration needed.
- In Node.js: uses `NodeTransport`. Storage is `null` unless you pass `storage: new NodeStorage(path)`.
- In React Native: uses the native WebSocket API via `BrowserTransport`. You must provide a `StorageBackend` explicitly (no IndexedDB).

### `MeshWhisperConfig`

```ts
interface MeshWhisperConfig {
  namespace: string;
  node?: string | string[];
  username?: string;
  developerKey?: string;
  permissionModel?: 'open' | 'mutual' | 'introduction' | 'transactional' | 'custom';
  push?: PushConfig;
  storage?: StorageBackend;
  onMessage?: (message: Message) => void;
  onPresence?: (peerId: string, status: PresenceStatus) => void;
  onMessageStatus?: (messageId: string, status: MessageStatus) => void;
  onTyping?: (peerId: string, isTyping: boolean) => void;
  onContactRequest?: (peerId: string, introducedBy: string, username?: string) => void | Promise<void>;
  onGroupInvite?: (groupId: string, groupName: string, invitedBy: string, members: string[]) => void | Promise<void>;
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
| `username` | No | — | Human-readable username registered with the relay alongside your pre-key bundle. Other users can add you with `addContactByKey('@alice')` instead of a raw public key. Usernames are scoped to the namespace; first-registered wins. |
| `developerKey` | No | random | Base64-encoded developer public key. Tie to a stable key in production so sessions survive app updates. |
| `permissionModel` | No | `"open"` | Who can send messages. `"open"` = anyone. `"mutual"` = only existing contacts. |
| `push` | No | — | Push notification configuration. Required for offline delivery. See [`PushConfig`](#pushconfig). |
| `storage` | No | auto | Storage backend. Auto-selected in browser (IDBStorage) and Node.js (null). Pass explicitly to override. See [`StorageBackend`](#storagebackend). |
| `onMessage` | No | — | Called when a message is received. |
| `onPresence` | No | — | Called when a peer's online status changes. |
| `onMessageStatus` | No | — | Called when an outbound message's delivery status changes (`sent` → `delivered` → `read`). |
| `onTyping` | No | — | Called when a peer starts or stops typing. `isTyping` is `true` for start, `false` for stop. Ephemeral — not stored or reliable. |
| `onContactRequest` | No | — | Called when a mutual contact introduces a new peer to you. Call `addContactByKey(peerId)` from this handler to accept. |
| `onGroupInvite` | No | — | Called when another peer invites you to a group. Call `acceptGroupInvite(groupId)` to accept. |

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
  { urgency: 'normal', expiry: 86400 },  // expires in 24 hours
);
```

### `MeshWhisper.sendTypingIndicator(peerId, isTyping)`

Send an ephemeral typing indicator to a peer. Not stored, not reliable.

```ts
MeshWhisper.sendTypingIndicator(peerId: string, isTyping: boolean): void
```

The recipient's `onTyping` callback fires with `isTyping: true` (start) or `isTyping: false` (stop).

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
  groupId?: string;          // set when the message was sent to a group
  groupSenderId?: string;    // original sender within the group
}
```

**Example:**
```ts
const mw = await MeshWhisper.init({
  namespace: 'com.example.app',
  onMessage: (message) => {
    const text = new TextDecoder().decode(new Uint8Array(message.payload));
    if (message.groupId) {
      console.log(`[group ${message.groupId}] ${message.groupSenderId}: ${text}`);
    } else {
      console.log(`[${message.senderId}]: ${text}`);
    }
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

### `MeshWhisper.getConversations()`

Returns all conversations, sorted by most recent message first.

```ts
const conversations = await MeshWhisper.getConversations(): Promise<Conversation[]>
```

```ts
interface Conversation {
  id: string;              // peer ID or group ID
  lastMessage?: StoredMessage;
  unreadCount: number;
}
```

### `MeshWhisper.deleteMessage(messageId, conversationId)`

Delete a stored message by ID.

```ts
await MeshWhisper.deleteMessage(messageId: string, conversationId: string): Promise<void>
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

### `MeshWhisper.addContactByKey(query)`

Add a contact by peer ID (hex public key) or `@username`. Fetches their pre-key bundle from the relay directory and initiates X3DH.

```ts
const ok = await MeshWhisper.addContactByKey(query: string): Promise<boolean>
```

Returns `true` if the contact was found and added, `false` if the username could not be resolved.

```ts
// By raw peer ID
await MeshWhisper.addContactByKey(bobId);

// By username (relay directory lookup)
await MeshWhisper.addContactByKey('@alice');
```

### `MeshWhisper.removeContact(peerId)`

Remove a contact. Clears the stored session and pre-key bundle for that peer.

```ts
await MeshWhisper.removeContact(peerId: string): Promise<void>
```

### `MeshWhisper.getContacts()`

Returns all contacts.

```ts
const contacts = MeshWhisper.getContacts(): string[]
```

### `MeshWhisper.introduceContacts(peerA, peerB)`

Introduce two of your contacts to each other. Both peers receive an `onContactRequest` callback with `introducedBy` set to your peer ID.

```ts
await MeshWhisper.introduceContacts(peerA: string, peerB: string): Promise<void>
```

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

## Groups

### `MeshWhisper.createGroup(options)`

Create a group and invite initial members. Each member receives an `onGroupInvite` callback.

```ts
const group = MeshWhisper.createGroup({
  name: 'Team Chat',
  members?: string[],          // peer IDs to invite immediately
  permissionModel?: 'open',
}): GroupHandle
```

### `MeshWhisper.getGroup(groupId)`

```ts
const group = MeshWhisper.getGroup(groupId: string): GroupHandle | null
```

### `MeshWhisper.getGroups()`

Returns all groups you are a member of.

```ts
const groups = MeshWhisper.getGroups(): GroupHandle[]
```

### `MeshWhisper.sendToGroup(groupId, payload)`

Send an encrypted message to all members of a group.

```ts
await MeshWhisper.sendToGroup(groupId: string, payload: Uint8Array): Promise<void>
```

### `MeshWhisper.acceptGroupInvite(groupId)`

Accept a pending group invitation received via `onGroupInvite`.

```ts
MeshWhisper.acceptGroupInvite(groupId: string): void
```

### `MeshWhisper.getPendingGroupInvites()`

Returns group invitations that have not yet been accepted or declined.

```ts
const invites = MeshWhisper.getPendingGroupInvites(): Array<{
  groupId: string;
  groupName: string;
  invitedBy: string;
  members: string[];
}>
```

### `GroupHandle`

```ts
group.id: string
group.name: string
group.members: string[]
await group.send(payload: Uint8Array): Promise<void>
group.addMember(peerId: string): void
group.removeMember(peerId: string): void
group.leave(): void
```

---

## Safety numbers

### `MeshWhisper.getSafetyNumber(peerId)`

Returns a 60-digit safety number for the conversation with `peerId`. Both parties compute the same number — compare out-of-band to verify no MITM.

```ts
const number = MeshWhisper.getSafetyNumber(peerId: string): string
// e.g. "12345 67890 12345 67890 12345 67890 12345 67890 12345 67890 12345 67890"
```

The number is derived from a sorted BLAKE3 hash of both parties' Ed25519 identity keys, formatted as 12 groups of 5 decimal digits. It is identical regardless of who calls it first.

### `MeshWhisper.verifySafetyNumber(peerId, candidate)`

Returns `true` if `candidate` matches the computed safety number for `peerId`.

```ts
const ok = MeshWhisper.verifySafetyNumber(peerId: string, candidate: string): boolean
```

---

## Backup & restore

MeshWhisper provides an encrypted archive of the user's contacts, message history, and peer state.
The archive lives on the same relay the user is already connected to — no third-party cloud is
involved. The archive key is derived from the user's identity key via HKDF, so the relay only ever
holds opaque ciphertext.

**What is included in the archive:**
- `contacts` — accepted peer IDs
- `peers/*` — peer public keys
- `messages/*` — full message history per conversation
- `seen_ids` — deduplication state
- `blocked` — blocked peer list

**What is excluded (intentionally):**
- `identity` — re-derivable from the user's password
- `sessions/*` — Double Ratchet state. Excluded for forward secrecy: a stolen archive must not be
  able to decrypt past or future traffic. Sessions rebuild automatically on next exchange.
- `prekeys/*`, `edkeys/*`, `opks/*`, `pq_*` — short-lived key material

The archive is a single AES-GCM blob keyed by the user's peer ID. The relay enforces write
authentication via SHA-256 of an HKDF-derived token (first writer claims the slot). Reads are
unauthenticated since the contents are encrypted.

### `MeshWhisper.deriveBackupKey(identityKeyBytes)` (static)

Derives the AES-GCM backup key from raw identity key bytes via HKDF. Useful if you want to encrypt
or decrypt archives outside an SDK instance.

```ts
const backupKey = await MeshWhisper.deriveBackupKey(identityKeyBytes: Uint8Array): Promise<Uint8Array>
```

### `mw.exportArchive(extra?)`

Encrypts and returns the archive blob as a `Uint8Array`. The relay is not contacted. Use for
device-to-device handoff, manual backup to user-controlled storage, or testing.

```ts
const blob = await mw.exportArchive(extra?: Record<string, unknown>): Promise<Uint8Array>
```

`extra` is an optional object stored alongside the encrypted KV map — useful for app-level state
the SDK doesn't manage (e.g. UI preferences, contact display names).

### `mw.importArchive(blob)`

Decrypts and **merges** an archive blob into local storage. Existing local data is preserved:
- `contacts`, `seen_ids`, `blocked` arrays are unioned.
- `messages/*` arrays are merged and deduplicated by message `id`, sorted by timestamp.
- `peers/*` are updated from the archive.

```ts
const { extra } = await mw.importArchive(blob: Uint8Array): Promise<{ extra?: Record<string, unknown> }>
```

Returns the `extra` object the archive was created with, if any.

### `mw.pushArchive(extra?)`

Encrypts and uploads the current archive to the relay. Throttle on the caller side — the SDK does
not debounce automatically.

```ts
await mw.pushArchive(extra?: Record<string, unknown>): Promise<void>
```

The archive endpoint is the same relay configured via `node` in `init()`. The maximum plaintext
size is 10 MB; oversized archives are skipped with a console warning rather than truncated.

### `mw.pullArchive()`

Downloads the archive from the relay and merges it into local storage. Returns `restored: false`
if no archive exists yet.

```ts
const { restored, extra } = await mw.pullArchive(): Promise<{ restored: boolean; extra?: Record<string, unknown> }>
```

Typical pattern: call `pullArchive()` on every app boot to pick up changes from other devices,
then `pushArchive()` after each significant state change (debounced 5–10 seconds in the calling app).

```ts
const mw = await MeshWhisper.init({ /* ... */ });
const { restored, extra } = await mw.pullArchive();
if (restored && extra?.uiPreferences) restoreUiPreferences(extra.uiPreferences);

// Later, after a message send:
debounce(() => mw.pushArchive({ uiPreferences }).catch(console.warn), 5_000);
```

### How this differs from other messengers

| Approach | Where backup lives | Who can see metadata | Recovery |
|---|---|---|---|
| **MeshWhisper** | The relay you already use | The relay sees an opaque blob keyed by an unidentified peer-ID hash. No account, no email, no phone number. | Username + password (re-derives identity key, then archive key) |
| **WhatsApp** | Google Drive / iCloud | Google or Apple knows you have a WhatsApp backup, when it was made, and how big it is | Phone number + (optional) end-to-end key |
| **Signal** | Local device or transfer to a paired device only | Nothing — but no off-device backup historically | Local backup file with passphrase |
| **iMessage** | iCloud | Apple holds keys (default) or user-held with Advanced Data Protection | Apple ID |
| **Matrix** | Homeserver-stored encrypted key backup | Your homeserver knows the backup exists, who owns it, and its timing | Security key or passphrase |

Two things stand out about MeshWhisper's approach:

1. **No third-party cloud.** Backup colocates with the relay you've already chosen to trust for
   real-time messages — there's nothing new to trust. If you self-host the relay, you also
   self-host the backup.
2. **No separate backup passphrase.** Identity key, archive key, and write-auth token are all
   derived from the same username + password input. Users don't have to remember a recovery code,
   write down a security key, or link their backup to a third-party account.

The trade-off is that recovery is gated on remembering the password — there's no "forgot password"
flow. By design.

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

Import from `@meshwhisper/sdk/react-native` and wrap `AsyncStorage` or `SQLCipher`:

```ts
import { MeshWhisper } from '@meshwhisper/sdk/react-native';
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

The React Native entry point re-exports the full SDK and automatically uses the native WebSocket API rather than the Node.js `ws` package.

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

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const VAPID_PUBLIC_KEY = 'BExamplePublicKeyBase64url...';

async function startMessaging() {
  const registration = await navigator.serviceWorker.register('/meshwhisper-sw.js');

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  });

  const mw = await MeshWhisper.init({
    namespace: 'com.example.myapp',
    node: 'wss://relay.myapp.com',
    username: 'alice',
    push: {
      platform: 'webpush',
      subscription: subscription.toJSON() as WebPushSubscription,
    },
    onMessage: async (message) => {
      const media = await MeshWhisper.downloadMedia(message);
      if (media) {
        displayMedia(media);
        await MeshWhisper.markRead(message.id, message.senderId);
        return;
      }
      const text = new TextDecoder().decode(new Uint8Array(message.payload));
      displayMessage({ from: message.senderId, text, id: message.id });
      await MeshWhisper.markRead(message.id, message.senderId);
    },
    onMessageStatus: (messageId, status) => {
      updateMessageStatus(messageId, status);
    },
    onPresence: (peerId, status) => {
      updatePresenceIndicator(peerId, status);
    },
    onTyping: (peerId, isTyping) => {
      updateTypingIndicator(peerId, isTyping);
    },
    onGroupInvite: async (groupId, groupName, invitedBy, members) => {
      const accepted = await showConfirmDialog(`${invitedBy} invited you to "${groupName}"`);
      if (accepted) MeshWhisper.acceptGroupInvite(groupId);
    },
    onContactRequest: async (peerId, introducedBy, username) => {
      const display = username ?? peerId.slice(0, 8);
      const accepted = await showConfirmDialog(`${introducedBy} wants to introduce you to ${display}`);
      if (accepted) await MeshWhisper.addContactByKey(peerId);
    },
  });

  console.log('My peer ID:', mw.getLocalPeerId());
  return mw;
}
```
