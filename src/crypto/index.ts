// ============================================================
// MeshWhisper SDK — Crypto Primitives
// BLAKE3 hashing, X25519 key exchange, AES-256-GCM encryption,
// BLAKE3-based KDF, and utilities.
// ============================================================

import { blake3 } from '@noble/hashes/blake3';
import { randomBytes as nobleRandomBytes } from '@noble/hashes/utils';
import { x25519 } from '@noble/curves/ed25519';
import { gcm } from '@noble/ciphers/aes';
import type { KeyPair, EncryptedPayload } from '../types.js';

// ---- Constants ----

/** AES-GCM nonce length in bytes (96-bit). */
const GCM_NONCE_LENGTH = 12;

/** AES-GCM authentication tag length in bytes. */
const GCM_TAG_LENGTH = 16;

/** DestHash truncation length in bytes. */
const DEST_HASH_LENGTH = 8;

/** Default KDF output length in bytes. */
const DEFAULT_KDF_LENGTH = 32;

// ---- Utilities ----

/**
 * Returns the current epoch hour: floor(Date.now() / 3_600_000).
 * Used for hourly destHash rotation.
 */
export function getCurrentEpochHour(): number {
  return Math.floor(Date.now() / 3_600_000);
}

/**
 * Generates cryptographically secure random bytes.
 */
export function randomBytes(length: number): Uint8Array {
  return nobleRandomBytes(length);
}

/**
 * Concatenates multiple Uint8Arrays into a single Uint8Array.
 */
export function concat(...arrays: Uint8Array[]): Uint8Array {
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

// ---- BLAKE3 Hashing ----

/**
 * General-purpose BLAKE3 hash. Returns 32-byte digest.
 */
export function hash(data: Uint8Array): Uint8Array {
  return blake3(data);
}

/**
 * Derives a 256-bit namespace ID via BLAKE3(appBundleId || developerPublicKey).
 * The namespace isolates different applications sharing the same mesh.
 * Deterministic — no salt — so the same app always produces the same namespace ID.
 */
export function deriveNamespaceId(
  appBundleId: string,
  developerPublicKey: Uint8Array,
): Uint8Array {
  const encoder = new TextEncoder();
  const appBytes = encoder.encode(appBundleId);
  const input = concat(appBytes, developerPublicKey);
  return blake3(input);
}

/**
 * Derives a truncated 8-byte destination hash via
 * BLAKE3(namespaceId || recipientPublicKey || epochHour).
 *
 * Including the namespace in the hash means a packet for Bob in AppA has a
 * different dest_hash than a packet for Bob in AppB, giving namespace isolation
 * as a property of routing rather than a policy check.
 * Rotates every hour to limit long-term linkability.
 */
export function deriveDestHash(
  namespaceId: Uint8Array,
  recipientPublicKey: Uint8Array,
  epochHour: number,
): Uint8Array {
  // Encode epochHour as 8-byte big-endian uint64
  const epochBytes = new Uint8Array(8);
  const view = new DataView(epochBytes.buffer);
  view.setUint32(0, Math.floor(epochHour / 0x100000000), false);
  view.setUint32(4, epochHour >>> 0, false);

  const input = concat(namespaceId, recipientPublicKey, epochBytes);
  const fullHash = blake3(input);
  return fullHash.slice(0, DEST_HASH_LENGTH);
}

// ---- X25519 Key Exchange ----

/**
 * Generates a long-lived X25519 identity key pair.
 */
export function generateKeyPair(): KeyPair {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

/**
 * Generates an ephemeral X25519 key pair for single-use key agreement.
 * Functionally identical to generateKeyPair but semantically distinct:
 * ephemeral keys should be discarded after use.
 */
export function generateEphemeralKeyPair(): KeyPair {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

/**
 * Computes an X25519 shared secret from a private key and a peer's public key.
 * Returns a 32-byte shared secret suitable for key derivation.
 */
export function computeSharedSecret(
  privateKey: Uint8Array,
  publicKey: Uint8Array,
): Uint8Array {
  return x25519.getSharedSecret(privateKey, publicKey);
}

// ---- AES-256-GCM Encryption ----

/**
 * Encrypts plaintext with AES-256-GCM using a random 12-byte nonce.
 * The key must be exactly 32 bytes.
 *
 * Returns ciphertext, nonce, and authentication tag as separate fields.
 */
export function encrypt(
  plaintext: Uint8Array,
  key: Uint8Array,
): EncryptedPayload {
  const nonce = randomBytes(GCM_NONCE_LENGTH);
  const cipher = gcm(key, nonce);
  const sealed = cipher.encrypt(plaintext);

  // noble/ciphers GCM appends the 16-byte tag to the ciphertext
  const ciphertext = sealed.slice(0, sealed.length - GCM_TAG_LENGTH);
  const tag = sealed.slice(sealed.length - GCM_TAG_LENGTH);

  return { ciphertext, nonce, tag };
}

/**
 * Decrypts an AES-256-GCM EncryptedPayload.
 * Throws if the tag verification fails (tampered or wrong key).
 */
export function decrypt(
  encrypted: EncryptedPayload,
  key: Uint8Array,
): Uint8Array {
  const { ciphertext, nonce, tag } = encrypted;

  // Reconstruct the sealed format expected by noble: ciphertext || tag
  const sealed = concat(ciphertext, tag);
  const cipher = gcm(key, nonce);
  return cipher.decrypt(sealed);
}

// ---- BLAKE3-based KDF ----

/**
 * Key derivation function built on BLAKE3's built-in KDF mode.
 * Uses BLAKE3(inputKeyMaterial, { context: info, dkLen: length }).
 *
 * @param inputKeyMaterial - The raw key material (e.g., shared secret).
 * @param info - Application-specific context string for domain separation.
 * @param length - Desired output length in bytes (default 32).
 */
export function kdf(
  inputKeyMaterial: Uint8Array,
  info: string,
  length: number = DEFAULT_KDF_LENGTH,
): Uint8Array {
  return blake3(inputKeyMaterial, { context: info, dkLen: length });
}
