// ============================================================
// MeshWhisper SDK — Namespace & Identity Module
// Namespace isolation, destination hashing, local identity
// management, ephemeral sender IDs, and peer identity cache.
// ============================================================

import { ed25519, edwardsToMontgomeryPub, edwardsToMontgomeryPriv } from '@noble/curves/ed25519';
import type { NamespaceConfig } from '../types.js';
import {
  deriveNamespaceId,
  deriveDestHash,
  getCurrentEpochHour,
  randomBytes,
} from '../crypto/index.js';

// ---- Constants ----

/** Destination hash length in bytes (truncated BLAKE3). */
const DEST_HASH_LENGTH = 8;

/** Ephemeral sender ID length in bytes. */
const EPHEMERAL_ID_LENGTH = 16;

// ---- NamespaceManager ----

/**
 * Manages a single namespace scope — all session-layer operations are
 * confined to the namespace derived from the app's bundle ID, the
 * developer's public key, and a salt.
 *
 * Transport-layer relaying is namespace-blind; a user in Namespace A
 * cannot discover or contact users in Namespace B.
 */
export class NamespaceManager {
  private readonly namespaceId: Uint8Array;

  constructor(private readonly config: NamespaceConfig) {
    this.namespaceId = NamespaceManager.computeNamespaceId(
      config.appBundleId,
      config.developerPublicKey,
    );
  }

  // ---- Namespace ID ----

  /**
   * Returns the 256-bit namespace ID for this manager.
   */
  getNamespaceId(): Uint8Array {
    return this.namespaceId;
  }

  /**
   * Computes a 256-bit namespace ID: BLAKE3(appBundleId || developerPublicKey || salt).
   */
  static computeNamespaceId(
    appBundleId: string,
    developerPublicKey: Uint8Array,
  ): Uint8Array {
    return deriveNamespaceId(appBundleId, developerPublicKey);
  }

  /**
   * Checks whether a given namespace ID matches ours (constant-time comparison).
   */
  isInNamespace(otherNamespaceId: Uint8Array): boolean {
    return timingSafeEqual(this.namespaceId, otherNamespaceId);
  }

  // ---- Destination Hashing ----

  /**
   * Computes an 8-byte destination hash: BLAKE3(publicKey || epochHour), truncated.
   * If epochHour is omitted, the current epoch hour is used.
   */
  computeDestHash(publicKey: Uint8Array, epochHour?: number): Uint8Array {
    const hour = epochHour ?? getCurrentEpochHour();
    return deriveDestHash(this.namespaceId, publicKey, hour);
  }

  /**
   * Computes the destination hash for the current epoch hour.
   */
  computeCurrentDestHash(publicKey: Uint8Array): Uint8Array {
    return deriveDestHash(this.namespaceId, publicKey, getCurrentEpochHour());
  }

  /**
   * Computes the destination hash for the previous epoch hour.
   */
  computePreviousDestHash(publicKey: Uint8Array): Uint8Array {
    return deriveDestHash(this.namespaceId, publicKey, getCurrentEpochHour() - 1);
  }

  /**
   * Determines whether a received dest_hash targets our public key.
   * Checks both the current and previous epoch hour to handle boundary conditions.
   */
  isMessageForUs(destHash: Uint8Array, ourPublicKey: Uint8Array): boolean {
    const currentHash = this.computeCurrentDestHash(ourPublicKey);
    if (timingSafeEqual(currentHash, destHash)) return true;

    const previousHash = this.computePreviousDestHash(ourPublicKey);
    return timingSafeEqual(previousHash, destHash);
  }

  /**
   * Returns the current epoch hour: Math.floor(Date.now() / 3_600_000).
   */
  getCurrentEpochHour(): number {
    return getCurrentEpochHour();
  }
}

// ---- LocalIdentity ----

/**
 * Represents the local device's cryptographic identity.
 *
 * Internally stores an Ed25519 private key, from which:
 *   - An X25519 public key is derived for key exchange and dest_hash computation
 *   - Ed25519 signing/verification is performed directly
 *
 * The X25519 public key is what peers see and use to send us messages.
 */
export class LocalIdentity {
  private readonly edPrivateKey: Uint8Array;
  private readonly edPublicKey: Uint8Array;
  private readonly xPublicKey: Uint8Array;
  private readonly xPrivateKey: Uint8Array;
  private ephemeralId: Uint8Array;

  private constructor(edPrivateKey: Uint8Array) {
    this.edPrivateKey = edPrivateKey;
    this.edPublicKey = ed25519.getPublicKey(edPrivateKey);
    this.xPublicKey = edwardsToMontgomeryPub(this.edPublicKey);
    this.xPrivateKey = edwardsToMontgomeryPriv(edPrivateKey);
    this.ephemeralId = randomBytes(EPHEMERAL_ID_LENGTH);
  }

