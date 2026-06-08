# Prudence as a MeshWhisper SDK reference

Prudence is the demo PWA for [`@meshwhisper/sdk`](../README.md). It is also intended to serve as a living example for app developers building on the SDK — a complete, working integration of the SDK's surface that you can read end-to-end.

This document maps SDK features to the Prudence files where they're exercised, and points out non-obvious patterns that aren't apparent from the SDK API alone.

If you're building on MeshWhisper, the recommended workflow is: skim the SDK README for the API shape, then come here for the "how do I actually wire this up?" answer.

## Project layout

| File | What it does |
|---|---|
| `src/main.tsx` | Entry point. Mounts `<App/>` and registers the service worker. |
| `src/App.tsx` | The whole app. Holds React state, owns the SDK init, wires every SDK callback to UI behaviour. **Start here.** |
| `src/sdk.ts` | Single-instance wrapper around `MeshWhisper.init()`. Shows the canonical init pattern with all callbacks plumbed in. |
| `src/storage.ts` | `StorageBackend` implementation over IndexedDB, keyed by username. The cleanest reference for writing your own backend. |
| `src/crypto.ts` | PBKDF2-based identity-key derivation from username + password. Use this pattern when you want a password to unlock the same identity across logins. |
| `src/push.ts` | Web-push (VAPID) subscription helpers. Mirrors the SDK's `push` init option shape. |
| `src/media.ts` | Image/file encryption + thumbnail helpers around `MeshWhisper.sendMedia` / `downloadMediaMessage`. |
| `src/notifications.ts` | In-foreground notification UX (when push wakes the SW but the page is open). |
| `src/group-storage.ts` | Persisting Prudence's app-side view of group rosters in localStorage. |
| `src/accepted-contacts.ts` | localStorage helpers for the "already handled this contact request?" check. |
| `src/contact-names.ts` | Display-name dictionary keyed by peerId. Lives in localStorage; included in the archive's `extra`. |
| `src/sw.ts` | Service worker. Handles incoming push messages and prompts the SW to surface a notification. |
| `src/components/*.tsx` | UI. `Thread`, `ConversationList`, `AddContact`, `CreateGroup`, `PendingRequests`, `GroupInviteModal`, `Login`, `Onboarding`. |

## SDK feature → where to look

### Init and storage backend
- `MeshWhisper.init(config)` — `sdk.ts:initSDK`. Note how every callback is plumbed; an app that omits any of these gets silent default behaviour for that area.
- `StorageBackend` interface — `storage.ts:idbStorage`. Implement the four methods (`get`, `set`, `delete`, `keys(prefix)`) and you can back the SDK with any KV store.

### Identity
- Password-derived identity — `crypto.ts:deriveIdentityKey` + `App.tsx:handleRegister/handleLogin`. The derived 32-byte seed is written to `idbStorage` under `'identity'`; the SDK reads that key on init and derives the X25519/Ed25519 keypair from it. Same password on a new device → same identity.

### Sending and receiving messages
- Send (DM) — `App.tsx:handleSend` → `sdk.sendMessage(peerId, payload)`.
- Send (group) — same function, routes via `sdk.sendToGroup(groupId, payload)`.
- Receive — `App.tsx:handleMessage` (the `onMessage` callback). Note the two early-return branches: app-level `__prudence_ctrl` messages and SDK-level media-pointer messages get unwrapped here before falling through to "normal chat message."
- Typing — `MeshWhisper.sendTyping(peerId)` / `stopTyping(peerId)`, received via the `onTyping` callback (`App.tsx:handleTyping`).
- Delivery / read receipts — `MeshWhisper.markRead(messageId, peerId)` (DM) and `MeshWhisper.markReadLocal(messageId, conversationId)` (group, persists status without sending a receipt). See `App.tsx:markConversationRead` for the helper that walks unread messages on conversation open.

### Contacts (X3DH)
- QR exchange — `MeshWhisper.generateContactQR()` shown in `Onboarding.tsx`; acceptance via `MeshWhisper.acceptContact(qrString)` in `App.tsx`.
- By peer ID — `MeshWhisper.addContactByKey(hex)` in `components/AddContact.tsx:handleConnect`. Note the follow-up `sdk.sendMessage(peerId, prudenceCtrl)` that ships the user's display name in an app-level control message — this is how Prudence avoids the relay learning usernames.
- Inbound first contact — surfaced via the `onContactRequest` callback (`App.tsx:handleContactRequest`). User accepts → `App.tsx:handleAcceptRequest` → `MeshWhisper.acceptContact`.
- Deletion — `App.tsx:handleRemoveContact` calls `sdk.deleteConversationInstance(peerId)`. The SDK writes a tombstone and fires `onArchiveDirty` automatically; Prudence doesn't need to do anything extra to make the deletion survive a reload.
- Display-name collision — `contact-names.ts:saveContactNameInteractive` is the wrapper to use when a contact is being actively added or accepted. It detects when a name would collide with an existing contact and prompts the user once ("There's already a contact called '@robby'. Enter a different name, or press Cancel to keep both as '@robby'."). Call sites: `App.tsx:handleAcceptRequest`, the post-accept directory backfill, and the `AddContact` `onContactAdded` callback. Background paths (group events, archive restore) still call the silent `saveContactName` since interrupting them with a prompt would be jarring.

