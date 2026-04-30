# Multi-Device Strategy

MeshWhisper's identity model — keys derived deterministically from username and password — means any
device can reconstruct the same identity. The question is how multiple simultaneous or sequential
devices share state and receive messages in real time.

Three options are documented here in increasing order of implementation complexity.

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

**Estimated effort:** 2–3 weeks.

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

**Ship Option 1 (hand-off) first.** It covers the real-world workflow — phone in pocket, desktop at
desk, tablet at home — without any multi-device cryptographic complexity. The archive already
handles history; only the hand-off signalling is new.

Option 3 is the right long-term answer for a product where users expect Signal/WhatsApp parity, but
it should be built on top of a working Option 1 rather than as the first pass.
