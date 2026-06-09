# Multi-Device Strategy

The cryptographic identity is independent of any one device: depending on the app's identity pattern (see [identity-patterns.md](identity-patterns.md)), a key can be re-derived deterministically from credentials (password / passkey / OS keychain) or, for opaque-key flows, transferred between devices via an out-of-band hand-off. The interesting question is what happens when **the same identity (and therefore the same `peerId`) is active on more than one device** — how messages route, how state stays consistent, and how the relay/SDK treat the duplication.

Three options are documented here in increasing order of implementation complexity. They're not mutually exclusive — Option 1 is a natural prerequisite for the simultaneous-active case in Option 3, and a product can ship one then layer the next on top.

---

## What's already in place (and what isn't)

Several primitives already exist that any multi-device implementation will sit on top of. Worth being explicit so you don't reinvent them:

- **Archive sync** (`src/sdk/archive.ts`, per-identity encrypted blob on the relay) — the durable backbone for Option 1's hand-off. Includes tombstone + revival LWW semantics so deletes survive a device handover cleanly, and `onArchiveDirty` fires whenever membership state changes so the SDK owns the push.
- **Peer-to-peer history recovery** (`request_history` / `history_replay` control messages) — when a device with no local message store establishes a session with a contact who has prior history, it can ask the contact to replay. Gated by per-contact consent on the recipient side; auto-fires on revival-after-tombstone. Materially shrinks Option 3's per-device sync problem: new devices don't need an account-level message log, they re-acquire history from contacts on first contact.
- **Cluster / availability module** (`src/cluster/index.ts`, ~482 lines, partial) — implements **a different concern**: device scoring and primary-receiver election across a user's devices over LAN/local-p2p, so the "most capable" device acts as the gateway. Orthogonal to identity-level multi-device; would complement either Option 1 or Option 3 once they exist but does not implement them.
- **Signed-transfer username handover** (relay + SDK, stage 2) — moves the *directory entry* from one key to another with the current owner's Ed25519 signature. Explicitly NOT a session/contact/archive transfer. Useful if a user's multi-device flow needs the new device to inherit the *handle*, but it doesn't help with message delivery or history.

None of these three options is implemented as a coherent multi-device feature today. The plan below tells you what would still need building.

---

## Option 1: Hand-off (recommended starting point)

One device is **active** at a time. When a second device connects with the same peer ID, it becomes
active and the first becomes **dormant**. The archive is the sync backbone: a dormant device wakes
up, pulls the archive, picks up everything that happened while it slept, then becomes active again.

### How it works

1. Device B connects to the relay with the same peer ID as Device A.
2. Relay delivers future messages to Device B (last-connected wins). Sends a "superseded" control
   packet to Device A.
3. Device A receives the signal, immediately pushes its archive, and enters dormant mode — still
   connected but not processing incoming messages.
4. Device B pulls the archive, merges state, and resumes normally. Re-establishes sessions with
   contacts on first send (sessions from Device A are stale and discarded).
5. When the user returns to Device A, it pulls the archive, discards stale sessions, and becomes
   active again. Device B receives a superseded signal and goes dormant.

### Security properties

- Identity key and archive key are unchanged.
- No device list is stored anywhere — the relay only ever sees one active connection per peer ID.
- Sessions are per-device and ephemeral. Stale sessions are discarded on wake, not transferred.
- Compromising a dormant device yields no live session keys.
- One-message hiccup possible on wake if a contact sent to the dormant device's stale session;
  the existing reestablishment logic recovers automatically.

### What changes

| Layer | Change |
|---|---|
| Relay | Last-connected client wins delivery; send "superseded" packet to displaced client |
| SDK | Handle superseded signal: push archive, enter dormant mode |
| SDK | On reconnect: pull archive, discard stale sessions, resume |
| Prudence | "Connected on another device" banner; resume on tap / on foreground |

The archive-pull step uses the existing `downloadArchive` + tombstone/revival merge — no new sync protocol. The "discard stale sessions on wake" step also leans on the existing targeted-rehandshake-on-decrypt-failure logic added in the reconnect-robustness work, so the recovery path is already exercised.

**Estimated effort:** 2–3 days.

---

## Option 2: Hard boot on new sign-in

The simplest possible model. Signing in on a new device invalidates all other sessions. The old
device is disconnected and shown a "signed in elsewhere" screen. History is preserved via the
archive.

### How it works

1. Device B derives the same identity key and connects.
2. Relay disconnects any existing connection for that peer ID and notifies the displaced client.
3. Device B pulls the archive on boot, restoring full history.
4. Sessions re-establish on first send.

