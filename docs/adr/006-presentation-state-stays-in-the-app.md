# ADR-006 — Presentation-layer state stays in the app; a typed conversation event log is the only correct SDK alternative

- **Status**: Accepted
- **Date**: 2026-06-14

## Context

A hardening review of the Prudence PWA (the anchor demo and reference integration) surfaced two findings that, on the surface, looked like they might belong in the SDK rather than the app:

1. **System messages vanish on reload.** Prudence injects human-readable timeline notes — "@alice added @carol", "Group renamed to …", "Disappearing messages set to 1 day" — directly into React state. There is no SDK API to persist a local/system message, so these notes are lost on refresh. (The *authoritative* state behind each note — the group roster, the disappearing policy — is persisted by the SDK and re-hydrated on boot; only the rendered note is ephemeral.)

2. **Disappearing-messages policy changes are "fire-and-forget".** `setDisappearingMessages` persists the policy locally and then sends a control message to the peer without awaiting it or surfacing failure, raising the question of whether sender and recipient can silently desync on whether messages disappear.

Both prompted the same question: *given what MeshWhisper is — a reusable, security-first SDK with apps as consumers — is the correct fix in the SDK?*

Investigation of the SDK delivery path settled it:

- Control messages are **not** best-effort at the network layer. `sendControl` routes through `sendMessage(..., { urgency: 'background' })` — the same ratcheted path as content — which queues to `outboundQueue` when offline (`src/sdk/index.ts:876`) and flushes on reconnect (`:4133`). The `.catch(() => {})` only hides the error from the *caller*; it does not make delivery unreliable.
- The disappearing-messages guarantee does **not** depend on the policy-change handshake reaching the peer. Expiry is stamped onto **every individual message** from the sender's local policy at send time (`src/sdk/index.ts:871-874`) and travels with the message. So a sender's messages self-destruct on the recipient regardless of whether the policy control message arrived. The control message only updates the recipient's UI and makes *their* replies adopt the same timer — neither of which is a guarantee the sender's security rests on.

## Decision

**Security and authoritative state belong in the SDK; presentation belongs in the app. Neither review finding warrants an SDK change.**

- **#2 (system messages)** is a presentation concern. Different consumers will render group/policy events differently — a timeline note, a toast, a header badge, or not at all. Pushing arbitrary local-string storage into the SDK would drag a UI decision into the protocol core. Prudence keeps system messages ephemeral and relies on a durable header indicator (hydrated from SDK state on boot) for the policy "record of why".
- **#9 (disappearing delivery)** is already correct at the SDK layer: per-message expiry on the reliable, queued, retried send path. Adding a delivery-ack would engineer against a problem the design already solves.

The hardening fixes for these findings are therefore **app-side only** (see branch `fix/prudence-hardening-2026-06-14`): conversation-list `lastMessage` consistency, and code comments documenting the intentional ephemerality.

## The one correct SDK alternative (deferred)

If durable, **cross-device-consistent event history** ever becomes a product requirement, the correct shape is a **typed, persisted conversation event log** in the SDK — not a "persist this string" method. Sketch:

```ts
// emitted + persisted by the SDK alongside StoredMessage
type ConversationEvent =
  | { type: 'member_added'; actor: string; target: string; ts: number }
  | { type: 'member_left'; actor: string; ts: number }
  | { type: 'group_renamed'; actor: string; from: string; to: string; ts: number }
  | { type: 'disappearing_changed'; actor: string; ttlMs: number | null; ts: number }
  | … ;

MeshWhisper.getConversationEvents(conversationId): Promise<ConversationEvent[]>
```

Consumers render these however they like; the SDK owns persistence and cross-device consistency. This is a **deliberate roadmap feature**, not a hardening fix, and it is the only form in which "system-message persistence" should ever enter the SDK.

## Noted: SDK twin-type smell (related, not blocking)

While fixing the Prudence "projection ratchet" bugs (SDK fields silently dropped when mapping a message into the app's `AppMessage` shape), a contributing **SDK design smell** surfaced — recorded here so it isn't lost, though it does **not** require an SDK change and does not remove the app's need to project:

- The SDK exposes message data through **two types** — `Message` (real-time, via `onMessage`) and `StoredMessage` (persisted, via `getMessages`/history) — with **overlapping but non-identical fields** (e.g. `Message` has no `reactions`; `StoredMessage` does; both carry `replyTo`/`forwardedFrom`/`groupSenderId`).
- Combined with **multiple entry points** (live callback, boot hydration, history recovery), this forces consumers to hand-map at several sites and to remember *which type carries which field* — exactly the condition that let a field land on one path but not another.

The app-side fix (a single `projectStoredMessage()` for the persisted paths, plus a separate live-`Message` path) is correct regardless and lives in Prudence. The *optional* SDK hardening, if ever revisited, would be to make `Message`/`StoredMessage` share a common base (so a field can't exist on one but not the other) or to offer a single canonical normalizer. **Nice-to-have, low priority, not required** — captured only so the smell is on record.

## Consequences

- The Prudence↔SDK boundary stays clean: apps own rendering, the SDK owns security + authoritative state.
- System messages remain ephemeral in Prudence by design; this is documented in code and acceptable because the durable record (header indicator, persisted policy/roster) survives reload.
- A future typed event-log API is captured here so it can be picked up deliberately rather than bolted on as a string store. When implemented, this ADR should be referenced (and likely superseded) by the one that introduces it.
- No change to the wire format or the security guarantees.
