// ============================================================
// MeshWhisper SDK — X3DH Key Exchange Module
// Extended Triple Diffie-Hellman adapted for serverless P2P
// ============================================================

import { x25519, ed25519 } from '@noble/curves/ed25519';
import { blake3 } from '@noble/hashes/blake3';
import type { KeyPair, PreKeyBundle } from '../types.js';

// --- Constants ---

/** Protocol version for serialized pre-key bundles. */
const BUNDLE_VERSION = 0x01;

/** Length of an X25519/Ed25519 public key in bytes. */
const KEY_LENGTH = 32;

/** Length of an Ed25519 signature in bytes. */
const SIGNATURE_LENGTH = 64;

// --- Key Generation ---

/**
 * Generates a full PreKeyBundle for distribution to peers.
 *
 * The bundle contains:
 * - Identity key (Ed25519 public key from the provided key pair)
 * - Signed pre-key (X25519, signed by the identity key)
 * - One-time pre-key (X25519, single-use)
 *
 * @param identityKeyPair - Ed25519 identity key pair
 * @returns A complete PreKeyBundle ready for gossip distribution
 */
export function generatePreKeyBundle(identityKeyPair: KeyPair): PreKeyBundle {
  // Generate signed pre-key (X25519)
  const signedPreKeyPrivate = x25519.utils.randomSecretKey();
  const signedPreKeyPublic = x25519.getPublicKey(signedPreKeyPrivate);

  // Sign the signed pre-key's public key with the Ed25519 identity key
  const signature = ed25519.sign(signedPreKeyPublic, identityKeyPair.privateKey);

  // Generate one-time pre-key (X25519)
  const oneTimePreKeyPrivate = x25519.utils.randomSecretKey();
  const oneTimePreKeyPublic = x25519.getPublicKey(oneTimePreKeyPrivate);

  return {
    identityKey: identityKeyPair.publicKey,
    signedPreKey: signedPreKeyPublic,
    signedPreKeySignature: signature,
    oneTimePreKey: oneTimePreKeyPublic,
  };
}

/**
 * Generates a batch of one-time pre-keys for replenishment.
 *
 * Each returned Uint8Array is an X25519 public key. The caller is responsible
 * for storing the corresponding private keys (derivable from the returned
 * key material via x25519.getPublicKey).
 *
 * @param identityKeyPair - Ed25519 identity key pair (unused but kept for API consistency)
 * @param count - Number of one-time pre-keys to generate
 * @returns Array of X25519 public keys
 */
export function generateOneTimePreKeys(
  _identityKeyPair: KeyPair,
  count: number,
): Uint8Array[] {
  if (count < 0 || !Number.isInteger(count)) {
    throw new Error('count must be a non-negative integer');
  }

  const keys: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const privateKey = x25519.utils.randomSecretKey();
    keys.push(x25519.getPublicKey(privateKey));
  }
  return keys;
}

// --- Key Exchange: Initiator (Alice) ---

export interface KeyExchangeResult {
  /** Derived shared secret (BLAKE3 hash of concatenated DH outputs). */
  sharedSecret: Uint8Array;
  /** Ephemeral X25519 public key Alice used — must be sent to Bob. */
  ephemeralPublicKey: Uint8Array;
  /** Whether a one-time pre-key was consumed in the exchange. */
  usedOneTimePreKey: boolean;
}

/**
 * Performs the initiator side (Alice) of the X3DH key exchange.
 *
 * Executes 3 or 4 DH operations:
 *   DH1 = DH(IK_A, SPK_B) — Alice's identity key with Bob's signed pre-key
 *   DH2 = DH(EK_A, IK_B)  — Alice's ephemeral key with Bob's identity key
 *   DH3 = DH(EK_A, SPK_B) — Alice's ephemeral key with Bob's signed pre-key
 *   DH4 = DH(EK_A, OPK_B) — Alice's ephemeral key with Bob's one-time pre-key (optional)
 *
 * The shared secret is derived as BLAKE3(DH1 || DH2 || DH3 [|| DH4]).
 *
 * @param aliceIdentity - Alice's Ed25519 identity key pair
 * @param bobPreKeyBundle - Bob's published PreKeyBundle
 * @returns The derived shared secret, ephemeral public key, and OPK usage flag
 * @throws If the pre-key bundle signature is invalid
 */
