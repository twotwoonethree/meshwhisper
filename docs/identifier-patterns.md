# Identifier patterns

MeshWhisper separates **the cryptographic identity** of a user (covered in [identity-patterns.md](identity-patterns.md)) from **how users discover each other**. This document covers the second one: what string a user is found under, how lookups work, and what the SDK does and doesn't enforce.

The protocol is identical regardless of which pattern you pick. Same X3DH, same Double Ratchet, same end-to-end encryption guarantees. You're choosing what to call the user from the outside — not how messages are encrypted.

## How the SDK actually treats identifiers

```
your registration flow → decide what to call this user
                              ↓
                  MeshWhisper.init({ username: '<that-string>' })
                              ↓
              SDK publishes prekey bundle to the relay's directory
                              ↓
        Other users do MeshWhisper.addContactByKey('<that-string>')
                       to look up and start chatting
```

Two rules:

1. **The `username` field is just a string.** The SDK doesn't parse it, validate its shape, or treat phone numbers differently from emails or handles. Whatever you pass in is what `addContactByKey` looks up.
2. **Uniqueness is per-namespace, with a policy.** The relay maintains a UNIQUE index on `(namespace, username)`. What happens when a *different* key tries to register an already-claimed username is governed by a per-namespace policy:

   - **`signed-transfer` (default).** Takeover is rejected with HTTP 409 *unless* the request includes a transfer token signed by the current owner (see [Signed transfer](#signed-transfer) below). Re-publishing the bundle from the SAME key always succeeds (covers bundle refresh, key-rotation flows that retain the key, etc.).
   - **`last-writer-wins` (opt-in).** Takeover is permitted; the new key displaces the prior owner silently. Useful for password-derived identity flows where re-deriving the same key from credentials is the recovery story.

   Set the policy once per namespace, early:
   ```ts
   await MeshWhisper.setNamespacePolicy('last-writer-wins'); // opt out of default
   ```
   The policy is sticky — the first call wins. Re-calling with the same value is a no-op; re-calling with a different value returns 409.

What follows from these two rules: **the identifier system is your choice**, including verification (or its absence), collision policy, and renames. The SDK gives you the directory primitive; you compose it into whatever flow your product needs.

## Pattern 1 — username (handle-style)

The Twitter/Discord pattern. User picks a string at registration; it's their handle.

```ts
const handle = await promptUserForHandle(); // 'alice'
const available = await MeshWhisper.checkIdentifierAvailable(handle);
if (!available) {
  // show "that handle is taken — try another"
  return;
}
await MeshWhisper.init({
  namespace: 'com.yourapp',
  username: handle,
  storage,
});
// Other users add you with: MeshWhisper.addContactByKey('alice')
```

**Pros**: no PII, low friction, familiar UX.

**Cons**: discovery is global within your namespace — anyone who guesses a handle can reach that user. No recovery if user forgets their handle (it's the identifier). Squatters.

**Use when**: consumer apps, communities, anywhere you don't need to verify the user is who they say they are.

## Pattern 2 — phone number (WhatsApp-style)

User registers under their phone number after SMS verification.

```ts
const phone = await promptForPhone();          // '+447700900123'
const code = await sendSMSCode(phone);         // your SMS gateway (Twilio etc.)
const entered = await promptForCode();
if (code !== entered) throw new Error('Wrong code');

await MeshWhisper.init({
  namespace: 'com.yourapp',
  username: phone,                              // normalize to E.164 first
  storage,
});
// Other users add by: MeshWhisper.addContactByKey('+447700900123')
```

**Pros**: matches user expectations from existing messengers; phone number is a reasonably strong unique identifier; enables contacts-list lookup ("which of my phone contacts are on the app").

**Cons**: phone numbers are PII; SMS gateways cost ~$0.005-0.05 per send; SIM-swapping is a known attack; storing phone numbers is regulated in many jurisdictions; users have to share their phone number to be reachable.

**Use when**: consumer messengers, especially ones competing with WhatsApp / Signal on familiarity.

## Pattern 3 — email (Slack-style)

User registers under their email address after a verification email.

```ts
const email = await promptForEmail();          // 'alice@acme.com'
const code = await sendEmailCode(email);       // your SMTP / SES / SendGrid
const entered = await promptForCode();
if (code !== entered) throw new Error('Wrong code');

await MeshWhisper.init({
  namespace: 'com.yourapp',
  username: email.toLowerCase(),               // canonicalise
  storage,
});
// Other users add by: MeshWhisper.addContactByKey('alice@acme.com')
```

**Pros**: email is a strong identifier in B2B contexts; verification is essentially free; users already manage email recovery.

**Cons**: email is PII; spam concerns for verification messages; "what if alice@acme.com leaves Acme" — emails change.

**Use when**: B2B apps, customer-service portals, internal team tools where email is already the org's identity primitive.

## Pattern 4 — opaque random ID (Discord-style)

User registers under a system-generated id; their display name is separate, mutable, and never used for lookup.

```ts
const opaqueId = `user_${crypto.randomUUID()}`;
await MeshWhisper.init({
  namespace: 'com.yourapp',
  username: opaqueId,                          // never user-facing
  storage,
});

// Display name handled separately in your app's UI layer.
// When a user wants to share their account, they share opaqueId
// (typically via a QR code or copy button), not a memorable handle.
```

**Pros**: no PII; no collisions possible; no squatting; identifier is intrinsically unique. Display names are free to collide — they're cosmetic.

**Cons**: ugly to share; needs UX affordances (QR codes, share sheets) since users can't remember the identifier; harder for users to find each other.

**Use when**: privacy-focused apps, communities where users find each other through other channels (links, QR, invites) rather than searching directories.

## Pattern 5 — peerId only (PGP-style)

No relay-registered identifier at all. Users share each other's raw cryptographic public key.

```ts
await MeshWhisper.init({
  namespace: 'com.yourapp',
  // no `username` field
  storage,
});

const myPeerId = MeshWhisper.getLocalPeerId();   // hex Ed25519 pubkey
shareWithFriends(myPeerId);
// Friends add by: MeshWhisper.addContactByKey('<that-hex-string>')
```

**Pros**: maximum privacy; no directory required; nothing for the relay to store about your social graph.

**Cons**: terrible UX — users have to share 64-character hex strings; no human-readable identifier.

**Use when**: security-critical apps, expert users, or as a "stealth mode" fallback alongside another pattern.

## Pattern 6 — hybrid (Signal-style)

User registers under a phone number for discoverability (Pattern 2), but the app shows a *separate* display name that the user controls and can change. Lookups still go through the phone number.

```ts
const phone = await verifiedPhoneNumber();
const displayName = await promptForDisplayName();  // 'Alice Cohen'

await MeshWhisper.init({
  namespace: 'com.yourapp',
  username: phone,
  storage,
});
// Display name stored separately, app-side
await storeDisplayName(MeshWhisper.getLocalPeerId(), displayName);
```

**Pros**: combines discoverability of (2) with display-name flexibility of (4); user can rename without changing their identity.

**Cons**: same PII concerns as Pattern 2; two layers to think about.

**Use when**: consumer messengers that want both ease of discovery AND user-controlled presentation.

## SDK helpers

The SDK provides a few utilities for working with identifiers:

```ts
// Set the namespace's username-ownership policy once, early.
// Default is 'signed-transfer'; opt into 'last-writer-wins' if you want
// the password-derived re-attach flow.
await MeshWhisper.setNamespacePolicy('signed-transfer');
const current = await MeshWhisper.getNamespacePolicy();

// Check if a string is available before claiming it
const available = await MeshWhisper.checkIdentifierAvailable('alice');

// Change your registered identifier (republishes your prekey bundle).
// Under signed-transfer policy, throws if the identifier is held by
// a different identity in this namespace.
await MeshWhisper.setIdentifier('alice2');

// Authorize a different device to take over a username you own
// (see "Signed transfer" section below).
const token = await MeshWhisper.createUsernameTransferToken({
  username: 'alice',
  toPublicKey: '<new device hex pubkey>',
});
// On the new device:
await MeshWhisper.acceptUsernameTransfer(token);

// Look up a contact by identifier
const peerId = await MeshWhisper.resolveUsername('alice');

// Add a contact by identifier (looks up bundle, initiates handshake)
await MeshWhisper.addContactByKey('alice');
```

`addContactByKey` accepts either a registered identifier OR a raw hex peerId — it tries identifier lookup first, falls back to treating the input as a peerId.

## Signed transfer

Under the default `signed-transfer` policy, a username is sticky to whichever key first claims it — a different key cannot take it via a plain re-registration. To support legitimate handovers (device migration, key rotation, gifting a handle to a friend) the current owner can mint a *transfer token* that authorizes one specific new key to take over.

The token is signed by the current owner's Ed25519 identity key and is bound to:

- the namespace,
- the username being transferred,
- the new owner's public key (so a leaked token can't be redirected),
- an expiry (so a leaked token has limited blast radius).

Default expiry is 24 hours; pick something shorter for higher-risk handles.

### Issuing a token (current device)

```ts
const token = await MeshWhisper.createUsernameTransferToken({
  username: 'alice',
  toPublicKey: '<new device hex Ed25519 pubkey>',
  expiresInMs: 60 * 60 * 1000, // optional, default 24h
});
// token is a plain JSON object — share via QR, paste, share sheet, etc.
```

The signature is over `meshwhisper.username-transfer.v1\n{namespace}\n{username}\n{toPublicKey}\n{expiresAt}` (UTF-8 bytes). The relay reconstructs the same canonical bytes to verify.

### Redeeming a token (new device)

```ts
await MeshWhisper.acceptUsernameTransfer(token);
// throws if token is for a different recipient, namespace, expired,
// or the relay rejects the signature.
```

Internally this republishes the new device's prekey bundle with `username: '<token.username>'` and a `transferAuth` payload, which the relay verifies against the current owner's stored key.

### Security properties

| Property | Holds because |
|---|---|
| Wrong-recipient replay | Token signature covers `toPublicKey`. The relay reconstructs the canonical message using the actual registrant's public key — a different key trying to redeem fails verification. |
| Cross-namespace replay | Token signature covers `namespace`. |
| Cross-username replay | Token signature covers `username`. |
| Stale token replay | Token has an `expiresAt` checked server-side. |
| Forged token by a non-owner | The relay verifies against the *current owner's* key looked up from the directory, not the `fromPublicKey` field in the token. A non-owner signing a transfer fails verification. |

### What this does NOT do

- **No multi-use protection.** A valid token can be redeemed any number of times until it expires. If you want single-use, set a short expiry — or build single-use semantics at your app layer. The relay doesn't track redeemed tokens.
- **No revocation.** Once a token is signed, it's valid until expiry. If you sign a 24h token then change your mind, you can't recall it (other than by rotating your identity key, which is a much bigger operation).
- **No transfer of sessions, contacts, or messages.** The token moves the *directory entry only*. Existing X3DH sessions, contacts and message history remain bound to whichever device owns them. A "true" device migration requires app-level archive transfer in addition to the handle.

For most apps, "short-expiry token + share via QR + accept once" is the right shape.

## What the SDK does NOT provide (intentionally)

- **No verification flows.** SMS, email, captcha — your app's job. The SDK doesn't know if the identifier represents a real verified user; it just stores it.
- **No identifier normalisation.** `+44 7700 900123` and `+447700900123` are different strings to the SDK. If you want to treat them as the same, canonicalise before passing to the SDK.
- **No multi-identifier records.** One identity = one identifier in the directory. If you want a user to be discoverable by both phone AND email, you'd register one as the canonical identifier and maintain the other as a separate app-side lookup.
- **No identifier-uniqueness across apps.** "alice" in `com.app-a` and "alice" in `com.app-b` are two different identities; the relay's directory is partitioned by namespace.
- **No collision UX.** If `setIdentifier('alice')` throws "taken," it's up to your app to prompt the user, suggest alternatives, etc.

These are deliberate. They keep the SDK protocol-agnostic and let app builders compose identifier flows that fit their threat model and product UX.

## Choosing — a one-question decision tree

> What does your app need users to be discoverable by?

- **Just a handle they pick** → Pattern 1
- **A phone number** → Pattern 2 (with SMS verification)
- **A work email** → Pattern 3 (with email verification)
- **Nothing typeable; they share QR codes or invite links** → Pattern 4 or 5
- **A phone number for discovery, but they can rename for display** → Pattern 6

Most consumer apps end up at Pattern 1, 2, or 6. Most B2B apps end up at Pattern 3. Privacy-focused or expert apps land on 4 or 5.

## Hybrid models and migrations

Nothing stops you combining patterns or changing them later. Common combinations:

- **Phone for first-time discovery, opaque ID for export**: register phone, but also generate an opaque id the user can share without exposing their phone number.
- **Handle with email recovery**: register a handle, but bind it to an email server-side for "I forgot my handle" recovery flows (your app's logic, not the SDK's).
- **Migrating from one identifier to another**: a user can `setIdentifier()` to a new string at any time (provided no one else holds it under signed-transfer). The old one is released and someone else can claim it. Their cryptographic identity (and existing contacts) is unaffected — peerId is what really matters; the identifier is just a directory entry.

The SDK doesn't know or care which combination you pick. It stores the current identifier as a string, and that string is what `addContactByKey` looks up.

## Related

- [Identity patterns](identity-patterns.md) — how the cryptographic key gets derived (six patterns: password, email-code, phone-code, OS keychain, Secure Enclave, passkey).
- [API reference](api.md) — `MeshWhisper.init`, `MeshWhisper.checkIdentifierAvailable`, `MeshWhisper.setIdentifier`, `MeshWhisper.addContactByKey`, `MeshWhisper.resolveUsername`.
- [Prudence as SDK reference](../prudence/REFERENCE.md) — Pattern 1 wired up end-to-end.
