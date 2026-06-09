# verification · MeshWhisper example

A focused tiny demo of phone / email verification layered on top of the MeshWhisper SDK. Roughly 200 lines of code total, single Node process, no external services required.

## What this demonstrates

**Pattern B from [`docs/identity-patterns.md`](../../docs/identity-patterns.md): backend-attested verification + locally-held keypair.**

- The user's identity keypair is generated locally by the SDK on first init. The private key never leaves the device.
- The verification service (which in production lives in your backend) issues a short-lived code via SMS / email, accepts the code back, and on success records "phone X is currently associated with public key Y" in its own database.
- The client then calls `MeshWhisper.setIdentifier(phone)` to claim the human-readable handle in the relay directory.

The verification service learns the user's public key but nothing else about them. The relay learns the public key and (after registration) the identifier, but never sees message content or the private key. Three different parties hold three different shards of the user's identity, and no one of them is enough on its own.

## What this is NOT

- **A full account-recovery flow.** Re-verifying the same phone on a fresh device gives you back the same human-readable handle (because you can prove ownership), but the new device has its own keypair. To inherit conversations, sessions, and contacts from a prior device, compose with the linked-devices pattern: see [`examples/linked-devices/`](../linked-devices/) and [`docs/multi-device.md`](../../docs/multi-device.md).
- **An SMS / email provider integration.** The demo's `sendSimulatedSMS` just `console.log`s the code. Swap one line for Twilio / AWS SNS / SendGrid / your provider of choice when productionising — the SDK doesn't care which provider you use.
- **A protection against username squatting.** See the security section below.

## Run

```sh
cd examples/verification
npm install && npm run dev
```

The demo prompts for a phone or email, prints the simulated SMS gateway log (containing the code), prompts for the code, then registers the identifier in the relay directory on success.

Default relay is `wss://relay.meshwhisper.org`. Override with the `MESHWHISPER_NODE` env var to point at your own:

```sh
MESHWHISPER_NODE=ws://localhost:8080 npm run dev
```

## Production wiring

Split the demo into the real shapes:

**Backend service** — extract the `VerificationService` class. Wrap it with an HTTP API:

- `POST /verify/start { identifier }` → calls `submitIdentifier(identifier)`, returns `{ ok: true }` and (out-of-band) the SMS gateway delivers the code.
- `POST /verify/finish { identifier, code, publicKey }` → calls `verifyCode(identifier, code, publicKey)`, returns the result.
- `GET /whois?identifier=...` → calls `whoIs(identifier)`.

Wire in a real SMS provider:

```ts
async function sendSMS(phone: string, code: string): Promise<void> {
  await twilio.messages.create({
    to: phone,
    from: process.env.TWILIO_FROM!,
    body: `Your verification code: ${code}. Valid for 5 minutes.`,
  });
}
```

For email, the equivalent with SES / SendGrid is similar.

Wire in a real database for the pending and verified maps (Redis with TTL is a good fit for `pending`; Postgres or your existing user DB for `verifiedAssociations`).

**Client** — the client side is unchanged conceptually:

1. `MeshWhisper.init({...})` to bootstrap the SDK.
2. Call your backend's `/verify/start` with the identifier the user typed.
3. Prompt for the code, call `/verify/finish` with the code + `MeshWhisper.getLocalPeerId()`.
4. On success, call `MeshWhisper.setIdentifier(identifier)` to claim the handle.

## Security considerations

These are real concerns the demo deliberately punts on; flagged here so you don't deploy the shape unchanged.

- **Rate limiting on `submitIdentifier`.** Without it, an attacker can drain your SMS budget and DoS legitimate users. Cap per-identifier (e.g. 1 code per minute, 5 per hour) and per-source-IP.
- **Per-identifier attempt limit + global lockout.** The demo allows 3 attempts before invalidating the code; a real backend should also lock the identifier for some window after repeated failures across sessions.
- **Username squatting.** Under the relay's default `signed-transfer` policy, the first key to call `MeshWhisper.setIdentifier(phone)` claims it. There's currently no relay-side check that the user actually owns the phone — the verification happened at your backend, but the relay only knows what the client tells it. An attacker who never verified could still try to claim a phone they don't own. Mitigations: run your own relay and gate `/directory` writes behind a backend-issued attestation token (a small relay change you'd add to a forked node binary), OR use opaque IDs as the relay handle and treat the phone as a display label that's resolved via your own backend instead of the relay's directory.
- **Code entropy.** 6 digits = 10⁶ possibilities; with 3 attempts that's ~3 × 10⁻⁶ chance of guessing per code. Adequate for short-lived codes but combine with rate limiting. Higher-value flows (banking, etc.) want 8+ digits or a different mechanism altogether (push approval, hardware key).
- **Replay across providers.** If the same identifier is used in multiple apps that all integrate MeshWhisper with their own verification, each app's namespace is isolated — but if you ever share a verification backend across namespaces, scope your codes (and your DB records) per namespace.
- **Recovery.** This demo only covers the happy path. A user who loses their device needs to re-verify their phone, AND they need to get their conversation history back from somewhere. The two parts are independent: re-verification is in scope here; conversation recovery via linked-devices QR pairing or archive restore is covered separately.

## How this composes with other examples

- [`examples/linked-devices/`](../linked-devices/) — when a verified user wants to add a second device without re-verifying, run the QR pairing flow. The new device gets its own keypair; the primary signs it into the account.
- [`examples/support-bot/`](../support-bot/) — agents can be verified the same way (use a known business email).
- [`prudence/`](../../prudence/) — Prudence uses Pattern A (password-derived identity), not Pattern B. Worth reading both to see the trade-off.

## What the SDK contributes vs. what you bring

| Layer | Who builds |
|---|---|
| Identity keypair (X25519 + Ed25519) | SDK, generated on init |
| Local storage of the keypair | SDK + your `StorageBackend` impl |
| Relay directory registration | SDK via `setIdentifier(...)` |
| Code generation, expiry, attempt limits | **You** — `VerificationService` in this demo |
| SMS / email delivery | **You** — your provider of choice |
| Backend database of `phone → publicKey` | **You** — your DB of choice |
| Rate limiting on `submitIdentifier` | **You** — at your API layer |
| End-to-end encryption between users post-verification | SDK |
