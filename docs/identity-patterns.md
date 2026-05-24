# Identity patterns

MeshWhisper deliberately separates **the cryptographic protocol** (which is fixed and non-negotiable) from **how identity is established** (which is your decision). The SDK reads a 32-byte Ed25519 private key from your storage backend at init; everything before that — passwords, phone numbers, emails, hardware-backed keys, passkeys — is the app's choice.

This document walks through the six common patterns, the tradeoffs of each, and the code you'd actually write. Pick the one that matches your threat model and onboarding flow.

The protocol itself is the same in all six cases: same X3DH, same Double Ratchet, same PQXDH, same end-to-end encryption guarantees. You're choosing how the identity key gets created, stored, and recovered — not how messages are encrypted.

## How identity flows through the SDK

```
your registration flow → derive/load 32-byte Ed25519 private key
                              ↓
                        storage.set('identity', hex)
                              ↓
                       MeshWhisper.init({ storage })
                              ↓
              SDK reads 'identity' key on every boot
                              ↓
            Same identity key → same peerId → same conversations
```

Two rules:

1. **Same Ed25519 private key → same peerId.** The X25519 routing key is deterministically derived from the Ed25519 key, so as long as you produce the same 32 bytes on each device boot, your conversations and contacts persist.
2. **Lose the key → lose the identity.** There's no recovery from the relay, by design. The relay never sees private keys. Whatever recovery story you want (password reset, phone-number reverification, passkey backup) lives in your registration code, not in the SDK.

## Pattern 1 — username + password (Prudence)

The simplest model. Used by Prudence, and probably what you want for a first prototype.

```ts
// src/crypto.ts
export async function deriveIdentityKey(username: string, password: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: enc.encode(`yourapp:${username}`),
      iterations: 600_000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

// At registration / login
const seed = await deriveIdentityKey(username, password);
await storage.set('identity', uint8ArrayToHex(seed));
// Then init the SDK — it'll read 'identity' from storage
```

**Pros**: zero infrastructure, instant recovery on any device (same username + password → same identity), no PII.

**Cons**: identity security = password strength. A weak password means a stealable identity. No defense if the user forgets the password — recovery is impossible.

**Use when**: prototyping, internal tools, apps where the user already has a password-management habit.

## Pattern 2 — email + verification code

Same shape as username/password but with email verification on first register, giving you a recovery channel.

```ts
// First-time registration
const verificationCode = await sendEmailCode(email);  // your SMTP / SES / SendGrid
const userInput = await promptForCode();
if (userInput !== verificationCode) throw new Error('Wrong code');

// Identity derived from email + a chosen password
const seed = await deriveIdentityKey(`${email}:${chosenPassword}`, 'yourapp:v1');
await storage.set('identity', uint8ArrayToHex(seed));

// On login from a new device — same email + password reproduces the key
```

**Pros**: email gives you a recovery channel for the password ("send reset link"), and proves real-user-ness.

**Cons**: now you have user PII (email addresses) and a verification-email cost. The recovery email itself can leak that this person uses your service.

**Use when**: consumer apps where email is the natural identifier, customer-service tools.

## Pattern 3 — phone number + SMS code

Like email, but with SMS as the verification channel. The SDK has no opinion; the app handles the SMS gateway.

```ts
const code = generateCode();
await twilio.messages.create({ body: `Your code: ${code}`, to: phone, from: ... });

// Bind identity to phone + a code (or PIN, or password)
const seed = await deriveIdentityKey(`${phone}:${enteredCode}`, 'yourapp:v1');
await storage.set('identity', uint8ArrayToHex(seed));
```

**Pros**: matches what WhatsApp/Signal users already expect; phone number is a reasonably strong unique identifier.

**Cons**: SMS costs ~$0.005-0.05 per send and depends on a third party (Twilio etc.). Phone numbers can be SIM-swapped — a known attack vector. Storing phone numbers is regulated in many jurisdictions.

**Use when**: consumer messaging apps, when you want a phone-number-first UX.

## Pattern 4 — random key + OS keychain

The most secure pattern that still supports easy device-to-device transfer. Generate the identity once with a CSPRNG, store it in the platform's secure storage.

```ts
// Browser (with WebAuthn-protected localStorage or just IDB behind passkey unlock)
let identityHex = await storage.get('identity');
if (!identityHex) {
  const key = crypto.getRandomValues(new Uint8Array(32));
  identityHex = uint8ArrayToHex(key);
  await storage.set('identity', identityHex);
}

// React Native (iOS Keychain / Android Keystore)
import * as Keychain from 'react-native-keychain';
const existing = await Keychain.getGenericPassword({ service: 'yourapp-identity' });
if (existing && existing.password) {
  await storage.set('identity', existing.password);
} else {
  const key = uint8ArrayToHex(randomBytes(32));
  await Keychain.setGenericPassword('identity', key, { service: 'yourapp-identity' });
  await storage.set('identity', key);
}
```

