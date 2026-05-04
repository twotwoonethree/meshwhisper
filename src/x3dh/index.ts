// ============================================================
// MeshWhisper SDK — X3DH / PQXDH Key Exchange Module
//
// Classical path:  X3DH (3 or 4 DH operations over X25519)
// Post-quantum:    PQXDH — X3DH + ML-KEM-768 encapsulation
//
// When Bob's PreKeyBundle includes a `pqPublicKey` (ML-KEM-768),
// Alice encapsulates to it and includes the ciphertext in her
// handshake envelope. The final shared secret mixes all X25519 DH
// outputs with the ML-KEM shared secret under a BLAKE3 domain
// separation context. This matches the hybrid approach used by
// Signal's PQXDH specification.
// ============================================================

import { x25519, ed25519 } from '@noble/curves/ed25519';
import { blake3 } from '@noble/hashes/blake3';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import type { KeyPair, IdentityKeyPair, DHKeyPair, PreKeyBundle } from '../types.js';

// --- Constants ---

/** Bundle version: classical X3DH only. */
const BUNDLE_VERSION_CLASSICAL = 0x01;

/** Bundle version: PQXDH (X3DH + ML-KEM-768). */
const BUNDLE_VERSION_PQXDH = 0x02;

/** X25519 / Ed25519 key length in bytes. */
const KEY_LENGTH = 32;

/** Ed25519 signature length in bytes. */
const SIGNATURE_LENGTH = 64;

/** ML-KEM-768 public key length in bytes. */
const PQ_PUBLIC_KEY_LENGTH = 1184;

/** ML-KEM-768 ciphertext length in bytes. */
export const PQ_CIPHERTEXT_LENGTH = 1088;

/** BLAKE3 domain-separation context for PQXDH key derivation. */
const PQXDH_KDF_CONTEXT = 'meshwhisper pqxdh v1 2026';

// --- Key Generation ---

export interface GeneratedPreKeyBundle {
  /** Public bundle to distribute (gossip or directory). */
  bundle: PreKeyBundle;
  /** X25519 signed pre-key pair. Store the private key. */
  signedPreKeyPair: DHKeyPair;
  /** X25519 one-time pre-key pair. Store the private key. */
  oneTimePreKeyPair: DHKeyPair;
  /** ML-KEM-768 secret key (2400 bytes). Store this to decapsulate. */
  pqSecretKey: Uint8Array;
}

/**
 * Generates a full PQXDH-capable PreKeyBundle for distribution to peers.
 *
 * Includes an ML-KEM-768 public key alongside the classical X25519 keys.
 * The caller must persist `signedPreKeyPair`, `oneTimePreKeyPair.privateKey`,
 * and `pqSecretKey` — all are required to complete an incoming handshake.
 */
export function generatePreKeyBundle(identityKeyPair: IdentityKeyPair | KeyPair): GeneratedPreKeyBundle {
  // Classical X25519 signed pre-key
  const signedPreKeyPrivate = x25519.utils.randomSecretKey();
  const signedPreKeyPublic = x25519.getPublicKey(signedPreKeyPrivate);
  const signature = ed25519.sign(signedPreKeyPublic, identityKeyPair.privateKey);

  // Classical X25519 one-time pre-key
  const oneTimePreKeyPrivate = x25519.utils.randomSecretKey();
  const oneTimePreKeyPublic = x25519.getPublicKey(oneTimePreKeyPrivate);

  // ML-KEM-768 post-quantum key pair
  const { publicKey: pqPublicKey, secretKey: pqSecretKey } = ml_kem768.keygen();

  return {
    bundle: {
      identityKey: identityKeyPair.publicKey,
      signedPreKey: signedPreKeyPublic,
      signedPreKeySignature: signature,
      oneTimePreKey: oneTimePreKeyPublic,
      pqPublicKey,
    },
    signedPreKeyPair: {
      publicKey: signedPreKeyPublic,
      privateKey: signedPreKeyPrivate,
      keyType: 'dh',
    },
    oneTimePreKeyPair: {
      publicKey: oneTimePreKeyPublic,
      privateKey: oneTimePreKeyPrivate,
      keyType: 'dh',
    },
    pqSecretKey,
  };
}

/**
 * Generates a batch of one-time pre-keys for replenishment.
 * Returns full KeyPairs — caller must store the private keys.
 */
export function generateOneTimePreKeys(
  _identityKeyPair: IdentityKeyPair | KeyPair,
  count: number,
): DHKeyPair[] {
  if (count < 0 || !Number.isInteger(count)) {
    throw new Error('count must be a non-negative integer');
  }
  const keys: DHKeyPair[] = [];
  for (let i = 0; i < count; i++) {
    const privateKey = x25519.utils.randomSecretKey();
    keys.push({ privateKey, publicKey: x25519.getPublicKey(privateKey), keyType: 'dh' });
  }
  return keys;
}

