# MeshWhisper PQ3 Ratchet — Implementation Spec

**Status:** Specified, not yet implemented  
**Target:** Level 3 post-quantum security (matches Apple iMessage PQ3 security class)  
**Prerequisite:** PQXDH session establishment (already implemented in `src/x3dh/index.ts`)

---

## What This Is

PQXDH protects session establishment against "harvest now, decrypt later" attacks — an adversary recording ciphertext today and decrypting it with a future quantum computer. That's Level 2.

PQ3 adds periodic ML-KEM injection into the Double Ratchet itself. Even if an adversary compromises the ratchet state mid-conversation, forward secrecy is restored at the next KEM injection point. This is Level 3: post-quantum healing within a live session.

Signal is Level 2. Apple iMessage is Level 3. Implementing this would make MeshWhisper one of the only open-source SDKs at Level 3.

---

## How It Works

### Core Mechanism

The standard Double Ratchet advances via DH ratchet steps — each side advertises a new X25519 public key, the other side uses it, and the root key advances. PQ3 adds a parallel KEM ratchet: periodically, one side advertises an ML-KEM-768 public key alongside its DH key. The receiving side encapsulates to it, sends back the ciphertext, and both sides mix the KEM shared secret into the root key derivation.

### Trigger Conditions

A KEM injection is triggered when either:
- **Message counter:** the local send counter reaches a multiple of 50 (configurable), OR
- **Time elapsed:** 24 hours have passed since the last KEM injection

The time trigger exists because P2P conversations can go dormant for days. Without it, an infrequent conversation might never trigger a counter-based injection.

### Who Does What

Unlike Apple's client-server model (where only the client advertises), MeshWhisper is symmetric — either peer can trigger a re-key. Both peers maintain independent trigger counters. This means both can trigger simultaneously (see Collision Handling below).

**Advertising side (Alice):**
1. Generates a new ML-KEM-768 key pair
2. Stores the secret key as `pendingPqSecretKey`
3. Includes the public key (`pqRatchetPublicKey`, 1184 bytes) in the next outbound message header
4. Continues using the old ratchet state until the other side responds

**Responding side (Bob):**
1. Sees `pqRatchetPublicKey` in Alice's message header
2. Encapsulates to it: `{ cipherText, sharedSecret } = ml_kem768.encapsulate(pqRatchetPublicKey)`
3. Includes `pqRatchetCiphertext` (1088 bytes) in next outbound message header
4. Immediately mixes `sharedSecret` into root key derivation

**Alice completing the injection:**
1. Sees `pqRatchetCiphertext` in Bob's message header
2. Decapsulates: `sharedSecret = ml_kem768.decapsulate(pqRatchetCiphertext, pendingPqSecretKey)`
3. Mixes `sharedSecret` into root key derivation
4. Clears `pendingPqSecretKey`

### KDF for Root Key Update

When a KEM shared secret is available during a DH ratchet step, replace the standard ratchet KDF:

```
Standard:  (RK', CK) = KDF_RK(RK, DH_output)
PQ3:       (RK', CK) = KDF_RK_PQ(RK, DH_output, PQ_output)
```

Where:

```
KDF_RK_PQ(RK, DH_output, PQ_output) =
  BLAKE3(RK || DH_output || PQ_output, context: "meshwhisper pq3 ratchet v1 2026")
```

The domain separation context ensures the PQ3 KDF output is distinct from the PQXDH session KDF (`"meshwhisper pqxdh v1 2026"`).

---

## State Additions

Each ratchet session (`RatchetSession` in `src/ratchet/`) gains:

```typescript
// Outbound: KEM key we are advertising
pqRatchetPublicKey: Uint8Array | null;       // 1184 bytes, the key we advertised
pqRatchetSecretKey: Uint8Array | null;       // 2400 bytes, to decapsulate the response

// Inbound: ciphertext we received, pending mix into root key
pendingPqCiphertext: Uint8Array | null;      // 1088 bytes

// Trigger tracking
messagesSinceLastPqInject: number;           // reset to 0 on each injection
lastPqInjectTimestamp: number;               // ms since epoch

// Peer's advertised key (we need to encapsulate to this)
peerPqRatchetPublicKey: Uint8Array | null;   // 1184 bytes
```

---

## Message Header Changes

Extended ratchet header wire format (replaces current 40-byte header in `src/sdk/utils.ts`):