### Security properties

Same as hand-off, with the added property that there is provably never more than one active device
at any moment. Simplest to reason about.

### Limitations

No graceful return to a displaced device — the user must sign in again. Annoying if switching
between devices frequently.

### What changes

| Layer | Change |
|---|---|
| Relay | On duplicate peer ID connection: disconnect existing client, send "signed out" packet |
| SDK | Handle signed-out signal: clear sessions, show re-authentication UI |
| Prudence | "Signed in on another device" screen with re-login prompt |

**Estimated effort:** 1 day.

---

## Option 3: Linked devices (Signal-style, distributed variant)

True simultaneous multi-device. Each device has its own key pair and receives messages
independently. The sender encrypts a separate copy for each of the recipient's devices.

The key difference from Signal's implementation: **no relay stores the device list**. This fits
MeshWhisper's distributed relay model where no single relay is authoritative.

### How it works

**Identity split:**
- **Account key** — derived from username and password via PBKDF2. Used only to sign device
  announcements. Never used for message encryption.
- **Device key** — random, generated once per device, stored in local IDB. This is the actual X3DH
  and ratchet identity. Each device has a unique peer ID.

**Device discovery:**
- During contact exchange (QR scan), you share all your current device public keys alongside your
  account public key.
- Each contact stores your device list locally — no relay involved.
- When you add a device, your primary device sends a signed "device added" control message to all
  existing contacts. They update their local copy.
- When you revoke a device, a signed "device removed" control message is broadcast to contacts.

**Sending:**
- `sendMessage(recipientAccountId)` looks up all device IDs for that account in local contact state.
- Fetches a pre-key bundle for each device from whichever relay that device is registered on.
- Initiates X3DH and sends a separate encrypted copy to each device's dest hash.
- Each device decrypts independently.

**Relay role:**
- Stores pre-key bundles keyed by device ID — same as today, just more of them.
- Routes messages by dest hash — same as today.
- Has no concept of accounts, device lists, or which devices belong to the same user.

### Security properties

- Per-device forward secrecy: compromising one device does not affect other devices' sessions.
- Relay sees no account structure — from its perspective, each device is an independent peer.
  Devices belonging to the same user are not correlatable at the relay level.
- Device revocation is enforced by contacts (they stop encrypting for revoked device IDs).
- Account key is never transmitted to the relay and is only used for signing.

### Limitations

- New contacts only know your devices at QR exchange time. If you add a device after establishing a
  contact, that contact must be online to receive the "device added" message before they send to
  your new device.
- Senders must encrypt N copies per message (one per device). Minor bandwidth/compute increase.
- Significantly more implementation complexity than Options 1 and 2.

### What changes

| Layer | Change |
|---|---|
| SDK | Split identity into account key and device key |
| SDK | Session map: `(accountId, deviceId) → session` instead of `peerId → session` |
| SDK | `sendMessage`: fetch all device bundles, encrypt per device |
| SDK | "Device added/removed" signed control messages |
| SDK | Contact state: store device list per contact, update on control messages |
| Relay | No changes required |
| Prudence | Linked devices settings screen: view devices, add via QR, revoke |
| Prudence | Link device flow: show QR on primary, scan on secondary |

