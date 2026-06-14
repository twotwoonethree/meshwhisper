# ADR-008 — Ciphertext Peek: an SDK transparency hook for the relay-visible bytes

- **Status**: Accepted
- **Date**: 2026-06-14

## Context

MeshWhisper's headline property is "the relay literally cannot read your messages." The most convincing way to demonstrate that is to *show* it: tap a message you sent and see the opaque, encrypted blob the relay actually receives, next to the plaintext. The elevate review called this the single highest-value demo moment ("Ciphertext Peek").

It can't be done app-side alone. The encrypted bytes are formed inside the SDK's send path — `sendMessage` → `sendMessageToDevice` produces `fullPayload = concat(serializeRatchetHeader(header), ciphertext)`, wraps it in a packet with a rotating `destHash`, and that packet is what the relay sees (`src/sdk/index.ts` ~1028-1047). The plaintext never leaves the client unencrypted, and the SDK exposes no way to observe the on-wire bytes. Showing decrypted bytes and *calling* them "what the relay sees" would be a lie — fatal in the one demo whose entire point is provable E2EE. So an honest peek needs a small SDK hook (exactly the kind of deliberate SDK addition ADR-006 anticipated).

A second problem is **correlation**: a peek must tie a UI message to *its* ciphertext. The SDK generates the message id internally (`generateMessageId()` at `sendMessage`) and the app doesn't know it — Prudence's optimistic outbound message uses its own UUID, which also means the SDK's stored id (used by `onMessageStatus`) doesn't match the optimistic one. So correlation and the existing status-tick id mismatch share a root cause.

## Decision

Two small, **additive** SDK changes:

1. **`SendOptions.messageId?: string`** — let the caller supply the message id. `sendMessage` uses `options?.messageId ?? generateMessageId()`. Prudence passes its optimistic id, so the optimistic message, the stored message, `onMessageStatus`, and the ciphertext hook all share one id. (Bonus: fixes the latent outbound status-tick id mismatch.)

2. **`onCiphertext?` config callback** — fired once per outbound (non-control) message after the packet is formed:
   ```ts
   onCiphertext?(info: {
     messageId: string;
     recipientId: string;
     destHash: Uint8Array;       // the rotating, per-epoch-hour relay address
     ciphertext: Uint8Array;     // header + ratchet ciphertext = the on-wire payload
     plaintextLength: number;
   }): void;
   ```
   `sendMessageToDevice` returns `{ destHash, ciphertext }`; `sendMessage` fires the hook with the first successful device's bytes plus the message id.

Both are opt-in and non-breaking: existing callers ignore the new option and don't set the handler. `sendMessage` keeps returning `Promise<void>`.

**Security:** the hook exposes only already-encrypted bytes (and the rotating destHash) — data the relay already has. It reveals nothing the client doesn't already hold in plaintext anyway. No key material, no plaintext beyond a length. Safe by construction.

Prudence then caches `{messageId → {ciphertext, destHash, plaintextLength}}` from the hook and, on tapping an outbound message, shows a side-by-side: the plaintext you typed vs. the hex blob the relay got, with the explainer "relay.meshwhisper.org stores and forwards this — it can't decrypt it, and even the address rotates every hour."

## Alternatives considered

1. **Recency correlation, no id (latest-per-conversation).** Cache only the most recent send per conversation; tap your latest message to peek. Simpler (no `SendOptions.messageId`) but can't peek older messages and doesn't fix the status-id mismatch. Rejected in favour of the id approach, which is barely more code and fixes two things.
2. **A non-advancing "preview encrypt" method.** `encryptPreview(recipientId, text)` that clones ratchet state, encrypts, discards. Shows representative ciphertext without a real send, but it isn't the *actual* bytes of a real message and risks ratchet-state bugs. Rejected — less honest, more dangerous.
3. **Return the id from `sendMessage` (`Promise<string>`).** Forces the app to reconcile its optimistic id after the fact. The optional-input approach avoids the reconcile and the return-type churn.

## Consequences

- SDK gains one optional `SendOptions` field and one optional config callback; `dist` rebuilt. No wire-format change, no new security surface.
- Prudence can show a per-message, truthful Ciphertext Peek, and outbound status ticks correlate in-session (shared id).
- Group sends (`sendToGroup`) are out of scope for v1; the hook fires for DM sends. Notable, not blocking.
- This is the SDK transparency hook ADR-006 flagged as the legitimate, deliberate way to enable the demo.
