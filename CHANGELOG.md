# Changelog

All notable changes to MeshWhisper will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The repository was made public on 2026-04-30. Changes prior to that date are
preserved in git history but not enumerated here.

## [Unreleased]

## [0.4.0] — 2026-06-13

### Added

- **Group fan-out for messenger features.** Reactions, quoted replies, message forwarding, and disappearing messages now work in groups — previously DM-only. The control wire format gains a `groupId` field on `reaction` and `disappearing_messages` so receivers apply the change to the group conversation; `sendToGroup` now honours `replyTo`/`forwardedFrom`/`expiry`/the group's disappearing-messages policy; `forwardMessage` routes to a group via `sendToGroup` when the destination is a group id. Prudence DM-only gates removed — the existing UI works in groups unchanged.

### Fixed

- **Group messages now have a stable id across every receiver's stored copy.** Previously each per-member fan-out built its own envelope id in `sendMessageRaw`, so the sender, receiver A, and receiver B held the same logical message under three different ids — breaking reactions, replies, forwarding, and delete-by-id for groups. `sendToGroup` now allocates one `messageId` and threads it through the `__mw_grp` envelope; receivers prefer the inner id over the outer.

## [0.3.0] — 2026-06-12

### Added

- **LAN peer-to-peer delivery (dual-send).** Peers on the same subnet discover each other (UDP broadcast, anonymous per-session device IDs) and exchange real messages directly over TCP. Every outbound message is offered to connected LAN peers alongside the guaranteed relay path; receivers deduplicate at the packet level. Established conversations survive losing the relay — or the entire internet. On-site and air-gapped deployments (human and machine-to-machine) are a supported configuration: see [docs/local-networks.md](docs/local-networks.md) and the [local-first example](examples/local-first/). New `transports.lan` config knob (`true` default / `false` / `{ udpPort, tcpPort }`). Spec: [docs/p2p-transport.md](docs/p2p-transport.md) (Phase 1 of the opportunistic transport-upgrade model, [ADR-004](docs/adr/004-opportunistic-transport-upgrade.md)).

### Fixed

- Packet-level inbound dedup releases its mark when a copy proves undecryptable, so a direct-path copy racing ahead of a not-yet-ready session can't suppress the relay copy (would have turned a transient decrypt failure into message loss).

## [0.2.0] — 2026-06-11

First coordinated release of `@meshwhisper/sdk`, `@meshwhisper/node`, and `@meshwhisper/cli` since 0.1.1 (2026-04-11). Everything below ships in this release.

### Added