// --- Key Exchange: Initiator (Alice) ---

export interface KeyExchangeResult {
  /** Derived shared secret. */
  sharedSecret: Uint8Array;
  /** Ephemeral X25519 public key Alice used — must be sent to Bob. */
  ephemeralPublicKey: Uint8Array;
  /** Whether a one-time pre-key was consumed. */
  usedOneTimePreKey: boolean;
  /**
   * ML-KEM-768 ciphertext (1088 bytes). Present when Bob's bundle had a
   * `pqPublicKey`. Alice must include this in the handshake envelope so
   * Bob can decapsulate to recover the same shared secret.
   */
  pqCiphertext?: Uint8Array;
}

/**
 * Performs the initiator (Alice) side of X3DH or PQXDH.
 *
 * Classical DH operations:
 *   DH1 = DH(IK_A, SPK_B)
 *   DH2 = DH(EK_A, IK_B)
 *   DH3 = DH(EK_A, SPK_B)
 *   DH4 = DH(EK_A, OPK_B)  — optional
 *
 * If Bob's bundle has a `pqPublicKey`, additionally:
 *   PQ  = ML-KEM-768 encapsulate(pqPublicKey) → (ciphertext, pq_ss)
 *
 * Shared secret derivation:
 *   Classical: BLAKE3(DH1 || DH2 || DH3 [|| DH4])
 *   PQXDH:    BLAKE3(DH1 || DH2 || DH3 [|| DH4] || pq_ss,
 *                    context: "meshwhisper pqxdh v1 2026")
 */
export function initiateKeyExchange(
  aliceIdentity: KeyPair,
  bobPreKeyBundle: PreKeyBundle,
): KeyExchangeResult {
  if (!verifyPreKeyBundle(bobPreKeyBundle)) {
    throw new Error('Invalid pre-key bundle: signed pre-key signature verification failed');
  }

  const aliceIdentityX25519Private = ed25519.utils.toMontgomerySecret(aliceIdentity.privateKey);
  const bobIdentityX25519Public = ed25519.utils.toMontgomery(bobPreKeyBundle.identityKey);

  const ephemeralPrivate = x25519.utils.randomSecretKey();
  const ephemeralPublic = x25519.getPublicKey(ephemeralPrivate);

  const dh1 = x25519.getSharedSecret(aliceIdentityX25519Private, bobPreKeyBundle.signedPreKey);
  const dh2 = x25519.getSharedSecret(ephemeralPrivate, bobIdentityX25519Public);
  const dh3 = x25519.getSharedSecret(ephemeralPrivate, bobPreKeyBundle.signedPreKey);

  const usedOneTimePreKey = bobPreKeyBundle.oneTimePreKey != null;
  const dhParts: Uint8Array[] = [dh1, dh2, dh3];
  if (usedOneTimePreKey) {
    dhParts.push(x25519.getSharedSecret(ephemeralPrivate, bobPreKeyBundle.oneTimePreKey!));
  }

  // PQXDH: encapsulate if Bob published a ML-KEM-768 public key
  if (bobPreKeyBundle.pqPublicKey) {
    const { cipherText, sharedSecret: pqSS } = ml_kem768.encapsulate(bobPreKeyBundle.pqPublicKey);
    dhParts.push(pqSS);
    const sharedSecret = blake3(concatBytes(...dhParts), { context: PQXDH_KDF_CONTEXT });
    return { sharedSecret, ephemeralPublicKey: ephemeralPublic, usedOneTimePreKey, pqCiphertext: cipherText };
  }

  // Classical fallback
  const sharedSecret = blake3(concatBytes(...dhParts));
  return { sharedSecret, ephemeralPublicKey: ephemeralPublic, usedOneTimePreKey };
}

// --- Key Exchange: Responder (Bob) ---

/**
 * Performs the responder (Bob) side of X3DH or PQXDH.
 *
 * If `pqCiphertext` and `pqSecretKey` are provided, decapsulates the
 * ML-KEM ciphertext and mixes the result into the shared secret using
 * the same PQXDH KDF. Must match the path Alice took.
 */
