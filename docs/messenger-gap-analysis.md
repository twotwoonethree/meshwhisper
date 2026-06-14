# Messenger gap analysis — Prudence vs. the mainstream messengers

_Last updated: 2026-06-14_

This document inventories what a competitive consumer messenger (WhatsApp, Signal, Telegram, iMessage) offers that Prudence does not yet, and — more usefully — splits each gap into **SDK** work (a core capability every adopter would need) vs. **App** work (polish any adopter builds on top). It is a strategy/planning artifact, not a committed roadmap.

## The framing that changes the answer

Two things must be said before any feature list:

1. **Prudence is a reference app, not the product.** Per [ADR-001](adr/001-adoption-driven-mesh.md) and `direction.md`, the Foundation does not build a consumer chat product — adopters do, using `@meshwhisper/sdk`. So "compete with the big ones" is really the question *"which gaps belong in the SDK (so every adopter inherits them) vs. in an app (so each adopter, or Prudence as a showcase, builds them)?"* That split is the value of this document.

2. **A PWA cannot compete on iPhone.** iOS aggressively throttles PWA background execution and push delivery. The mainstream messengers are native. No amount of feature work in Prudence closes this; the unlock is a **native client** built on the SDK's existing `@meshwhisper/sdk/react-native` binding. This is the single highest-leverage "compete" move and it is a platform decision, not a Prudence feature.

The competitive **moat** is the part the incumbents cannot credibly claim — the relay literally cannot read messages, self-hostable, federated, no per-seat pricing. The gaps below are not where MeshWhisper *wins*; they are **permission to be considered at all**. Invest the SDK-level table stakes (they compound across every adopter); leave app polish to the showcase and to adopters.

## What Prudence already has

DMs and groups (create, add/remove, admin transfer, rename, leave, kick); end-to-end encryption (X3DH + double ratchet, PQ3-style); media (images + files with thumbnails); reactions, replies, forwarding, disappearing messages (**DM only**); message deletion (own DM); typing indicators and delivery/read ticks; QR + username + paste contact pairing; safety-number verification; in-thread and conversation-list search; draft persistence; unread tab badge; web-push notifications; installable PWA with offline history viewing (history is local-first in IndexedDB — the node is store-and-forward + metadata archive, not the source of history); data export; peer-to-peer history recovery; the "what the relay sees" ciphertext peek ([ADR-008](adr/008-ciphertext-peek-transparency-hook.md)).

That is already a substantial messenger. The gaps are real but the base is not thin.

## Gaps, tiered, with the App / SDK split

Effort is rough: S (≤1 day), M (a few days), L (a week+), XL (multi-week / infra).

### Tier A — table stakes (absence is *felt* as "incomplete")

| Gap | Where it lives | Effort | Notes |
|---|---|---|---|
| Voice messages | **App** (media + `MediaRecorder`) | M | Record, waveform, playback; rides existing media path |
| Message editing | **SDK** (envelope + stored-message update) + App | M | Have delete, not edit; needs an edit control message + `editedAt` |
| Group parity for reactions / replies / forwarding / disappearing | **SDK** (group fan-out, deferred) | M–L | DM-only today; the biggest single "feels half-finished" gap |
| @mentions in groups (+ notification) | **App** (+ small SDK notify signal) | M | Autocomplete, highlight, mention-only notifications |
| Profile photos / avatars (self, contacts, groups) | **App** + archive sync | M | Initials only today; biggest perceived-polish win |
| Block / report **UI** | **App** (`blockPeer`/`unblockPeer` already in SDK) | S | Capability exists; just not surfaced in Prudence |
| Global search (across all conversations) | **App** | S–M | Current search is per-open-thread + conversation names |
| Account recovery ("forgot password" today = account loss) | **SDK** (backup, [ADR-007](adr/007-e2ee-message-backup.md)) + App | L | Disqualifying for mainstream users as-is |

### Tier B — category-defining, hard

| Gap | Where it lives | Effort | Notes |
|---|---|---|---|
| Voice / video calls | **SDK** + media/signalling infra | XL | `direction.md` scopes this as an *extension*, not a core deliverable |
| True multi-device (phone + desktop, live sync) | **SDK** (Model 3 capability exists) + App | L | Prudence is intentionally Model 1; SDK already supports linked devices |
| Cloud backup / restore of message history | **SDK** (message-import API, [ADR-007](adr/007-e2ee-message-backup.md)) | L | Highest-value SDK investment; pairs with account recovery |

### Tier C — growth / network effects

| Gap | Where it lives | Effort | Notes |
|---|---|---|---|
| Contact discovery ("find people you know") | **App** + directory/SDK | M | Username-only is a deliberate privacy choice but a growth ceiling vs. phone-contact sync |
| Shareable invite links (`https://…/add#code`) | **App** | S | Web-native sibling of the existing QR pairing |
| Channels / broadcast / large communities | **SDK** + relay scale | XL | Telegram/WhatsApp's scale play; large-group fan-out + relay capacity |

### Tier D — breadth & polish (each minor; collectively "feels mature")

App-level unless noted: stickers / GIFs (GIF needs a provider → privacy tradeoff), privacy-safe link previews, location sharing, text formatting / markdown, pinned & starred messages, polls (SDK for group state), group descriptions/avatars, scheduled messages, chat themes, and **internationalisation / localisation** (English-only today — a real barrier outside English markets).

## Point of view — what actually moves the needle

If the goal were genuinely to compete, in order:

1. **Native client (react-native).** Without it, iOS notifications/background make any PWA a non-starter for mainstream users. Not a Prudence feature — a platform decision — but the precondition for everything else.
2. **Account recovery + cloud backup ([ADR-007](adr/007-e2ee-message-backup.md)).** "Lose your password, lose everything" disqualifies you instantly. Highest-value **SDK** investment, and it benefits every adopter.
3. **Group feature parity + voice messages + avatars.** The "this is a real chat app" trio. Group parity (SDK) and avatars (app) are the biggest perceived-completeness wins; voice messages are simply expected now.

Everything in Tier D is real but won't change anyone's decision to switch.

## Recommended sequencing for MeshWhisper (not for "Prudence the product")

Prioritise **SDK-level table stakes** — they compound across the whole adopter ecosystem, which is the actual growth strategy:

1. **Group fan-out parity** (reactions/replies/forwarding/disappearing in groups) — finishes a half-shipped capability; every group-using adopter needs it.
2. **Message-import API → backup/restore → account recovery** ([ADR-007](adr/007-e2ee-message-backup.md)) — closes the most disqualifying gap.
3. **Message editing** — small, high-frequency, expected.
4. App-level wins on the **showcase** (Prudence): voice messages, avatars, block UI, global search, mentions — each demonstrates an SDK capability and keeps the reference compelling.
5. Treat **native client**, **calls**, and **channels** as deliberate, separately-scoped initiatives (and, for a true consumer product, an **adopter's** job on native — not the Foundation building WhatsApp).

See also: [ADR-006](adr/006-presentation-state-stays-in-the-app.md) (what belongs in the SDK vs. the app), [ADR-007](adr/007-e2ee-message-backup.md) (backup), [ADR-008](adr/008-ciphertext-peek-transparency-hook.md) (transparency hook), and `direction.md` (overall strategy).