  /**
   * Generates a brand-new identity with a random Ed25519 keypair.
   */
  static create(): LocalIdentity {
    const privateKey = ed25519.utils.randomPrivateKey();
    return new LocalIdentity(privateKey);
  }

  /**
   * Restores an identity from an existing Ed25519 private key.
   */
  static fromPrivateKey(privateKey: Uint8Array): LocalIdentity {
    if (privateKey.length !== 32) {
      throw new RangeError('Ed25519 private key must be exactly 32 bytes');
    }
    return new LocalIdentity(privateKey);
  }

  /**
   * Returns the X25519 public key (32 bytes) used for key exchange and
   * destination hash computation.
   */
  getPublicKey(): Uint8Array {
    return this.xPublicKey;
  }

  /**
   * Returns the Ed25519 public key (32 bytes) used for signature verification.
   */
  getEdPublicKey(): Uint8Array {
    return this.edPublicKey;
  }

  /**
   * Returns the Ed25519 private key (32 bytes). Used only for identity persistence.
   */
  getEdPrivateKey(): Uint8Array {
    return this.edPrivateKey;
  }

  /**
   * Returns the X25519 private key (32 bytes) used for key exchange.
   */
  getPrivateKey(): Uint8Array {
    return this.xPrivateKey;
  }

  /**
   * Signs arbitrary data with this identity's Ed25519 private key.
   * Returns a 64-byte signature.
   */
  signData(data: Uint8Array): Uint8Array {
    return ed25519.sign(data, this.edPrivateKey);
  }

  /**
   * Verifies an Ed25519 signature against the given data and public key.
   */
  verifySignature(
    data: Uint8Array,
    signature: Uint8Array,
    publicKey: Uint8Array,
  ): boolean {
    try {
      return ed25519.verify(signature, data, publicKey);
    } catch {
      return false;
    }
  }

  // ---- Ephemeral Sender ID ----

  /**
   * Returns the current 16-byte ephemeral sender ID.
   */
  generateEphemeralId(): Uint8Array {
    return this.ephemeralId;
  }

  /**
   * Rotates the ephemeral sender ID to a new random value.
   * Should be called periodically to limit linkability.
   * Returns the new ephemeral ID.
   */
  rotateEphemeralId(): Uint8Array {
    this.ephemeralId = randomBytes(EPHEMERAL_ID_LENGTH);
    return this.ephemeralId;
  }
}

// ---- PeerIdentityCache ----

interface PeerEntry {
  id: string;
  publicKey: Uint8Array;
}

/**
 * In-memory cache of known peer identities, enabling lookup by peer ID
 * or by destination hash.
 */
export class PeerIdentityCache {
  private readonly peers: Map<string, Uint8Array> = new Map();

  /**
   * Registers a peer's public key (X25519).
   */
  addPeer(peerId: string, publicKey: Uint8Array): void {
    this.peers.set(peerId, publicKey);
  }

  /**
   * Returns the public key for a known peer, or null if unknown.
   */
  getPeerPublicKey(peerId: string): Uint8Array | null {
    return this.peers.get(peerId) ?? null;
  }

  /**
   * Searches all known peers for one whose dest_hash matches the given value.
   * If epochHour is provided, only that hour is checked; otherwise both the
   * current and previous epoch hours are checked.
   *
   * Returns the peer ID if found, or null.
   */
  findPeerByDestHash(namespaceId: Uint8Array, destHash: Uint8Array, epochHour?: number): string | null {
    for (const [peerId, publicKey] of this.peers) {
      if (epochHour !== undefined) {
        const hash = deriveDestHash(namespaceId, publicKey, epochHour);
        if (timingSafeEqual(hash, destHash)) return peerId;
      } else {
        const currentHour = getCurrentEpochHour();
        const currentHash = deriveDestHash(namespaceId, publicKey, currentHour);
        if (timingSafeEqual(currentHash, destHash)) return peerId;

        const previousHash = deriveDestHash(namespaceId, publicKey, currentHour - 1);
        if (timingSafeEqual(previousHash, destHash)) return peerId;
      }
    }
    return null;
  }

  /**
   * Removes a peer from the cache.
   */
  removePeer(peerId: string): void {
    this.peers.delete(peerId);
  }

  /**
   * Returns all cached peers as an array.
   */
  getAllPeers(): Array<PeerEntry> {
    const result: Array<PeerEntry> = [];
    for (const [id, publicKey] of this.peers) {
      result.push({ id, publicKey });
    }
    return result;
  }
}

// ---- Helpers ----

/**
 * Constant-time comparison of two Uint8Arrays.
 * Returns true only if both arrays have the same length and identical contents.
 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}
