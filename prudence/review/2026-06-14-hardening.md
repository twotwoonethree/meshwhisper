# Prudence PWA — Hardening Report

_Multi-agent review, 2026-06-14. 27 candidate defects → 17 confirmed after adversarial verification._

## Executive Summary

Integration health is solid overall. The crypto boundary (Double Ratchet AEAD, server-side
username validation, authenticated/encrypted archive) holds up to adversarial probing — every
alleged crypto vulnerability of substance was either refuted or downgraded to data-hygiene
concerns. The defects that matter cluster in one well-known place: the **AppMessage projection
ratchet** (the documented gotcha where new SDK fields must be mirrored across every projection
site). The single most important fix is the **incoming media-message projection dropping
`replyTo`/`forwardedFrom`** — a genuine, user-visible data-loss bug on first receipt. The rest are
projection inconsistencies, missing `scheduleArchiveSync()` calls, and one stale-closure
dependency-array gap; all low-risk and mechanical to fix.

---

## Critical

*None.* The one finding originally filed as critical (media projection dropping fields) is
reclassified High below — its corrected blast radius is first-receipt-only; the SDK preserves the
fields in storage, so history recovery restores them on reload.

---

## High

### 1. Incoming media messages drop `replyTo` and `forwardedFrom` on first receipt
`prudence/src/App.tsx:294-303`
A media-bearing message that is also a quoted reply or a forward loses those fields when projected
into React state — quoted-reply and forward attribution silently vanish until a reload re-hydrates
from SDK storage. The normal text path (345-358) and history-restore path (652-665) both preserve
these fields; the media path does not.
**Fix:** After the `senderId/senderName` spread, add `...(msg.replyTo ? { replyTo: msg.replyTo } : {})`
and `...(msg.forwardedFrom ? { forwardedFrom: msg.forwardedFrom } : {})`. Do **not** add `reactions`
here — the real-time `Message` type carries no reactions; they arrive via `onReactionUpdated`.

### 2. Disappearing-messages system message never persisted; lost on reload
`prudence/src/App.tsx:946-974`
`handleSetDisappearing()` injects a system message into React state but never persists it through
the SDK. The policy survives (SDK persists it), but the in-thread explanation disappears on reload.
**Fix:** Persist the system message through an SDK path that survives reload, or drop the in-thread
message and surface policy state in the thread header instead.

### 3. Group member add/leave handlers don't schedule archive sync after saving names
`prudence/src/App.tsx:505-558` (`handleGroupMemberAdded`), `565-610` (`handleGroupMemberLeft`)
Both `saveContactName()` newly-discovered members (511, 517, 573) but never call
`scheduleArchiveSync()`. Names land in localStorage but aren't pushed to the relay archive, lost on
other devices and possibly on reload. `handleMessage` (416) does this correctly.
**Fix:** Add `scheduleArchiveSync(getSDK())` as the final line of both async callbacks.

### 4. Missing handler dependencies in the SDK-init effect (stale closures)
`prudence/src/App.tsx:878`
The `initSDK` effect registers eight `useCallback`-wrapped handlers but omits all of them from its
dep array: `handleGroupMemberLeft`, `handleGroupMemberAdded`, `handleGroupAdminChanged`,
`handleGroupMemberKicked`, `handleGroupRenamed`, `handleReactionUpdated`,
`handleDisappearingMessagesChanged`, `handleKickedFromGroup`. The SDK can retain stale closures.
High not Critical because the effect early-returns on `!username`/`!authenticated`.
**Fix:** Add all eight handlers to the dependency array at line 878 (all already `useCallback`-wrapped).

---

## Medium

### 5. `handleGroupMemberKicked` doesn't persist resolved names (and no archive sync)
`prudence/src/App.tsx:1382-1426`
Resolves `kickedName`/`kickerName` (1386, 1391) but never `saveContactName()` — resolved names don't
survive reload. Same family as #3.
**Fix:** Persist both names with `saveContactName()` (guard against truncated `…` placeholders), then
`scheduleArchiveSync(getSDK())`.

### 6. Boot-sequence contact-name backfill races the archive-sync window
`prudence/src/App.tsx:786-800`
Boot back-fills DM names via `resolveUsername()` + `saveContactName()` fire-and-forget; they can
resolve after the single boot-time `scheduleArchiveSync(sdk)` debounce has flushed.
**Fix:** Call `scheduleArchiveSync(getSDK())` after the backfill `setState` (791), or await the
backfill before scheduling the boot sync.