```
[32 bytes]  dhPublicKey
[4 bytes]   previousChainLength (BE uint32)
[4 bytes]   messageNumber (BE uint32)
[1 byte]    pqFlags
  bit 0: hasPqPublicKey    (advertising new KEM key, 1184 bytes follow)
  bit 1: hasPqCiphertext   (responding to peer's KEM key, 1088 bytes follow)
[0 or 1184 bytes]  pqRatchetPublicKey   (if bit 0 set)
[0 or 1088 bytes]  pqRatchetCiphertext  (if bit 1 set)
```

Both bits can be set simultaneously (advertising a new key while also responding to the peer's).

Minimum header size: 41 bytes (40 existing + 1 flags byte, no PQ data)  
With public key only: 1225 bytes  
With ciphertext only: 1129 bytes  
With both: 2313 bytes (rare — only during simultaneous re-key)

---

## Collision Handling

Both peers can trigger a re-key in the same window. This is not a problem:

- Alice advertises `pqRatchetPublicKey_A` at message 50
- Bob advertises `pqRatchetPublicKey_B` at his message 50
- Alice encapsulates to Bob's key; Bob encapsulates to Alice's key
- Both injections succeed independently
- Both sides advance their root key twice (once per injection, in receive order)

No special coordination is required. The state machine handles each injection independently.

---

## Out-of-Order Delivery

P2P mesh delivery is unreliable and unordered. A message carrying `pqRatchetPublicKey` may arrive late or not at all.

Handling strategy (mirrors Double Ratchet's skipped-key cache):

1. When a `pqRatchetPublicKey` arrives out of order (message number gap), buffer the key indexed by the sender's DH ratchet key and message number.
2. When the gap is filled (earlier messages arrive), process buffered KEM keys in order.
3. If the advertising peer sends a second `pqRatchetPublicKey` before receiving a response (e.g., after 24h time trigger fires again), the new key supersedes the old one. Respond only to the most recent.
4. Cap the KEM key buffer at 10 entries per session to bound memory.

If a `pqRatchetPublicKey` is permanently lost (peer never receives the encapsulation), the injection simply doesn't happen for that cycle. The session continues with DH-only ratchet steps — degrading gracefully to Level 2 for that window, then attempting again at the next trigger.

---

## Packet Size Impact

| Scenario | Extra bytes per message |
|---|---|
| No PQ data (most messages) | 1 (flags byte) |
| Advertising KEM public key | 1185 |
| Responding with ciphertext | 1089 |
| Both (simultaneous re-key) | 2273 |
| Average at 50-msg trigger cadence | ~46 bytes/message |

The 1184-byte advertisement burst happens approximately every 50 messages or every 24 hours, whichever comes first. On typical mobile data this is imperceptible.

---

## Implementation Notes

### Files to Modify

- `src/ratchet/index.ts` — extend `RatchetState`, update `ratchetEncrypt` / `ratchetDecrypt`, add KDF_RK_PQ
- `src/sdk/utils.ts` — extend `serializeRatchetHeader` / `deserializeRatchetHeader` for PQ fields
- `src/sdk/session-manager.ts` — add trigger logic (counter + timer), persist new PQ ratchet state fields
- `src/types.ts` — extend `RatchetHeader` interface

### Test Coverage Required

The following scenarios must be covered before shipping:

1. Full round-trip: Alice triggers injection, Bob responds, both derive same root key
2. Bob triggers injection, Alice responds — symmetric case
3. Simultaneous injection — both sides trigger in same window
4. Out-of-order: injection message arrives after subsequent messages
5. Lost injection: encapsulation response never arrives — session continues
6. Dormancy trigger: 24h elapsed, first message carries KEM public key
7. Wrong ciphertext: decapsulation produces wrong secret, secrets diverge
8. Buffer cap: >10 buffered KEM keys, oldest evicted

### What to Avoid

- Do not require both sides to agree on a trigger schedule — each peer triggers independently
- Do not block message sending while waiting for a KEM response — sending continues immediately after advertising
- Do not use the same BLAKE3 context string as PQXDH session establishment

---

## Security Level Mapping

| Level | What's Protected | MeshWhisper Status |
|---|---|---|
| 1 | Classical encryption (AES/ChaCha) | Done |
| 2 | PQ at session establishment (PQXDH) | Done — `src/x3dh/index.ts` |
| 3 | PQ healing within live session (this spec) | Specified, not implemented |

---

## References

- [Apple iMessage PQ3 blog post](https://security.apple.com/blog/imessage-pq3/) — the client-server version of this idea
- [Signal PQXDH specification](https://signal.org/docs/specifications/pqxdh/)
- [NIST ML-KEM (FIPS 203)](https://csrc.nist.gov/pubs/fips/203/final)
- `@noble/post-quantum` v0.6.1 — `ml_kem768` implementation used throughout
