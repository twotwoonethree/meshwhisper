# ADR-003 — Tombstone + revival model for delete-and-re-add

- **Status**: Accepted
- **Date**: 2026-05-24

## Context

MeshWhisper supports multi-device synchronisation and offline recovery via an encrypted **archive** that each user can push to and pull from their relay. The archive is decrypted client-side; the relay only ever sees a ciphertext blob keyed by the user's peerId.

When a device pulls the archive, the SDK performs `mergeKv()`: existing local data is preserved while remote data is merged in. The merge is deliberately additive — set-union for arrays (`contacts`, `seen_ids`, `blocked`), dedup-by-id-then-sort for message arrays (`messages/*`), direct overwrite for peer key material that's deterministic (`peers/*`, `edkeys/*`). This is correct for offline divergence and fresh-device restore: nothing gets lost.

But it is wrong for **deletions**. Without a positive signal that the user has deleted a peer, the next archive pull restores the contact and surfaces the conversation again. Three successive shipped fixes were needed to reach a stable model:

1. **Tombstones-only** (commit `e160722`). `addTombstone(peerId)` writes a timestamped marker; `mergeKv` filters tombstoned peers from the merged contacts list and suppresses their archived keys. Fixed the immediate "deleted conversation reappears" bug. **Failed under re-add**: a user who deletes then re-adds a peer would, on the next reload, see the peer disappear again — a stale remote tombstone in the relay archive re-applied to the local state.

2. **Revivals as a sibling event** (commit `4b8bcf7`). Added a parallel `revivals: Record<peerId, ms>` map. A peer is considered tombstoned **iff** `tombstone > revival` (max-timestamp wins per peer per event type). Fixed the re-add case. **Failed in practice**: required Prudence handlers to remember to call `scheduleArchiveSync` after every re-add path. They didn't always. Three separate "I re-added but it disappeared again" bugs traced to a Prudence handler omitting the push.

3. **SDK-owned auto-push** (commit `91beca8`). Moved the responsibility into the SDK. Internal `recordTombstone` and `recordRevival` helpers now fire `onArchiveDirty` automatically. Apps wire that callback once and get correct behaviour for every code path that mutates contact state, present or future.

## Decision

The current model:

- **Two parallel maps in the archive**: `tombstones: Record<peerId, ms>` and `revivals: Record<peerId, ms>`.
- **Merge semantics**: take the max timestamp per peer per event type, from the union of local and remote. A peer is currently tombstoned iff `tombstone > revival`. Equal timestamps resolve to "alive" (favour resurrection on the edge case).
- **Internal helpers, not public API**: `recordTombstone(peerId)` fires from `deleteConversation`. `recordRevival(peerId)` fires from `acceptContact`, `addContactByKey`, the inbound-X3DH handshake completion, `acceptGroupInvite`, and `createGroup`. Apps cannot trigger these directly — they happen as side effects of the public API.
- **Both helpers fire `onArchiveDirty`** so the app can push the post-event archive immediately, bypassing any debounce. Without immediate push, stale relay state can resurrect deletions or re-suppress revivals on the next pull until the next ordinary push catches up.

This is essentially a last-writer-wins CRDT for a per-peer "active / deleted" boolean, with `onArchiveDirty` as the propagation hint.

## Alternatives considered

### 1. Tombstones only, no revivals

Implemented first, fixed the original bug. Rejected after the re-add scenario showed it cannot handle delete-then-re-add without an out-of-band signal. The local "I cleared the tombstone" state has no way to defeat a stale remote tombstone with a real timestamp.

### 2. Per-event log of every add/remove, with full history

A full CRDT of peer membership events. Theoretically cleanest. Rejected as over-engineered for the actual use case: nobody needs the "this peer was deleted on March 4th and re-added on March 7th" log. Two scalar timestamps per peer is sufficient.

### 3. Require apps to call a public `setActive(peerId, true/false)` method

Make the deletion-state signal explicit at the API boundary. Rejected because it shifts the bug class from "did the app remember to push the archive?" to "did the app remember to call setActive?" — same shape of bug, same recurrence risk. Auto-firing the event from inside the existing public API methods (`deleteConversation`, `acceptContact`, etc.) means there's no new invariant for adopters to remember.

### 4. Two-phase delete (mark, then sweep)

Mark deleted peers as inactive, then on a later sync confirm the deletion has propagated, then actually remove. Rejected: doesn't solve the multi-device re-add case any better than tombstones+revivals, and adds a second round-trip that's annoying to reason about.

## Consequences

- **Multi-device delete/re-add converges correctly.** A delete on device A, a re-add on device B, in any order, with any sequence of pushes and pulls in between, settles to the same final state on both devices once both have pulled the same archive.
- **Storage cost is small.** Two maps from peerId (hex) to a 64-bit timestamp. For a user with 1,000 historical contacts, ~64 KB of archive overhead — negligible against the message store.
- **Apps must wire `onArchiveDirty`.** Without it, the model still converges, just more slowly (waits for the next ordinary archive push instead of an immediate one). Documented in `docs/api.md`. Prudence's wiring in `prudence/src/App.tsx` is the canonical example.
- **No way to "permanently forget" a peer's tombstone.** If a user deletes a peer at time T, the tombstone persists until the peer is re-added or the archive is deliberately reset. Pragmatically fine; conceptually a small memory leak that's bounded by the user's actions.
- **Equal-timestamp edge case favours alive.** The merge rule is strict greater-than for "tombstoned." Two same-millisecond events on different devices would (extremely unlikely but possible) resolve to "alive." We chose this direction deliberately: better to surface a contact that should be gone than to lose a contact that should be present.