### 7. `handleHistoryRestored` doesn't map `groupSenderId` → `senderId/senderName`
`prudence/src/App.tsx:641-677`
Restored group messages only get sender fields when media is present; normal path (345-358) and boot
hydration (827-830) populate them whenever `groupSenderId` is set. Restored group history renders
without sender attribution.
**Fix:** Add `...(m.groupSenderId && m.direction === 'inbound' ? { senderId: m.groupSenderId, senderName: senderDisplayName(m.groupSenderId) } : {})` to the restore projection.

### 8. Boot vs. history-restore disagree on media status (`pending` vs `ready`)
`prudence/src/App.tsx:661` (`ready`) vs `831` (`pending`)
Identical media pointers from SDK storage get different statuses based on load path, changing the
download affordance.
**Fix:** Standardize storage-backed pointers to one status; reserve `pending` for in-flight uploads
in `handleAttach`.

### 9. Disappearing-policy change failures are swallowed; no peer acknowledgment
`prudence/src/App.tsx:946-974`
`setDisappearingMessages()` fires the control message with errors silently caught (`.catch(() => {})`),
and the UI commits on local persistence, not peer delivery. A dropped control message desyncs both
sides with no recovery.
**Fix:** Surface send failure (flag a retry), show the setting pending until acknowledged where
feasible, and reconcile policy on boot.

### 10. Policy-change system messages don't update conversation-list `lastMessage`
`prudence/src/App.tsx:1003-1037` (`handleDisappearingMessagesChanged`)
System message appended to thread but conversation row `lastMessage` not updated. `handleGroupRenamed`
has the same omission. Systemic across several handlers.
**Fix:** Include `conversations: prev.conversations.map((c) => c.id === conversationId ? { ...c, lastMessage: sysMsg } : c)` in the `setState`; apply to `handleGroupRenamed` too.

### 11. Inbound contact-request usernames stored without format validation
`prudence/src/App.tsx:262`
On `contact_request`, `ctrl.username` is written to localStorage with no validation, before consent,
and persists even if declined. Not an injection vector (React escapes), a data-hygiene issue.
**Fix:** Apply the existing `/^[a-z0-9_-]{3,30}$/` regex before storing; defer persistence until accept.

### 12. Declined and accepted contact requests are indistinguishable; no recovery
`prudence/src/accepted-contacts.ts:18-21`
`markAccepted()` and `markDeclined()` write to the same set under one key, so `isHandled()` can't tell
them apart. A declined peer who re-requests is silently ignored forever.
**Fix:** Separate keys for declined vs accepted; only short-circuit when in neither; optionally expire
declined or expose a "show declined" affordance.

---

## Low

### 13. Media MIME type and filename trusted without validation
`prudence/src/App.tsx:292` (and `triggerDownload`, `media.ts:53-58`)
Peer-supplied `mimeType`/`fileName` flow into UI labels and the download `Blob` type / `a.download`.
Content is SDK-encrypted, so this is mislabeling/social-engineering, not content-integrity.
**Fix:** Whitelist MIME types, sanitize filenames (length cap, strip path-traversal), set download
name from sanitized value.

### 14. Lightbox renders decrypted media with no size or dimension bounds
`prudence/src/components/Thread.tsx:696` (blob created in `App.tsx:1730`)
Decrypted bytes become a blob URL with no size/dimension guard and no `onerror`. A peer can send an
oversized image to exhaust client memory (DoS).
**Fix:** Cap decrypted blob size before rendering, optionally validate dimensions, add `onerror`.

### 15. Notification title/body interpolate untrusted text without truncation/sanitization
`prudence/src/App.tsx:331-397`
Names/text go into notifications untruncated/unsanitized. Notification API doesn't parse HTML and
sender identity is cryptographically verified — purely cosmetic (control chars, overlong text).
**Fix:** Truncate and strip control characters. Polish, not security.

---

## Second look

Crypto-layer refutations were correct (ratchet AEAD authenticity, archive AES-GCM, username salt
derivation, push token storage, relay directory validation) — by-design tradeoffs or already
mitigated.

One residual on the refuted **"Media upload completes with empty url/key"** (`App.tsx:1665-1670,
1691-1699`): the *reload* scenario was correctly refuted, but there's a real live-session race — the
optimistic message is marked `status:'ready'` while holding `url=''`/`key=''`, so a click between
upload completion and self-sync arrival can fail the download. Worth a Low follow-up (mark optimistic
media `pending` until self-sync replaces it, or block download on empty url/key).