### Groups
- Create — `App.tsx:handleCreateGroup`. `MeshWhisper.createGroup({ name, members })` returns a handle; you persist `senderKeys` and the member roster yourself (Prudence uses `group-storage.ts`).
- Restore on boot — `MeshWhisper.restoreGroup(...)` in the boot block of `App.tsx`. Required because group state lives in localStorage, not the SDK's IDB.
- Invite handling — `onGroupInvite` callback → `App.tsx:handleGroupInvite` → user accepts → `App.tsx:handleAcceptGroupInvite` → `MeshWhisper.acceptGroupInvite(groupId)`.
- Membership events — `onGroupMemberAdded/Left/Kicked/AdminChanged/KickedFromGroup`. Each maps to a Prudence handler that updates the local roster and adds a system message to the thread.

### Archive sync (multi-device + offline durability)
- Pull on boot — `App.tsx`, just after `initSDK` resolves: `await sdk.pullArchive()`. The returned `extra` is where app-side state (contact names, accepted set, group rosters) round-trips.
- Push, debounced — `App.tsx:scheduleArchiveSync`. Wraps `sdk.pushArchive(extra)` with a 5 s debounce and 30 s max-wait. Call this after non-critical state changes (new message arrived, typing toggled).
- Push, immediate — `App.tsx:forceArchiveSync`. Used for critical events where stale relay state would resurrect deleted peers or undo a re-add.
- `onArchiveDirty` wiring — `App.tsx`, in the `initSDK` config. The SDK fires this callback whenever it writes a tombstone or revival event; Prudence force-flushes immediately. This is the "right" pattern — apps shouldn't try to call `scheduleArchiveSync` themselves on contact mutations, because the SDK already does the right thing.
- Flush on close — `App.tsx`, the `useEffect` listening to `visibilitychange` and `pagehide`. Calls `flushArchiveSync(sdk, keepalive=true)` so the post-action archive lands even if the user closes the tab.

### Conversation export
- Per-conversation transcript download — `App.tsx:handleExportConversation` calls `sdk.exportConversationInstance(peerId, options)` with `format: 'text'`, a peerId → display-name map built from `contactNames` + group roster, and a filter that drops `__prudence_ctrl` envelopes. The returned string is wrapped in a Blob and triggered as a browser download.
- UI: the down-arrow icon in `Thread.tsx`'s header. Available for DMs and groups.
- Format alternatives — pass `format: 'json'` for structured output; pass a `textFormatter` to override the default `[YYYY-MM-DD HH:mm] @sender: payload` line shape.

### Conversation history recovery
- Manual fetch — `App.tsx:handleRestoreHistory` calls `sdk.requestHistoryInstance(peerId)`. Wired into the swirl button in `Thread.tsx`.
- Automatic on revival-after-delete — no Prudence code; the SDK auto-fires `request_history` whenever a tombstone preceded a revival.
- Recipient side — `App.tsx:handleHistoryRequest` (the `onHistoryRequest` callback). One-time `confirm()` per peer, decision cached in localStorage. Returning `true` authorises the share.
- Post-restore refresh — `App.tsx:handleHistoryRestored` reloads the conversation messages from the SDK. **Important**: filters out `__prudence_ctrl` messages with the same `isControlMessage` check the boot loader uses — restored history surfaces only real chat messages.

### Media (images and files)
- Upload — `App.tsx:handleAttach` → `MeshWhisper.sendMedia(conversationId, bytes, options)`. The SDK encrypts the blob, uploads to the node's media endpoint, and sends a media-pointer message through the normal ratchet channel.
- Download — `App.tsx:handleDownloadMedia` → `MeshWhisper.downloadMediaMessage(message)`. Returns decrypted bytes; Prudence wraps with object-URL creation for display.
- Thumbnail generation — `media.ts:generateThumbnail`. The thumb is embedded in the media-pointer message so the recipient sees a preview before downloading the full asset.

### Connection status and presence
- `onConnectionStatus` — `App.tsx:handleConnectionStatus`. Drives the connectivity indicator in the UI.
- `MeshWhisper.pull()` on visibility — `App.tsx`, in the boot effect: when the tab returns to visible, calls `getSDK()?.pullInstance()` to fetch any messages queued at the relay while the tab was hidden. Mirror this in any backgrounding-prone client.