export function initiateKeyExchange(
  aliceIdentity: KeyPair,
  bobPreKeyBundle: PreKeyBundle,
): KeyExchangeResult {
  // Verify Bob's signed pre-key before proceeding
  if (!verifyPreKeyBundle(bobPreKeyBundle)) {
    throw new Error('Invalid pre-key bundle: signed pre-key signature verification failed');
  }

  // Convert Alice's Ed25519 identity key to X25519 for DH operations
  const aliceIdentityX25519Private = ed25519.utils.toMontgomerySecret(aliceIdentity.privateKey);

  // Convert Bob's Ed25519 identity public key to X25519
  const bobIdentityX25519Public = ed25519.utils.toMontgomery(bobPreKeyBundle.identityKey);

  // Generate Alice's ephemeral X25519 key pair
  const ephemeralPrivate = x25519.utils.randomSecretKey();
  const ephemeralPublic = x25519.getPublicKey(ephemeralPrivate);

  // DH1: DH(IK_A, SPK_B)
  const dh1 = x25519.getSharedSecret(aliceIdentityX25519Private, bobPreKeyBundle.signedPreKey);

  // DH2: DH(EK_A, IK_B)
  const dh2 = x25519.getSharedSecret(ephemeralPrivate, bobIdentityX25519Public);

  // DH3: DH(EK_A, SPK_B)
  const dh3 = x25519.getSharedSecret(ephemeralPrivate, bobPreKeyBundle.signedPreKey);

  // DH4: DH(EK_A, OPK_B) — optional
  const usedOneTimePreKey = bobPreKeyBundle.oneTimePreKey != null;
  let dhConcat: Uint8Array;

  if (usedOneTimePreKey) {
    const dh4 = x25519.getSharedSecret(ephemeralPrivate, bobPreKeyBundle.oneTimePreKey!);
    dhConcat = concatBytes(dh1, dh2, dh3, dh4);
  } else {
    dhConcat = concatBytes(dh1, dh2, dh3);
  }

  // Derive shared secret via BLAKE3
  const sharedSecret = blake3(dhConcat);

  return {
    sharedSecret,
    ephemeralPublicKey: ephemeralPublic,
    usedOneTimePreKey,
  };
}

// --- Key Exchange: Responder (Bob) ---

/**
 * Performs the responder side (Bob) of the X3DH key exchange.
 *
 * Mirrors the initiator's DH operations to derive the same shared secret:
 *   DH1 = DH(SPK_B, IK_A) — Bob's signed pre-key with Alice's identity key
 *   DH2 = DH(IK_B, EK_A)  — Bob's identity key with Alice's ephemeral key
 *   DH3 = DH(SPK_B, EK_A) — Bob's signed pre-key with Alice's ephemeral key
 *   DH4 = DH(OPK_B, EK_A) — Bob's one-time pre-key with Alice's ephemeral key (optional)
 *
 * @param bobIdentity - Bob's Ed25519 identity key pair
 * @param bobSignedPreKey - Bob's X25519 signed pre-key pair
 * @param bobOneTimePreKey - Bob's X25519 one-time pre-key pair (null if not used)
 * @param aliceIdentityKey - Alice's Ed25519 identity public key
 * @param aliceEphemeralKey - Alice's X25519 ephemeral public key
 * @returns The derived shared secret (same as Alice's if inputs are correct)
 */
export function completeKeyExchange(
  bobIdentity: KeyPair,
  bobSignedPreKey: KeyPair,
  bobOneTimePreKey: KeyPair | null,
  aliceIdentityKey: Uint8Array,
  aliceEphemeralKey: Uint8Array,
): Uint8Array {
  // Convert Alice's Ed25519 identity public key to X25519
  const aliceIdentityX25519Public = ed25519.utils.toMontgomery(aliceIdentityKey);

  // Convert Bob's Ed25519 identity key to X25519
  const bobIdentityX25519Private = ed25519.utils.toMontgomerySecret(bobIdentity.privateKey);

  // DH1: DH(SPK_B, IK_A) — mirrors Alice's DH(IK_A, SPK_B)
  const dh1 = x25519.getSharedSecret(bobSignedPreKey.privateKey, aliceIdentityX25519Public);

  // DH2: DH(IK_B, EK_A) — mirrors Alice's DH(EK_A, IK_B)
  const dh2 = x25519.getSharedSecret(bobIdentityX25519Private, aliceEphemeralKey);

  // DH3: DH(SPK_B, EK_A) — mirrors Alice's DH(EK_A, SPK_B)
  const dh3 = x25519.getSharedSecret(bobSignedPreKey.privateKey, aliceEphemeralKey);

  // DH4: DH(OPK_B, EK_A) — optional
  let dhConcat: Uint8Array;

  if (bobOneTimePreKey != null) {
    const dh4 = x25519.getSharedSecret(bobOneTimePreKey.privateKey, aliceEphemeralKey);
    dhConcat = concatBytes(dh1, dh2, dh3, dh4);
  } else {
    dhConcat = concatBytes(dh1, dh2, dh3);
  }

  // Derive shared secret via BLAKE3
  return blake3(dhConcat);
}

