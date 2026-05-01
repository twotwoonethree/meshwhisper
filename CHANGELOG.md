# Changelog

All notable changes to MeshWhisper will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The repository was made public on 2026-04-30. Changes prior to that date are
preserved in git history but not enumerated here.

## [Unreleased]

### Added

- **Encrypted relay archive** — opaque AES-GCM blob colocated with the relay the user has already chosen to trust. The archive key and write-authentication token are HKDF-derived from the user's identity key (itself derived from username + password via PBKDF2), so no separate recovery code or third-party cloud account is required. Sessions are excluded from the archive to preserve forward secrecy at rest.
- **Multi-device archive sync via merge** — `pushArchive` performs a merge-based update through `mergeKv` instead of last-writer-wins, so two devices that mutate state concurrently no longer overwrite each other.
- **New SDK methods** for the archive: `pushArchive`, `pullArchive`, `exportArchive`, `importArchive`, and `deriveBackupKey`.
- **`MeshWhisper.resolveUsername(peerId)`** — public SDK method that backfills display names from the relay's prekey directory; useful for hydrating contact lists and group rosters.
- **`onContactRequest` now fires for direct inbound `x3dh_init`** from new peers (previously only fired via the directory lookup path).
- **Live network activity page** at [meshwhisper.org/live](https://meshwhisper.org/live) — anonymous SSE stream of relay activity, no peer-identifying data.
- **PWA aggressive update polling** — Prudence picks up new deploys within roughly 60 seconds without a manual reload.
- **Foreground rich notifications in Prudence.** When the app is open in any tab, even backgrounded, a new message produces a Notification API alert with the sender's `@username` and a preview. Tapping the notification opens the conversation. Suppressed when the user is actively viewing that conversation in a focused tab. Closed-app notifications still fall back to the service worker's generic "You have a new message" message — closing that gap (decrypting the encrypted blob in the SW) is planned in `docs/shipping.md` Phase 1.5.
- **Leave group flow.** `GroupHandle.leave()` now broadcasts a `group_leave` control message to every other current member before wiping local state, so other clients remove the leaver from their roster, rotate sender keys for forward secrecy, and surface a "@user left the group" system message. New `onGroupMemberLeft(groupId, peerId)` config callback fires on the receiving side. Prudence wires this into the existing trash-icon affordance — for groups it reads "Leave group" and confirms accordingly.

### Changed

- **Blob TTL and listen window 72h → 30 days.** The relay queues unredeemed blobs for up to 30 days (`BLOB_TTL_HOURS=720` default; override per deployment) and SDK clients ask for the full 30-day window of dest hashes on reconnect. Anyone offline for a long weekend or a holiday now comes back to a working inbox. Trade-off: the relay sees a coarser "this client has been away for at most 30 days" signal instead of "at most 72 hours." Live presence visibility is unchanged.
- **Automatic `handshake_activate` after every outbound `x3dh_init`** — receivers no longer need a separate trigger to promote a freshly-handshaken session into the active state.

### Fixed

- **Session ping-pong on first contact.** When Bob received Alice's `x3dh_init`, his SDK's auto-fired control messages (entropy challenge, reputation proof) ran through `ensureSession`, which auto-reinitiated his fresh receiver session and bounced an `x3dh_init` back at Alice — who then auto-reinitiated and bounced one back at Bob, etc. Real ratchet messages decrypt-failed silently on both sides until the conversation was unrecoverable. `ensureSession` no longer auto-reinitiates; recovery from genuinely stuck sessions is via `addContactByKey`, which is user-driven and explicit so it doesn't participate in the loop.
- **`deleteConversation` now wipes in-memory ratchet state.** Previously it only deleted the persisted session in IDB, so the SDK kept using the stale (possibly corrupted) session in memory until the next reload. Re-adding a contact silently reused the bad state. Now removing and re-adding really does start fresh.
- **Receive-only sessions can no longer get stuck.** A peer that has only ever received messages now correctly recovers an active session when it tries to send.
- **Per-conversation keyed mutex** around storage read-modify-write paths. Concurrent sends and receives on the same conversation can no longer drop messages by clobbering each other's storage writes.
- **Deliver messages queued at the relay regardless of reconnect timing.** Recipients now drain queued blobs on reconnect rather than only on the original delivery attempt.
- **`lookupPreKeyBundle('@username')`** previously sent the literal `@username` to the relay, which rejected the directory query with HTTP 400. The `@` prefix is now stripped before the wire query.
- **Decrypt-failure path now logs** a `[meshwhisper] decrypt failed for inbound packet` warning instead of silently dropping. The next regression in this code path will surface in browser consoles and e2e tests immediately.

[Unreleased]: https://github.com/twotwoonethree/meshwhisper/compare/main...HEAD
