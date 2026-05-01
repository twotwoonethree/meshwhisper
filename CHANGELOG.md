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

### Changed

- **Listen window 2h → 72h** to match the relay's default blob TTL. Fixes "got the push notification but the message never arrived" symptoms when a recipient reconnects more than two hours after a sender queued traffic for them.
- **Automatic `handshake_activate` after every outbound `x3dh_init`** — receivers no longer need a separate trigger to promote a freshly-handshaken session into the active state.

### Fixed

- **Receive-only sessions can no longer get stuck.** A peer that has only ever received messages now correctly recovers an active session when it tries to send.
- **Per-conversation keyed mutex** around storage read-modify-write paths. Concurrent sends and receives on the same conversation can no longer drop messages by clobbering each other's storage writes.
- **Deliver messages queued at the relay regardless of reconnect timing.** Recipients now drain queued blobs on reconnect rather than only on the original delivery attempt.
- **`lookupPreKeyBundle('@username')`** previously sent the literal `@username` to the relay, which rejected the directory query with HTTP 400. The `@` prefix is now stripped before the wire query.
- **Belt-and-suspenders receiver-only check in `sendMessage`** to catch a residual case the session-recovery fix did not cover.

[Unreleased]: https://github.com/twotwoonethree/meshwhisper/compare/main...HEAD
