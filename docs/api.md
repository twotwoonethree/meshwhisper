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
  messageRetention?: 'unbounded' | { kind: 'count'; max: number } | { kind: 'ageMs'; max: number };
  onMessage?: (message: Message) => void;
  onPresence?: (peerId: string, status: PresenceStatus) => void;
  onMessageStatus?: (messageId: string, status: MessageStatus) => void;
  onTyping?: (peerId: string, isTyping: boolean) => void;
  onContactRequest?: (peerId: string, introducedBy: string, username?: string) => void | Promise<void>;
  onGroupInvite?: (groupId: string, groupName: string, invitedBy: string, members: string[]) => void | Promise<void>;
  onArchiveDirty?: (reason: 'tombstone' | 'revival') => void;
  onHistoryRequest?: (peerId: string) => boolean | Promise<boolean>;
  onHistoryRestored?: (peerId: string, count: number) => void;
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
| `username` | No | — | Human-readable username registered with the relay alongside your pre-key bundle. Other users can add you with `addContactByKey('@alice')` instead of a raw public key. Usernames are scoped to the namespace; ownership semantics are governed by the namespace's `usernamePolicy` (default `'signed-transfer'` — username is sticky to whichever key first claimed it; takeover requires a signed transfer token). See [Namespace policy](#namespace-policy) and [Username transfer](#username-transfer). |
| `developerKey` | No | random | Base64-encoded developer public key. Tie to a stable key in production so sessions survive app updates. |
| `permissionModel` | No | `"open"` | Who can send messages. `"open"` = anyone. `"mutual"` = only existing contacts. |
| `push` | No | — | Push notification configuration. Required for offline delivery. See [`PushConfig`](#pushconfig). |
| `storage` | No | auto | Storage backend. Auto-selected in browser (IDBStorage) and Node.js (null). Pass explicitly to override. See [`StorageBackend`](#storagebackend). |
| `messageRetention` | No | `'unbounded'` | Per-conversation history cap. `'unbounded'` keeps everything (default, suitable for customer-service / compliance). `{ kind: 'count', max }` keeps the N most recent. `{ kind: 'ageMs', max }` drops messages older than `max` ms. Eviction runs on write and at boot. |
| `onMessage` | No | — | Called when a message is received. |
| `onPresence` | No | — | Called when a peer's online status changes. |
| `onMessageStatus` | No | — | Called when an outbound message's delivery status changes (`sent` → `delivered` → `read`). |
| `onTyping` | No | — | Called when a peer starts or stops typing. `isTyping` is `true` for start, `false` for stop. Ephemeral — not stored or reliable. |
| `onContactRequest` | No | — | Called when a new peer wants to talk to you. Fires in two cases: (1) a mutual contact introduces a new peer (`introducedBy` is the introducer's peer ID, `username` may be set); (2) a stranger initiates a direct handshake (`introducedBy === peerId`, `username` may be undefined until the peer's app sends a follow-up identifying themselves). Call `addContactByKey(peerId)` from this handler to confirm the contact, or ignore it to decline. |
| `onGroupInvite` | No | — | Called when another peer invites you to a group. Call `acceptGroupInvite(groupId)` to accept. |
| `onGroupRenamed` | No | — | Fires on remaining members when the admin (or any member of an adminless group) renames a group. The local group's `name` field has already been updated by the time this fires — refresh whichever UI surface shows the group title. |
| `onReactionUpdated` | No | — | Fires on the receiver side after a peer's emoji reaction has been applied to the local stored message. `peerId` is the reactor (NOT the message sender); `added` is true on add, false on remove. Re-render the affected message bubble. |
| `onDisappearingMessagesChanged` | No | — | Fires when a peer changes the disappearing-messages TTL on a conversation. The local policy has already been updated by the time this fires; subsequent sends auto-apply the new TTL. App should surface a system message ("Disappearing messages set to 7 days" / "off") in the timeline. |
| `onArchiveDirty` | No | — | Called whenever the SDK writes a tombstone (delete) or revival (re-add) event that must reach the relay before the next reload. The app should push the archive immediately (bypass any debounce). Apps that don't provide this still work, but stale relay state can resurrect deleted peers on the next pull until a normal push fires. |
| `onHistoryRequest` | No | refuse | Called when a peer asks for their conversation history to be replayed (typically after they accidentally deleted it). Return `true` to authorise the share, `false` to refuse. Default behaviour without this callback is refuse silently. Apps usually prompt the user once per peer and cache the decision. |
| `onHistoryRestored` | No | — | Called after a peer has replayed history into local storage. `count` is the number of new messages persisted after dedup. Reload the conversation view in response. |
| `onDeviceLinked` | No | — | Fires on a secondary device after a primary device accepts its link offer (Model-3 multi-device). `accountPeerId` is the X25519 peerId of the account this device has now joined; `contactCount` is how many contact accounts were imported in the bootstrap payload. Apps should leave their "showing QR / waiting" screen on this signal. See [Multi-device](#multi-device). |

---

## Messaging

### `MeshWhisper.send(recipientId, payload, options?)`

Send an encrypted message. Initiates X3DH key exchange automatically on first contact.

`SendOptions.replyTo` lets a send be marked as a quoted reply to an earlier message:

```ts
await MeshWhisper.send(peerId, encoder.encode('thanks!'), {
  replyTo: {
    messageId: 'original-message-id',
    snippetText: 'Did you see the doc I sent?',   // preview the receiver can render
  },
});
```

The `replyTo` is carried in the envelope and persisted on `StoredMessage.replyTo` on both sender and receiver. UIs render the snippet inline (typically as a small grey block above the reply body) and use `messageId` to scroll to the original on tap. The original doesn't need to still be visible — the snippet is the cached preview.

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

### `MeshWhisper.forwardMessage(fromConversationId, messageId, toRecipientId, options?)`

Forward an existing message to another recipient. Looks up the message in `fromConversationId`, sends its payload to `toRecipientId` with `forwardedFrom` set to the original sender's peerId. The receiver sees the message as if from you (`senderId` is your local peer) but with `forwardedFrom` indicating the original author — UIs typically render a small "Forwarded" label.

```ts
const originalAuthor: string | null = await MeshWhisper.forwardMessage(
  fromConversationId: string,
  messageId: string,
  toRecipientId: string,
  options?: SendOptions,
)
```

Returns the original author's peerId on success, or `null` if the source message can't be found locally.

**Chain preservation:** if the source message was itself forwarded, the new copy's `forwardedFrom` points at the ORIGINAL author, not the prior forwarder. Matches WhatsApp/Signal conventions and prevents misleading attribution.

**Provenance:** the SDK does NOT verify the `forwardedFrom` claim cryptographically — the forwarder has the plaintext anyway, so anything stronger has to come from app-level signing. If you need cryptographic chain-of-custody, build a signing layer on top.

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

Mark an inbound DM message as read. Persists the `'read'` status locally **and** sends a read receipt to the sender.

```ts
await MeshWhisper.markRead(messageId: string, peerId: string): Promise<void>
```

Triggers `onMessageStatus` on the sender's device with `status: 'read'`.

### `MeshWhisper.markReadLocal(messageId, conversationId)`

Persists `'read'` status locally **without** sending a receipt to the sender. Use for group messages (where the SDK has no single peer to receipt to) or any case where you want the unread badge to clear on reload without notifying anyone.

```ts
await MeshWhisper.markReadLocal(messageId: string, conversationId: string): Promise<void>
```

Without this, `getConversations()` recomputes `unreadCount` from `messages/*` with `status !== 'read'` on every boot — so the unread badge resurfaces after a reload unless one of `markRead` or `markReadLocal` has persisted the read status to storage.

### `onMessageStatus` (config callback)

Called when an outbound message's delivery status changes.

```ts
onMessageStatus: (messageId: string, status: 'sent' | 'delivered' | 'read' | 'failed') => void
```

Status flow: `sending` → `sent` → `delivered` (automatic on decrypt by recipient) → `read` (on `markRead()` call).

### `MeshWhisper.toggleReaction(conversationId, messageId, emoji)`

Toggle the local user's reaction on a message. If they already reacted with this emoji, the reaction is removed; otherwise it's added. Updates local storage first, then sends a `__mw_ctrl: 'reaction'` control message to the peer so their stored copy gets the same change.

```ts
const outcome: 'added' | 'removed' | 'noop' = await MeshWhisper.toggleReaction(
  conversationId: string,
  messageId: string,
  emoji: string,
)
```

- `conversationId` is the peer ID for DMs. Group reactions follow the same shape (each member would receive the control) but aren't implemented in v1 — restrict UI to DM conversations until the group fan-out path lands.
- `emoji` is the caller's choice. The SDK treats it as an opaque string and does no validation; UIs typically constrain to a small picker.
- `outcome === 'noop'` means the message wasn't found locally, OR the reaction was already in the requested state.

Persisted shape on `StoredMessage`: `reactions?: Record<string, string[]>` (emoji → peerIds who currently react). The map is normalised on every write — empty arrays are pruned, so a reader can treat an absent emoji and an empty array identically.

### `MeshWhisper.setDisappearingMessages(conversationId, ttlMs)`

Set (or clear) the disappearing-messages policy for a conversation. Every subsequent send in that conversation auto-receives `expiry: ttlMs / 1000` so both the sender's and recipient's stored copies expire at the same time. Pass `null` to disable.

```ts
await MeshWhisper.setDisappearingMessages(
  conversationId: string,
  ttlMs: number | null,
): Promise<void>
```

Broadcasts a `__mw_ctrl: 'disappearing_messages'` control to the peer so their side applies the same default on their outbound sends, and `onDisappearingMessagesChanged` fires on their side after the local state updates. Persisted across restarts under the `disappearing_messages` storage key.

An explicit `options.expiry` on a `sendMessage` / `sendMedia` call always wins over the conversation-level policy — apps can still override per-message.

`conversationId` is the peer ID for DMs. Group support is deferred (would need control fan-out to every member).

### `MeshWhisper.getDisappearingMessages(conversationId)`

Returns the current TTL in milliseconds, or `null` if no policy is set.

```ts
const ttlMs: number | null = MeshWhisper.getDisappearingMessages(conversationId)
```

### `onDisappearingMessagesChanged` (config callback)

Fires when a peer changes the disappearing-messages policy on a conversation. The local per-conversation policy has already been updated by the time this fires; subsequent sends in that conversation will auto-apply the new TTL. Apps should surface a system message ("Disappearing messages set to 7 days" / "off") in the conversation timeline.

```ts
onDisappearingMessagesChanged: (
  conversationId: string,
  ttlMs: number | null,   // null = peer disabled the policy
  changedBy: string,       // the peer that issued the change
) => void
```

### `onReactionUpdated` (config callback)

Fires on the receiver side after a peer's reaction has been applied to the local stored message.

```ts
onReactionUpdated: (
  conversationId: string,
  messageId: string,
  peerId: string,
  emoji: string,
  added: boolean,
) => void
```

`peerId` is the reactor — NOT necessarily the message's sender. `added` is true on add, false on remove. The application should re-render the affected message bubble.

---

## Conversation export

Use this to ship "Export chat" features, compliance archives, or to migrate history out of MeshWhisper.

### `MeshWhisper.exportConversation(peerId, options?)`

Export one conversation as a string. Default format is pretty-printed JSON; pass `format: 'text'` for a WhatsApp-style transcript.

```ts
await MeshWhisper.exportConversation(
  peerId: string,
  options?: ExportConversationOptions,
): Promise<string>
```

```ts
interface ExportConversationOptions {
  format?: 'json' | 'text';
  /** Drop messages by predicate (e.g. filter out app-level control envelopes). */
  filter?: (m: StoredMessage) => boolean;
  /** peerId → display name, for the `'text'` format. Falls back to `peerId.slice(0,8)`. */
  displayName?: Record<string, string>;
  /** Custom renderer for a single message in the `'text'` format. */
  textFormatter?: (m: StoredMessage, nameFor: (peerId: string) => string) => string;
}
```

**Example — WhatsApp-style transcript:**
```ts
const transcript = await MeshWhisper.exportConversation(bobId, {
  format: 'text',
  displayName: { [bobId]: 'bob', [meId]: 'me' },
});
// [2026-05-24 14:30] @bob: Hello!
// [2026-05-24 14:31] @me: Hi back
```

### `MeshWhisper.exportAllConversations(options?)`

Export every conversation. Returns a `Record<peerId, exportedString>` with each value formatted per the supplied options.

```ts
await MeshWhisper.exportAllConversations(
  options?: ExportConversationOptions,
): Promise<Record<string, string>>
```

---

## History recovery

If a user accidentally deletes a conversation, the messages are gone from their archive (the post-delete push overwrites the relay's copy). But the peer on the other side still has the conversation in their archive. History recovery lets the deleter ask the peer to replay it back.

### `MeshWhisper.requestHistory(peerId)`

Ask a peer to replay their view of your conversation. Sends a `request_history` control message; the peer's app gates on its `onHistoryRequest` callback. If they accept, the messages stream back as chunked control messages, dedupe by id, and persist locally. The requester's `onHistoryRestored` fires when the replay completes.

```ts
await MeshWhisper.requestHistory(peerId: string): Promise<void>
```

**Auto-fire on revival-after-delete:** the SDK automatically calls this internally when it detects a re-add of a peer that had a prior tombstone (the "I accidentally deleted them" path). Manual invocation is for explicit "restore history" UI buttons (Prudence has one) or for fresh-device scenarios.

### `onHistoryRequest` (config callback)

Called when a peer requests history. Return `true` to authorise the share, `false` to refuse. Without this callback, refuse silently is the default.

```ts
onHistoryRequest: (peerId: string) => boolean | Promise<boolean>
```

Apps typically prompt the user once per peer and cache the decision (Prudence stores `prudence:share-history-consent:{peerId}` in localStorage with `'yes' | 'no'`). Cached `'no'` answers prevent a malicious peer from spamming requests.

**Trust model:** the requester is an established peer with whom you share a ratchet session, and they were a participant in the original conversation — so they're not learning anything new about it. The relay still sees only ciphertext throughout the replay.

### `onHistoryRestored` (config callback)

Called after a peer's history has been replayed and merged into local storage.

```ts
onHistoryRestored: (peerId: string, count: number) => void
```

`count` is the number of messages actually persisted after dedup (0 if everything was already present). Reload the conversation view in response so the recovered messages appear in your UI.

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

## Identifier management

Helpers for working with the human-readable identifier (the `username` you registered at init). See [identifier-patterns.md](identifier-patterns.md) for the six common patterns (handle / phone / email / opaque / peerId-only / hybrid) and which one fits which kind of app.

### `MeshWhisper.checkIdentifierAvailable(identifier)`

```ts
const available: boolean = await MeshWhisper.checkIdentifierAvailable('alice');
```

Returns `true` if no other identity currently holds this identifier in your namespace (or if you already hold it). Point-in-time check — two clients can both observe `available` and race to claim. Treat as a hint; handle the race at the call site (`setIdentifier` will throw if it loses the race under signed-transfer policy).

### `MeshWhisper.setIdentifier(identifier)`

```ts
await MeshWhisper.setIdentifier('alice2');
```

Republishes your prekey bundle under a new identifier. Your cryptographic identity (peerId, sessions, contacts) is unchanged — only the directory entry moves. Under the default `signed-transfer` policy, throws if the identifier is held by a different identity in your namespace.

### `MeshWhisper.resolveUsername(peerId)`

```ts
const username: string | undefined = await MeshWhisper.resolveUsername(peerId);
```

Looks up a peer's registered identifier from the relay directory. Returns `undefined` if the peer hasn't registered one or the directory lookup fails. Useful for backfilling display names when an app-level handshake message that originally carried the username never arrived.

---

## Namespace policy

A namespace-wide rule for what happens when a *different* key tries to register a username that's already claimed. Set once, early; the first call locks the policy in.

### `MeshWhisper.setNamespacePolicy(usernamePolicy)`

```ts
await MeshWhisper.setNamespacePolicy('signed-transfer'); // default for new namespaces
// or
await MeshWhisper.setNamespacePolicy('last-writer-wins'); // opt-in for password-derived flows
```

- **`'signed-transfer'`** (default): takeover rejected with HTTP 409 unless the request includes a transfer token signed by the current owner (see [Username transfer](#username-transfer)). Re-publishing from the SAME key always succeeds.
- **`'last-writer-wins'`**: takeover is permitted and silently displaces the prior owner. Suits apps whose identity model re-derives the same key from credentials (so re-claiming is the recovery story).

Sticky — re-setting with the same value is a no-op; re-setting with a different value throws.

### `MeshWhisper.getNamespacePolicy()`

```ts
const policy: 'signed-transfer' | 'last-writer-wins' = await MeshWhisper.getNamespacePolicy();
```

Returns the effective policy. Defaults to `'signed-transfer'` if no policy row has been written for this namespace.

---

## Username transfer

Under the `signed-transfer` policy, a username is sticky to whichever key first claimed it. To move it to a new key (key rotation, device migration, gifting a handle), the current owner mints a signed transfer token bound to the recipient's key + an expiry. See [identifier-patterns.md](identifier-patterns.md#signed-transfer) for the security properties.

### `MeshWhisper.createUsernameTransferToken(opts)`

```ts
const token: UsernameTransferToken = await MeshWhisper.createUsernameTransferToken({
  username: 'alice',
  toPublicKey: '<recipient ed25519 hex>',
  expiresInMs: 60 * 60 * 1000, // optional; default 24h
});
// token is a plain JSON object — share via QR, paste, deep link, message.
```

Signed with this device's Ed25519 identity key. The relay accepts the resulting handover only if this device is the current owner of `username`.

### `MeshWhisper.acceptUsernameTransfer(token)`

```ts
await MeshWhisper.acceptUsernameTransfer(token);
```

Republishes this device's prekey bundle under `token.username` with the signed token attached. Throws if the token is for a different recipient, namespace, has expired, or the relay rejects the signature.

---

## Multi-device

The Model-3 ("linked devices, distributed") flow from [multi-device.md](multi-device.md): each device has its own ratchet identity; the primary device signs membership announcements; sends fan out to all known devices of the recipient's account. See [`examples/linked-devices/`](../examples/linked-devices/) for a working reference app.

### `MeshWhisper.getAccountForDevice(deviceKey)`

```ts
const accountKey: string | null = MeshWhisper.getAccountForDevice(deviceKey);
```

Returns the account-level peerId that owns this device, or `null` if the device isn't a known contact. For single-device contacts, `accountKey === deviceKey`.

### `MeshWhisper.getDevicesForAccount(accountKey)`

```ts
const devices: string[] = MeshWhisper.getDevicesForAccount(accountKey);
```

Returns every device peerId currently linked to the account. `sendMessage` fans out to all of them automatically; this helper exists for app-level introspection.

### `MeshWhisper.getContactAccounts()`

```ts
const accounts: string[] = MeshWhisper.getContactAccounts();
```

Account-level companion to `getContacts()` (which returns the flat device-key view for backwards compatibility). For single-device contacts the two lists have identical contents.

### `MeshWhisper.broadcastDeviceAdded(newDevicePeerId)`

```ts
await MeshWhisper.broadcastDeviceAdded(newDevicePeerId);
```

Announce that a new device belongs to this account. Signs a `device_added` control message with our Ed25519 identity key and fans it out to every contact. A session with `newDevicePeerId` must already exist (e.g. from `acceptDeviceLinkOffer` or `addContactByKey`).

### `MeshWhisper.broadcastDeviceRevoked(revokedDevicePeerId)`

Symmetric escape hatch. Recipients strip the device from their local view of this account.

### `MeshWhisper.verifyDeviceAnnouncement(kind, announcement)`

```ts
const ok: boolean = MeshWhisper.verifyDeviceAnnouncement('device_added', announcement);
```

Public Ed25519 signature verifier for `device_added` / `device_revoked` announcements. Useful for app-level logging or alternative storage. Trust binding (whether the sender peerId actually represents the account) is performed by the SDK's inbound handler — this helper only checks the cryptographic signature.

### `MeshWhisper.createDeviceLinkOffer(opts?)`

```ts
const offer: DeviceLinkOffer = await MeshWhisper.createDeviceLinkOffer({
  ttlMs: 5 * 60 * 1000, // optional; default 5 minutes
});
// Render as a QR / deep link / paste — the SDK doesn't pick a transport.
```

Secondary-device entry point. Mints a one-shot link offer (JSON-serialisable) carrying this device's Ed25519 hex, the namespace, a random challenge, and an expiry. The pending offer lives in-memory; reloading the app invalidates it.

### `MeshWhisper.acceptDeviceLinkOffer(offer)`

```ts
await MeshWhisper.acceptDeviceLinkOffer(offer);
```

Primary-device entry point. Looks up the secondary's prekey bundle at the relay, runs X3DH, mints a signed `device_added` announcement, sends a `device_linked` bootstrap payload (announcement + contact list) back over the new ratchet session, and broadcasts `device_added` to every other contact. The secondary's `onDeviceLinked` callback fires once the bootstrap arrives.

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

// Membership + admin
group.isAdmin(): boolean
group.isAdminless(): boolean
await group.addMember(peerId: string): Promise<void>     // admin or adminless
await group.kickMember(peerId: string): Promise<void>    // admin only
await group.transferAdmin(newAdminId: string): Promise<void>  // admin only; pass '' for adminless
await group.becomeAdminless(): Promise<void>              // sugar for transferAdmin('')
await group.rename(newName: string): Promise<void>        // admin only (or any member if adminless)
group.removeMember(peerId: string): void                  // local-only; no broadcast

// Lifecycle
await group.send(payload: Uint8Array): Promise<void>
await group.leave(): Promise<void>
```

Rename broadcasts a `group_rename` control message to every other current member; recipients fire `onGroupRenamed(groupId, newName, renamedBy)` after the local state is updated. Receivers silently drop a `group_rename` that doesn't come from the admin (or from a member of an adminless group), so a stray rename from a non-admin can't confuse your UI.

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
- Tombstones and revivals (see below) are merged per-peer with max-timestamp-wins; tombstoned peers are then suppressed from the merged contacts list and their archived keys are not installed.

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

### Tombstones and revivals

The archive's merge is additive — without an explicit signal, a peer deleted on one device would resurrect on the next pull. The SDK tracks two paired events to handle this cleanly:

- **`addTombstone(peerId)`** fires whenever you call `deleteConversation(peerId)`. Suppresses the peer's archived `messages/{peerId}`, `peers/{peerId}`, `edkeys/{peerId}` keys on merge, and filters them out of the merged `contacts` array.
- **`addRevival(peerId)`** fires whenever a peer is re-added (`acceptContact`, `addContactByKey`, inbound `x3dh_init`, `acceptGroupInvite`, `createGroup`). On merge, a peer is considered tombstoned **iff** `tombstone > revival` (max-timestamp per peer per event type, last event wins).

Both events fire the optional `onArchiveDirty` callback so apps can push the archive immediately rather than waiting on a debounce — critical because stale relay state would otherwise resurrect deletions or re-suppress revivals on the next pull. Apps that don't provide `onArchiveDirty` still work but lose the immediate-push property.

You don't call these directly — they're triggered automatically by the public API methods. The mechanism is documented here so multi-device delete/re-add behaviour is predictable.

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

### `AsyncStorageBackend` (React Native)

```ts
import { MeshWhisper, AsyncStorageBackend } from '@meshwhisper/sdk/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const NAMESPACE = 'com.yourapp';

const mw = await MeshWhisper.init({
  namespace: NAMESPACE,
  node: 'wss://relay.yourapp.com',
  storage: new AsyncStorageBackend(AsyncStorage, NAMESPACE),
});
```

The `@meshwhisper/sdk/react-native` entry re-exports the full SDK plus the `AsyncStorageBackend` adapter and a `ReactNativeTransport` alias (it's the same `BrowserTransport` — RN's WebSocket and fetch primitives are sufficient; no native module is required).

`AsyncStorageBackend` takes the AsyncStorage module as its first constructor argument rather than `import`ing it itself, so the SDK stays platform-agnostic and doesn't pull RN-only modules into other builds. Anything that implements the four methods `getItem`, `setItem`, `removeItem`, `getAllKeys` works — including mocks for testing. The second argument is a namespace prefix; the same string you pass as `MeshWhisper.init({ namespace })` is a sensible choice.

#### React Native gotchas

- **`crypto.getRandomValues`** is missing on older RN versions. Install [`react-native-get-random-values`](https://www.npmjs.com/package/react-native-get-random-values) and import it once at the top of your app's entry file before importing `@meshwhisper/sdk/react-native`. Modern Expo SDKs (≥ 48) and `react-native ≥ 0.72` ship this natively.
- **`TextEncoder` / `TextDecoder`** are available on Hermes ≥ 0.71. If you target older Hermes or JavaScriptCore, polyfill via [`fast-text-encoding`](https://www.npmjs.com/package/fast-text-encoding) at app startup.
- **Background WebSocket**. iOS aggressively suspends backgrounded apps; long-running WebSocket connections will drop. Use push notifications for offline delivery (see [`PushConfig`](#pushconfig)). For push on iOS, configure APNs in your push service.
- **Persistence size**. AsyncStorage stores everything as one blob per key. MeshWhisper's typical key shape is fine, but heavy media-message workloads may benefit from migrating to a SQLite-backed `StorageBackend` (e.g. `op-sqlite`, `expo-sqlite`); the `StorageBackend` interface is small enough that swapping implementations is straightforward.
- **`indexedDB` is absent**. The SDK won't auto-detect a usable storage backend in RN — passing `storage` explicitly is required.

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