### Push notifications (PWA / Web Push)
- Subscription — `push.ts:getPushSubscription`. Reads the VAPID public key from build env, asks the SW to subscribe, returns the `WebPushSubscription` shape the SDK expects.
- Wiring — `App.tsx`, the `push` field on `MeshWhisper.init`. The SDK uploads the subscription to the node as part of its handshake; the node fires content-free push wake signals when an inbound message arrives for a hash this device subscribed to.
- Service worker — `sw.ts`. Receives the push event, calls `clients.matchAll` to decide whether the page is already foregrounded (skip notification) or backgrounded (show one).

### SDK features NOT exercised here

A few SDK surfaces don't appear in Prudence because they don't fit its identity / UX model. They exist in the SDK and have their own reference codebase:

- **Linked-devices multi-device (Model 3)** — `MeshWhisper.createDeviceLinkOffer` / `acceptDeviceLinkOffer` / `onDeviceLinked` + `broadcastDeviceAdded` / `broadcastDeviceRevoked` + sendMessage fan-out. Prudence uses Model 1 (same identity on every device via password derivation); Model 3 needs each device to have its own random key and a QR pairing flow to bootstrap a new device into an account. See [`examples/linked-devices/`](../examples/linked-devices/) for the focused reference and [`docs/multi-device.md`](../docs/multi-device.md) for the design.
- **Per-namespace username policy + signed username transfer** — `MeshWhisper.setNamespacePolicy` / `createUsernameTransferToken` / `acceptUsernameTransfer`. Prudence registers a username at init and never reassigns it, so the helpers aren't exercised, but they're available in the SDK if your app needs handle migration. See [`docs/identifier-patterns.md`](../docs/identifier-patterns.md).
- **Identifier change at runtime** — `MeshWhisper.setIdentifier` / `checkIdentifierAvailable`. Prudence binds the username to the password-derived identity at registration and never changes it; apps with a "change handle" UX would use these.

## Non-obvious patterns

A few things that aren't in the SDK API but matter when integrating:

1. **`__mw_ctrl` vs `__prudence_ctrl`**. The SDK consumes `__mw_ctrl`-prefixed messages itself (delivery receipts, typing, group control, handshake activation). App-level signaling — like Prudence sending its display name during a contact request — uses a separate `__prudence_ctrl` prefix and rides as a normal data message. **Any code that reads `messages/{peerId}` and renders it must filter these out**, or the user sees handshake admin chatter as chat bubbles. Prudence's `isControlMessage` check at the top of `App.tsx` handles this.

2. **Default storage backend caps history at 500 messages per conversation**. See `MAX_STORED_MESSAGES` in the SDK's `src/sdk/message-handler.ts`. Apps that want WhatsApp-style "keep everything locally" should either implement their own `StorageBackend` (mirroring writes to another store) or fork the cap. The 500-cap is a privacy/storage tradeoff that suits demo apps; production apps may want different.

3. **The SDK is a process-level singleton**. `MeshWhisper.init()` shuts down any previous instance — useful for tests that swap identities, but means an app can only represent one user at a time. Multi-account support requires running the SDK in a separate worker or process per identity.

4. **Tombstones/revivals are SDK-owned now**. Earlier iterations of Prudence had to remember to call `scheduleArchiveSync` after every contact mutation. After three near-identical bugs caused by forgetting that call, the SDK now fires `onArchiveDirty` itself whenever it writes a tombstone or revival, and Prudence's handler force-pushes. If you're tempted to call `scheduleArchiveSync` after `deleteConversation` / `acceptContact` — don't, the SDK has you covered.

5. **Identity persistence is your responsibility**. The SDK reads the `identity` key from your storage backend on init; if it's not there, the SDK generates a new identity. Prudence derives this key from username + password so the same credentials produce the same identity (`crypto.ts:deriveIdentityKey`). A different app might pull from the OS keychain, or generate-and-store-once. Pick what fits your threat model.

## Reading order for a new SDK consumer

If you have an hour and want to learn the SDK by reading Prudence:

1. **`prudence/src/sdk.ts`** — the `initSDK` function shows the full set of callbacks an app should provide and roughly groups them by feature.
2. **`prudence/src/App.tsx`** — read top-to-bottom but skim the JSX. The handlers near the top (`handleMessage`, `handleTyping`, `handleContactRequest`) cover the receive path; the named functions further down (`handleSend`, `handleRemoveContact`, `handleAcceptGroupInvite`) cover the send / mutation paths.
3. **`prudence/src/storage.ts`** — the smallest interesting file; shows that the backend contract is just a typed KV store.
4. **Memory-jog with the SDK's [README](../README.md)** for any feature whose Prudence call site felt under-explained.

If something is missing or out of date, please open an issue on the repository — the value of a reference codebase depends on this doc staying accurate as the code evolves.