Existing primitives reduce the surface: history sync on a freshly-added device falls out of the [peer-to-peer history recovery](#whats-already-in-place-and-what-isnt) protocol (no separate per-device message log replication needed), and the signed-control-message envelope reuses the same Ed25519 signing path used by the signed-transfer wire format and reputation proofs.

**Estimated effort:** 2 weeks (was 2–3 — history-recovery handles per-device catch-up, removing the largest sub-task).

### Status: shipped (phases A–C v1 + QR pairing v1)

The phased build of Option 3 has shipped through QR pairing. Working API today:

```ts
// ---------- Secondary device (e.g. user installing the app on a laptop) ----------

await MeshWhisper.init({
  namespace: 'com.yourapp',
  // The secondary uses its OWN random keypair (developerKey override or
  // generated on first init). It is NOT signing in with credentials.
  storage,
  onDeviceLinked: (accountPeerId, contactCount) => {
    // The primary accepted the link. We're now a device of accountPeerId.
    // contactCount tells you how many contacts were imported.
    navigateToMainApp();
  },
});

const offer = await MeshWhisper.createDeviceLinkOffer({ ttlMs: 5 * 60_000 });
// offer is a plain JSON object — render it as a QR, deep link, or
// copyable code. The SDK doesn't pick the rendering for you.
showQR(JSON.stringify(offer));

// ---------- Primary device (the user's existing account) ----------

const scanned = await scanQRCode();              // your QR library
const offer: DeviceLinkOffer = JSON.parse(scanned);

await MeshWhisper.acceptDeviceLinkOffer(offer);
// Behind the scenes: looks up the secondary's prekey bundle at the relay,
// completes X3DH, mints a signed `device_added` announcement, sends the
// `device_linked` bootstrap payload (containing your contact list and
// the announcement) back to the secondary over the new ratchet session,
// and broadcasts `device_added` to every other contact so their local
// routing tables learn about your new device.
```

The protocol's signed wire format and trust binding:

- Secondary's offer carries: its Ed25519 hex (so primary can look up its prekey bundle), the namespace, a base64 challenge nonce, an expiry.
- Primary's `device_added` announcement is Ed25519-signed over `meshwhisper.device-added.v1\n{accountEdKey}\n{deviceEdKey}\n{addedAt}` and broadcast.
- Secondary verifies the signature, confirms the announcement names *its* deviceKey, derives the primary's X25519 peerId, and accepts only if the sender peerId of the inbound matches.

`MeshWhisper.broadcastDeviceRevoked(devicePeerId)` is the symmetric escape hatch — same signature shape, recipients strip the deviceKey from their local view.

### What's NOT in QR pairing v1

- ~~Persistent LWW timestamps for device announcements~~ — **shipped**. The replay-protection map (`deviceAnnouncementSeen`) is now persisted to `device_announcement_seen` in storage on every apply, and rehydrated on `loadPersistedState`. A fresh device boot inherits the same historical protection as the prior session.
- **Per-device signing certificates** — only the primary (the device whose `peerId === accountKey`) can broadcast announcements today. Secondary devices can't independently revoke. Phase B v2.
- **A reference Prudence UI** — Prudence uses Option 1 (same identity everywhere via password-derived keys) and isn't a good demonstration of Option 3. See [`examples/linked-devices/`](../examples/linked-devices/) for a focused tiny app.

---

## Comparison

| | Hand-off | Hard boot | Linked devices |
|---|---|---|---|
| Simultaneous active devices | 1 | 1 | Unlimited |
| History preserved on switch | ✓ (archive) | ✓ (archive) | ✓ (native) |
| Real-time delivery to all devices | — | — | ✓ |
| Device list on relay | None | None | None |
| Per-device forward secrecy | Partial | Partial | Full |
| Device revocation | Implicit (supersede) | Implicit (boot) | Explicit |
| Relay metadata increase | None | None | None |
| Implementation effort | 2–3 days | 1 day | 2–3 weeks |

---

## Recommendation

Match the option to the product:

- **Sequential-device apps** (phone, then desktop, then back) — Ship **Option 1**. The archive already handles history; only the hand-off signalling is new. This is the most common real-world workflow and is fast to ship (2–3 days).
- **Strict-session apps** (banking, B2B with audit requirements) — Ship **Option 2**. Provably one active session at any moment; simplest threat model.
- **Consumer messengers expecting Signal/WhatsApp parity** — Plan **Option 3** as the destination, but ship Option 1 first as the foundation. Option 3 reuses Option 1's superseded-on-displace signalling for "this device is dormant" UX, and Option 1's archive-pull for first-time-on-device state restore. Building Option 3 cold without Option 1's mechanics already in place doubles the work.

For Prudence specifically, Option 1 is the natural first step — it covers the same-user-multiple-devices case (e.g. Prudence on desktop and phone for the same account), and the test surface is small.

---

## What we explicitly won't build

For symmetry with the per-namespace `usernamePolicy` and signed-transfer designs, some shapes are out of scope by intent:

- **Relay-stored device list.** No endpoint will accept "here are the devices for account X." Device knowledge lives at contacts (Option 3) or is implicit in last-connected (Options 1 & 2). Reason: it would break the relay's namespace-blind routing model — the relay should not know which devices belong to the same user.
- **Cross-relay session migration.** A device can move between relays (mesh model), but its sessions are tied to its peerId, not to the relay. No design effort goes into "migrate session state to a new relay."
- **Automatic group-history sync to a newly-linked device.** Mirrors the [groups don't get history](../memory/) decision elsewhere — joining (or re-joining) a group on a new device means you see only what arrives after the join. Matches WhatsApp/Signal expectations.
- **Account-key escrow / recovery.** If you lose all devices and your account key is irretrievable, the identity is gone. App builders can layer their own backup-to-email / passkey-attested-key recovery on top (see [identity-patterns.md](identity-patterns.md)), but the SDK doesn't ship one by default.