**Pros**: cryptographically strong (CSPRNG, never a low-entropy password). OS keychain protects against physical-device attacks. No PII collection.

**Cons**: no automatic cross-device recovery. The user has to **explicitly export** the identity (e.g. show a QR code containing the key) to set up a second device. Lose the device → lose the identity unless they exported.

**Use when**: privacy-focused apps, security-conscious users, anywhere device-to-device transfer can be a manual flow.

## Pattern 5 — hardware-backed (Secure Enclave / TPM)

The strongest pattern. The private key is generated *inside* the secure-element chip and **cannot be extracted** by anything, including malware that owns the OS.

```ts
// React Native — react-native-keychain with SECURE_HARDWARE
await Keychain.setGenericPassword('mw-identity', key, {
  accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_ANY_OR_DEVICE_PASSCODE,
  securityLevel: Keychain.SECURITY_LEVEL.SECURE_HARDWARE,
});
```

In a hardware-backed setup, you typically don't pass raw bytes through `storage.set('identity', ...)`. Instead, your StorageBackend's `get('identity')` is a proxy that triggers a biometric prompt and returns the unlocked key bytes only after user verification. This requires a small wrapper but no SDK changes.

**Pros**: malware on the device can't steal the identity. Biometric unlock is good UX.

**Cons**: **no multi-device transfer is possible** — the key literally cannot leave the chip. Users on a new device start a new identity unless you build a separate "linked device" handshake.

**Use when**: regulated-industry apps (healthcare, finance, government), high-threat threat models.

## Pattern 6 — passkey / WebAuthn

The modern web-native pattern. The browser holds a passkey; the passkey wraps an encryption key that decrypts the stored identity.

```ts
// First register
const credential = await navigator.credentials.create({
  publicKey: { rp: { name: 'YourApp' }, user: { ... }, challenge, pubKeyCredParams: [...] },
});
// Derive a wrapping key from the credential's public key material…
// …encrypt a freshly-generated identity with that wrapping key
// …store the ciphertext in IDB; the passkey unlocks it on each login

// On login
const assertion = await navigator.credentials.get({
  publicKey: { challenge, allowCredentials: [...], userVerification: 'required' },
});
// Use the assertion to derive the same wrapping key and decrypt the identity
```

**Pros**: completely passwordless, supports cross-device sync via iCloud Keychain / Google Password Manager / 1Password / etc. (the passkey ecosystem handles transfer).

**Cons**: the implementation is more involved than the others. Older browsers / OS versions lack support. Recovery story is "do you still have your passkey?" — which is the passkey ecosystem's problem, not yours.

**Use when**: modern web apps, when you want zero passwords and modern-cross-device UX.

## Choosing — a one-question decision tree

> Does your app need cross-device login from credentials a user remembers?

- **Yes, with low friction** → Pattern 1 (username + password) or Pattern 6 (passkey).
- **Yes, with a recovery channel** → Pattern 2 (email) or Pattern 3 (phone).
- **No, the device is the identity** → Pattern 4 (random + OS keychain) or Pattern 5 (hardware-backed).

## Hybrid models

Nothing stops you combining these. Common hybrids:

- **Password + hardware wrap**: derive a base key from password, then wrap it with a Secure-Enclave key — requires both the password AND the device.
- **Phone for first device, QR for additional devices**: register via Pattern 3, transfer to second devices via Pattern 4's QR-export flow.
- **Email for password reset, hardware-backed for storage**: identity exists in Secure Enclave; if device is lost, the email recovery flow creates a new identity (losing history, but recoverable account).

The SDK doesn't know or care which combination you pick. It just reads the `identity` key.

## What the SDK does NOT provide (intentionally)

- **No central user database.** No registration server, no email gateway, no SMS gateway. These are your app's concern; the SDK just consumes the resulting private key.
- **No "I forgot my password" flow.** The SDK has no concept of recovery. If the user can't reproduce the same 32 bytes, the identity is lost. Build recovery into your registration flow if you want it.
- **No identity-key rotation.** Once a peerId is established, it's stable. Rotating means losing the conversation graph. (If you need this, treat it as "create a new identity and explicitly migrate.")

These are deliberate — they keep the SDK protocol-agnostic and the relay PII-free. The flip side is: the parts that touch user-visible identity are your code, exactly so you can tailor them.

## Related

- [Getting started](getting-started.md) — quick walkthrough of using MeshWhisper with the default username+password (Prudence) pattern.
- [Prudence as SDK reference](../prudence/REFERENCE.md) — see Pattern 1 wired up end-to-end in `prudence/src/crypto.ts` and `App.tsx:handleRegister/handleLogin`.
- [API reference](api.md) — the `MeshWhisperConfig.storage` and `StorageBackend` interface that everything above relies on.