- **Relay federation (v1.1).** Relays peer over a mutual-Ed25519 WebSocket handshake and forward packets for each other ([docs/federation.md](docs/federation.md)). `FEDERATION_MODE=open` (recommended) admits any relay that completes the handshake — per-peer rate limiting, hop caps, packet dedup, and a reactive blocklist are the abuse boundary; `allowlist` mode for operators who want explicit control. The Foundation relay runs open mode as the published bootstrap peer.
- **Multi-device, Model 3 (linked devices).** Account/device data model, signed `device_added`/`device_revoked` announcements with persistent LWW replay protection, `sendMessage` fan-out to all linked devices, and QR/paste pairing (`createDeviceLinkOffer`/`acceptDeviceLinkOffer`). Reference app: `examples/linked-devices/`.
- **Messenger-grade conversation features:** reactions (`toggleReaction`), quoted replies (`replyTo`), message forwarding with original-author chain preservation (`forwardMessage`), per-conversation disappearing messages (`setDisappearingMessages`), and group rename — all with control-message wire formats and Prudence UI.
- **Per-namespace username-ownership policy.** `signed-transfer` (default): a username is yours until you sign it over (`createUsernameTransferToken`); `last-writer-wins` opt-in per namespace for apps that want loose handles.
- **React Native storage backend** — `@meshwhisper/sdk/react-native` `AsyncStorageBackend`.
- **Relay production hardening:** per-IP rate limiting on all endpoints (with `TRUST_PROXY` support), Prometheus `/metrics`, documented sqlite hot-backup procedure, `SECURITY.md` vulnerability-reporting policy.
- **`@meshwhisper/cli` rebuilt as a real scaffold.** `init` writes a deployable node directory (compose + standalone Dockerfiles installing the published packages + generated VAPID keys + open-federation bootstrap) and a working SDK skeleton; new `doctor` (node health check) and `vapid` (dependency-free RFC 8292 keygen) subcommands.
- **Encrypted relay archive** — opaque AES-GCM blob colocated with the relay the user has already chosen to trust. The archive key and write-authentication token are HKDF-derived from the user's identity key (itself derived from username + password via PBKDF2), so no separate recovery code or third-party cloud account is required. Sessions are excluded from the archive to preserve forward secrecy at rest.
- **Multi-device archive sync via merge** — `pushArchive` performs a merge-based update through `mergeKv` instead of last-writer-wins, so two devices that mutate state concurrently no longer overwrite each other.
- **New SDK methods** for the archive: `pushArchive`, `pullArchive`, `exportArchive`, `importArchive`, and `deriveBackupKey`.
- **`MeshWhisper.resolveUsername(peerId)`** — public SDK method that backfills display names from the relay's prekey directory; useful for hydrating contact lists and group rosters.
- **`onContactRequest` now fires for direct inbound `x3dh_init`** from new peers (previously only fired via the directory lookup path).
- **Live network activity page** at [meshwhisper.org/live](https://meshwhisper.org/live) — anonymous SSE stream of relay activity, no peer-identifying data.
- **PWA aggressive update polling** — Prudence picks up new deploys within roughly 60 seconds without a manual reload.
- **Foreground rich notifications in Prudence.** When the app is open in any tab, even backgrounded, a new message produces a Notification API alert with the sender's `@username` and a preview. Tapping the notification opens the conversation. Suppressed when the user is actively viewing that conversation in a focused tab. Closed-app notifications still fall back to the service worker's generic "You have a new message" message — closing that gap (decrypting the encrypted blob in the SW) is planned in `docs/shipping.md` Phase 1.5.
- **Leave group flow.** `GroupHandle.leave()` now broadcasts a `group_leave` control message to every other current member before wiping local state, so other clients remove the leaver from their roster and surface a "@user left the group" system message. New `onGroupMemberLeft(groupId, peerId)` config callback fires on the receiving side. Prudence wires this into the existing trash-icon affordance — for groups it reads "Leave group" and confirms accordingly.
- **Add members to an existing group.** `GroupHandle.addMember(peerId)` is now async and broadcasts a `group_member_added` control message to existing members alongside the regular `group_invite` to the new member. Recipients add the peer to their roster and store the new member's sender + Ed25519 keys so they can both decrypt the new member's messages and message them directly. Admin or any current member of an admin-less group can call it. New `onGroupMemberAdded(groupId, peerId, addedBy)` config callback. Prudence: `+` button in the group conversation header opens a contact picker; "added" system messages appear in the conversation.
- **Admin transfer and admin-less groups.** `GroupHandle.transferAdmin(newAdminId)` (or `becomeAdminless()`) broadcasts a `group_admin_change` control message; only the current admin can call it. An admin-less group has `treeRoot === ''` and any current member can add new members. Prudence: when the admin clicks Leave on a group with other members, a handoff dialog asks them to either nominate a successor or convert to admin-less before leaving. The previous "admin leaves and the group is permanently un-administered" failure mode is gone — even if the admin leaves without explicit transfer, receivers fall back to admin-less rather than freezing the group. New `onGroupAdminChanged(groupId, newAdminId, changedBy)` config callback.
- **Admin kick (remove member).** `GroupHandle.kickMember(peerId)` broadcasts a `group_member_kicked` control message to all members including the kicked one. Authorised only for the current admin; admin-less groups intentionally have no kick capability. The kicked peer wipes their local group state on receipt and surfaces a one-time browser notification. Prudence: a Members panel in the group conversation header lists all members with a Remove button next to each (admin only). New `onGroupMemberKicked(groupId, peerId, kickedBy)` and `onKickedFromGroup(groupId, kickedBy)` config callbacks.
- **Fresh-device sign-in re-handshakes contacts automatically.** Sessions are excluded from the archive (forward secrecy), so a fresh device that pulls the archive has contacts and history but no Double Ratchet state. The SDK now (a) includes `edkeys/*` in the archive so each contact's Ed25519 key survives the move, (b) extends `reinitiateSessionsOnStartup` to fall back to a relay directory lookup keyed by the cached edKey when no prekey bundle is available locally, and (c) triggers reinit at the end of `importArchive`. End result: a user who signs in on a new device can send and receive messages immediately after archive restore, instead of silently dropping inbound messages until manually re-adding contacts. Hand-off semantics: the most recently signed-in device wins; older devices' sessions go stale (use linked-devices for true simultaneous multi-device).
- **`GroupInvite.memberEdKeys`**: invites now carry per-member Ed25519 identity keys so non-creator members can establish pairwise X3DH sessions with one another. Without this, member-to-member messaging silently failed for any pair that hadn't met directly.

### Changed

- **Blob TTL and listen window 72h → 30 days.** The relay queues unredeemed blobs for up to 30 days (`BLOB_TTL_HOURS=720` default; override per deployment) and SDK clients ask for the full 30-day window of dest hashes on reconnect. Anyone offline for a long weekend or a holiday now comes back to a working inbox. Trade-off: the relay sees a coarser "this client has been away for at most 30 days" signal instead of "at most 72 hours." Live presence visibility is unchanged.
- **Automatic `handshake_activate` after every outbound `x3dh_init`** — receivers no longer need a separate trigger to promote a freshly-handshaken session into the active state.

### Fixed

- **Session ping-pong on first contact.** When Bob received Alice's `x3dh_init`, his SDK's auto-fired control messages (entropy challenge, reputation proof) ran through `ensureSession`, which auto-reinitiated his fresh receiver session and bounced an `x3dh_init` back at Alice — who then auto-reinitiated and bounced one back at Bob, etc. Real ratchet messages decrypt-failed silently on both sides until the conversation was unrecoverable. `ensureSession` no longer auto-reinitiates; recovery from genuinely stuck sessions is via `addContactByKey`, which is user-driven and explicit so it doesn't participate in the loop.
- **`deleteConversation` now wipes in-memory ratchet state.** Previously it only deleted the persisted session in IDB, so the SDK kept using the stale (possibly corrupted) session in memory until the next reload. Re-adding a contact silently reused the bad state. Now removing and re-adding really does start fresh.
- **Receive-only sessions can no longer get stuck.** A peer that has only ever received messages now correctly recovers an active session when it tries to send.
- **Soft retry on receiver-only send.** When a peer's `x3dh_init` arrives and replaces an existing session, the local session is briefly receiver-only until the matching `handshake_activate` is processed. `sendMessage` now waits up to ~6 seconds for the sending chain to bootstrap before throwing, so the user's send succeeds transparently instead of surfacing a `failed` indicator the moment another device of the recipient signs in and re-handshakes.
- **Per-conversation keyed mutex** around storage read-modify-write paths. Concurrent sends and receives on the same conversation can no longer drop messages by clobbering each other's storage writes.
- **Deliver messages queued at the relay regardless of reconnect timing.** Recipients now drain queued blobs on reconnect rather than only on the original delivery attempt.
- **`lookupPreKeyBundle('@username')`** previously sent the literal `@username` to the relay, which rejected the directory query with HTTP 400. The `@` prefix is now stripped before the wire query.
- **Decrypt-failure path now logs** a `[meshwhisper] decrypt failed for inbound packet` warning instead of silently dropping. The next regression in this code path will surface in browser consoles and e2e tests immediately.
- **`docker-compose.yml` `BLOB_TTL_HOURS` default 72 → 720** to match the relay code's new 30-day default. The Compose default was a stale leftover from before the listen-window change; deployments using the bundled Compose were silently still on 72h until they overrode the env var explicitly.
- **Archive push reliability — flush on hide/unload + max-debounce cap.** `scheduleArchiveSync` previously used a 5s debounce that was reset on every state change, so a brisk conversation followed by closing the tab could mean the push never fired at all and the relay's archive stayed frozen at the previous (often near-empty) snapshot. Investigation of one user's account showed exactly this — a 328-byte archive containing only their identity, with no messages despite a real conversation having taken place. Fix: keep the 5s "no activity" debounce, add a 30s max-cap so the timer can't be reset forever, and flush synchronously on `visibilitychange→hidden` and `pagehide`. Unload-flushes use `fetch(..., { keepalive: true })` so the request completes even after the tab navigates away. The keepalive path is skipped for archives over ~60 KB (browser spec limit) and falls back to the next-session push.
- **`node: 'mesh'` (the SDK default) resolved to `relay.meshwhisper.io` — a domain that does not exist** — in both transports and the media uploader. Now `relay.meshwhisper.org`.

[Unreleased]: https://github.com/twotwoonethree/meshwhisper/compare/main...HEAD