// --- PreKey Bundle Verification ---

/**
 * Verifies the signed pre-key signature in a PreKeyBundle.
 *
 * Checks that the signedPreKey was signed by the holder of the identityKey
 * using Ed25519.
 *
 * @param bundle - The PreKeyBundle to verify
 * @returns true if the signature is valid, false otherwise
 */
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
 * Serializes a PreKeyBundle to a compact binary format for gossip distribution.
 *
 * Wire format:
 *   [version: 1 byte]
 *   [flags: 1 byte]       — bit 0: hasOneTimePreKey
 *   [identityKey: 32 bytes]
 *   [signedPreKey: 32 bytes]
 *   [signedPreKeySignature: 64 bytes]
 *   [oneTimePreKey: 32 bytes]  — optional, present if flags bit 0 is set
 *
 * Total: 130 bytes without OPK, 162 bytes with OPK.
 *
 * @param bundle - The PreKeyBundle to serialize
 * @returns Serialized binary representation
 */
export function serializePreKeyBundle(bundle: PreKeyBundle): Uint8Array {
  const hasOPK = bundle.oneTimePreKey != null;
  const flags = hasOPK ? 0x01 : 0x00;
  const totalLength = 1 + 1 + KEY_LENGTH + KEY_LENGTH + SIGNATURE_LENGTH + (hasOPK ? KEY_LENGTH : 0);

  const data = new Uint8Array(totalLength);
  let offset = 0;

  // Version
  data[offset++] = BUNDLE_VERSION;

  // Flags
  data[offset++] = flags;

  // Identity key
  data.set(bundle.identityKey, offset);
  offset += KEY_LENGTH;

  // Signed pre-key
  data.set(bundle.signedPreKey, offset);
  offset += KEY_LENGTH;

  // Signed pre-key signature
  data.set(bundle.signedPreKeySignature, offset);
  offset += SIGNATURE_LENGTH;

  // One-time pre-key (optional)
  if (hasOPK) {
    data.set(bundle.oneTimePreKey!, offset);
  }

  return data;
}

/**
 * Deserializes a PreKeyBundle from its binary representation.
 *
 * @param data - Serialized PreKeyBundle bytes
 * @returns The deserialized PreKeyBundle
 * @throws If the data is malformed or has an unsupported version
 */
export function deserializePreKeyBundle(data: Uint8Array): PreKeyBundle {
  if (data.length < 2) {
    throw new Error('PreKeyBundle data too short: missing header');
  }

  let offset = 0;

  // Version
  const version = data[offset++];
  if (version !== BUNDLE_VERSION) {
    throw new Error(`Unsupported PreKeyBundle version: ${version}`);
  }

  // Flags
  const flags = data[offset++];
  const hasOPK = (flags & 0x01) !== 0;

  const expectedLength = 1 + 1 + KEY_LENGTH + KEY_LENGTH + SIGNATURE_LENGTH + (hasOPK ? KEY_LENGTH : 0);
  if (data.length < expectedLength) {
    throw new Error(
      `PreKeyBundle data too short: expected ${expectedLength} bytes, got ${data.length}`,
    );
  }

  // Identity key
  const identityKey = data.slice(offset, offset + KEY_LENGTH);
  offset += KEY_LENGTH;

  // Signed pre-key
  const signedPreKey = data.slice(offset, offset + KEY_LENGTH);
  offset += KEY_LENGTH;

  // Signed pre-key signature
  const signedPreKeySignature = data.slice(offset, offset + SIGNATURE_LENGTH);
  offset += SIGNATURE_LENGTH;

  // One-time pre-key (optional)
  const oneTimePreKey = hasOPK
    ? data.slice(offset, offset + KEY_LENGTH)
    : undefined;

  return {
    identityKey,
    signedPreKey,
    signedPreKeySignature,
    oneTimePreKey,
  };
}

// --- Utility ---

/**
 * Concatenates multiple Uint8Arrays into a single Uint8Array.
 */
function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let totalLength = 0;
  for (const arr of arrays) {
    totalLength += arr.length;
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
