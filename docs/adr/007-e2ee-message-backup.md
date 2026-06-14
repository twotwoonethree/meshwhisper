# ADR-007 — E2EE relay-backed message backup with a user-held recovery key

- **Status**: Proposed
- **Date**: 2026-06-14

## Context

Prudence now ships a Tier 1 "Export my data" feature: a one-way, optionally-encrypted download of conversation transcripts + local metadata (+ the identity key when a passphrase is set). It is honest about being an *export*, not a *restore* — because the gap that makes restore impossible is structural, not cosmetic:

- **There is no SDK message-import API.** `exportConversation` / `exportAllConversations` are read-only formatters; nothing loads messages back into the store.
- **Identity is already recoverable** in Prudence — it is derived deterministically from username + password (`deriveIdentityKey`), so signing in again reconstructs the same account and peerId. `importIdentity` therefore doesn't fit Prudence's model.
- **Metadata is already recoverable** — the relay archive (`pushArchive` / `pullArchive`) is an opaque, client-encrypted blob the relay can't read, holding contact names, accepted contacts, and group rosters.

So Prudence is already at Signal's baseline (account + metadata recover; messages don't). The one missing capability is **message-history restore** after a device is wiped or replaced.

How the field solves this (see the analysis behind this ADR):

- **Signal Secure Backups** (2025): opt-in, E2EE, unlocked by a user-held **recovery key**, tiered free/paid.
- **WhatsApp**: opt-in E2EE backup gated by a **64-digit key or password** (the key sits in an HSM-backed vault so a password can unlock it with rate-limiting). Neither provider can read it.
- **Telegram**: seamless restore *only* because default chats aren't E2EE. Not a model we'll follow.

The common, E2EE-compatible shape is: **a user-held secret gates an encrypted blob the server stores but cannot read.** MeshWhisper already has the server half of that — the relay is an opaque blob store the client encrypts to.

## Decision (proposed)

Extend the existing archive mechanism to optionally carry **message history**, encrypted under a **separate, user-held recovery key** — not the deterministic identity key. This delivers Signal/WhatsApp-grade restore while staying fully within the "the relay can't read this" property the project is built on.

Key properties:

1. **Separate recovery key.** Backup is encrypted under a key independent of username+password, so it survives a password change and a forgotten password is not a single point of failure for *both* login and backup. The recovery key is generated client-side, shown once, and optionally wrapped by a user passphrase for convenience (WhatsApp-style). The relay never sees it.
2. **Reuses the relay's opaque-blob role.** Backup blobs ride the same "relay stores ciphertext it can't decrypt" path as the metadata archive — no new trust assumption about the operator.
3. **Opt-in.** Off by default; the user explicitly enables it and records the recovery key. Lost recovery key = unrecoverable backup, stated plainly (same contract as WhatsApp/Signal).
4. **Round-trips.** Requires the missing **SDK message-import API** so a restored blob actually repopulates the message store — the capability Tier 1 cannot have.

Sketch of the new SDK surface (illustrative, not final):

```ts
// generate / manage the backup key
MeshWhisper.createBackupKey(): { recoveryKey: string }      // shown once
MeshWhisper.enableMessageBackup(recoveryKey, opts?): Promise<void>

// push (incremental) + restore
MeshWhisper.backupMessages(): Promise<{ bytes: number }>    // encrypt + push to relay
MeshWhisper.restoreMessages(recoveryKey): Promise<{ restored: number }>  // pull + decrypt + import
```

## Alternatives considered

1. **File round-trip only (message-import API, no cloud).** Add `importMessages()` so the Tier 1 file can be re-loaded, but keep backups as user-managed files (no relay storage). Simpler and zero relay cost, but pushes all durability onto the user remembering to export and not lose the file. Reasonable as a *first step* toward this ADR (the import API is the shared prerequisite).
2. **Device-to-device transfer (Signal default).** Local transfer between two devices present at once. Poor fit: Prudence is a single-device PWA (Model 1), and there's often no "old device" in the wipe/clear-storage case.
3. **Server-side (non-E2EE) backup (Telegram cloud model).** Rejected outright — it breaks the relay-can't-read guarantee that is the entire point.
4. **Back up under the identity key.** Rejected — ties backup recoverability to the password and means a password change orphans the backup.

## Consequences

- **SDK + relay work**, not app-only: a message-import API (shared with alternative 1), an encrypted backup blob format, incremental push, and relay storage + size limits for backup blobs.
- **Relay storage cost** grows with retained history; needs quotas / tiering decisions (mirrors why Signal's full-history tier is paid).
- **Recovery-key UX burden** on the user — the unavoidable cost of real E2EE backup; mitigated by optional passphrase wrapping.
- **Complements ADR-006**: this is exactly the kind of deliberate SDK addition that ADR called for (security capability that benefits every consumer), versus pushing presentation concerns down.
- Until built, Tier 1 export + the in-app "Account & recovery" explainer + existing peer-to-peer history recovery (DM) remain the recovery story, and Prudence does not promise restore it can't deliver.
- A sensible build order: **(a) message-import API → (b) file-based restore → (c) relay-backed backup with recovery key.** Each step is independently shippable.