export function completeKeyExchange(
  bobIdentity: KeyPair,
  bobSignedPreKey: KeyPair,
  bobOneTimePreKey: KeyPair | null,
  aliceIdentityKey: Uint8Array,
  aliceEphemeralKey: Uint8Array,
  pqCiphertext?: Uint8Array,
  pqSecretKey?: Uint8Array,
): Uint8Array {
  const aliceIdentityX25519Public = ed25519.utils.toMontgomery(aliceIdentityKey);
  const bobIdentityX25519Private = ed25519.utils.toMontgomerySecret(bobIdentity.privateKey);

  const dh1 = x25519.getSharedSecret(bobSignedPreKey.privateKey, aliceIdentityX25519Public);
  const dh2 = x25519.getSharedSecret(bobIdentityX25519Private, aliceEphemeralKey);
  const dh3 = x25519.getSharedSecret(bobSignedPreKey.privateKey, aliceEphemeralKey);

  const dhParts: Uint8Array[] = [dh1, dh2, dh3];
  if (bobOneTimePreKey != null) {
    dhParts.push(x25519.getSharedSecret(bobOneTimePreKey.privateKey, aliceEphemeralKey));
  }

  // PQXDH: decapsulate if Alice sent a ciphertext and Bob has his secret key
  if (pqCiphertext && pqSecretKey) {
    const pqSS = ml_kem768.decapsulate(pqCiphertext, pqSecretKey);
    dhParts.push(pqSS);
    return blake3(concatBytes(...dhParts), { context: PQXDH_KDF_CONTEXT });
  }

  return blake3(concatBytes(...dhParts));
}

// --- PreKey Bundle Verification ---

export function verifyPreKeyBundle(bundle: PreKeyBundle): boolean {
  try {
    return ed25519.verify(
      bundle.signedPreKeySignature,
      bundle.signedPreKey,
      bundle.identityKey,
    );
  } catch {
    return false;
  }
}

// --- Serialization ---

/**
 * Serializes a PreKeyBundle to binary.
 *
 * Version 0x01 (classical):
 *   [version: 1] [flags: 1] [ik: 32] [spk: 32] [sig: 64] [opk?: 32]
 *
 * Version 0x02 (PQXDH):
 *   [version: 1] [flags: 1] [ik: 32] [spk: 32] [sig: 64] [pq: 1184] [opk?: 32]
 *
 * flags bit 0: hasOneTimePreKey
 */
export function serializePreKeyBundle(bundle: PreKeyBundle): Uint8Array {
  const hasPQ = bundle.pqPublicKey != null;
  const hasOPK = bundle.oneTimePreKey != null;
  const version = hasPQ ? BUNDLE_VERSION_PQXDH : BUNDLE_VERSION_CLASSICAL;
  const flags = hasOPK ? 0x01 : 0x00;

  const size =
    1 + 1 +
    KEY_LENGTH + KEY_LENGTH + SIGNATURE_LENGTH +
    (hasPQ ? PQ_PUBLIC_KEY_LENGTH : 0) +
    (hasOPK ? KEY_LENGTH : 0);

  const data = new Uint8Array(size);
  let off = 0;

  data[off++] = version;
  data[off++] = flags;
  data.set(bundle.identityKey, off); off += KEY_LENGTH;
  data.set(bundle.signedPreKey, off); off += KEY_LENGTH;
  data.set(bundle.signedPreKeySignature, off); off += SIGNATURE_LENGTH;
  if (hasPQ) { data.set(bundle.pqPublicKey!, off); off += PQ_PUBLIC_KEY_LENGTH; }
  if (hasOPK) { data.set(bundle.oneTimePreKey!, off); }

  return data;
}

export function deserializePreKeyBundle(data: Uint8Array): PreKeyBundle {
  if (data.length < 2) throw new Error('PreKeyBundle data too short: missing header');

  let off = 0;
  const version = data[off++];
  if (version !== BUNDLE_VERSION_CLASSICAL && version !== BUNDLE_VERSION_PQXDH) {
    throw new Error(`Unsupported PreKeyBundle version: ${version}`);
  }

  const flags = data[off++];
  const hasOPK = (flags & 0x01) !== 0;
  const hasPQ = version === BUNDLE_VERSION_PQXDH;

  const expected =
    1 + 1 +
    KEY_LENGTH + KEY_LENGTH + SIGNATURE_LENGTH +
    (hasPQ ? PQ_PUBLIC_KEY_LENGTH : 0) +
    (hasOPK ? KEY_LENGTH : 0);

  if (data.length < expected) {
    throw new Error(`PreKeyBundle data too short: expected ${expected} bytes, got ${data.length}`);
  }

  const identityKey = data.slice(off, off + KEY_LENGTH); off += KEY_LENGTH;
  const signedPreKey = data.slice(off, off + KEY_LENGTH); off += KEY_LENGTH;
  const signedPreKeySignature = data.slice(off, off + SIGNATURE_LENGTH); off += SIGNATURE_LENGTH;

  let pqPublicKey: Uint8Array | undefined;
  if (hasPQ) {
    pqPublicKey = data.slice(off, off + PQ_PUBLIC_KEY_LENGTH);
    off += PQ_PUBLIC_KEY_LENGTH;
  }

  const oneTimePreKey = hasOPK ? data.slice(off, off + KEY_LENGTH) : undefined;

  return { identityKey, signedPreKey, signedPreKeySignature, oneTimePreKey, pqPublicKey };
}

// --- Utility ---

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}
