// ============================================================
// MeshWhisper SDK — Store-and-Forward Relay Module
// Stores encrypted blobs for offline peers and delivers them
// when the recipient announces presence.
// ============================================================

import type { StoredBlob } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a random 32-hex-char blob ID. */
function generateBlobId(): string {
  // crypto.randomUUID() is available in Node >= 19 and modern runtimes,
  // but a hex string is more portable and avoids dashes.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time-ish comparison for Uint8Array equality. */
function uint8Equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/** Rough byte size of a StoredBlob (payload dominates, but we account for metadata too). */
function blobByteSize(blob: StoredBlob): number {
  return (
    blob.encryptedPayload.byteLength +
    blob.destHash.byteLength +
    blob.id.length * 2 + // JS string ≈ 2 bytes per char
    32 // fixed overhead for numeric fields + object shell
  );
}

// ---------------------------------------------------------------------------
// Default constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_STORAGE_BYTES = 50 * 1024 * 1024; // 50 MB
const DEFAULT_TTL_HOURS = 72;
const DEFAULT_PRUNE_INTERVAL_MS = 60_000; // 1 minute

// ---------------------------------------------------------------------------
// RelayStore
// ---------------------------------------------------------------------------

export interface RelayStoreOptions {
  maxStorageBytes?: number;
  defaultTTLHours?: number;
}

export class RelayStore {
  private readonly maxStorageBytes: number;
  private readonly defaultTTLHours: number;

  /** All stored blobs keyed by blob id. */
  private readonly blobs = new Map<string, StoredBlob>();

  /** Secondary index: destHash hex -> set of blob ids. */
  private readonly destIndex = new Map<string, Set<string>>();

  /** Track insertion order for LRU eviction (oldest first). */
  private readonly insertionOrder: string[] = [];

  private currentStorageBytes = 0;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options?: RelayStoreOptions) {
    this.maxStorageBytes = options?.maxStorageBytes ?? DEFAULT_MAX_STORAGE_BYTES;
    this.defaultTTLHours = options?.defaultTTLHours ?? DEFAULT_TTL_HOURS;
  }

  // ----- helpers -----

  private destKey(destHash: Uint8Array): string {
    return Array.from(destHash)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  private isExpired(blob: StoredBlob): boolean {
    const expiryMs = blob.receivedAt + blob.ttlHours * 3_600_000;
    return Date.now() >= expiryMs;
  }

  // ----- Blob storage -----

  /**
   * Store an encrypted blob. Returns false if storage is full even after
   * evicting the oldest blobs.
   */
  storeBlob(blob: StoredBlob): boolean {
    const size = blobByteSize(blob);

    // Evict oldest blobs until there is room (or nothing left to evict)
    while (
      this.currentStorageBytes + size > this.maxStorageBytes &&
      this.insertionOrder.length > 0
    ) {
      const oldestId = this.insertionOrder[0];
      this.removeBlob(oldestId);
    }

    if (this.currentStorageBytes + size > this.maxStorageBytes) {
      return false;
    }

    // Avoid duplicate ids
    if (this.blobs.has(blob.id)) {
      this.removeBlob(blob.id);
    }

    this.blobs.set(blob.id, blob);
    this.currentStorageBytes += size;
    this.insertionOrder.push(blob.id);

    const dk = this.destKey(blob.destHash);
    let set = this.destIndex.get(dk);
    if (!set) {
      set = new Set();
      this.destIndex.set(dk, set);
    }
    set.add(blob.id);

    return true;
  }

  /** Retrieve all stored blobs for a given destination hash. */
  getBlobs(destHash: Uint8Array): StoredBlob[] {
    const dk = this.destKey(destHash);
    const ids = this.destIndex.get(dk);
    if (!ids) return [];
    const results: StoredBlob[] = [];
    for (const id of ids) {
      const blob = this.blobs.get(id);
      if (blob) results.push(blob);
    }
    return results;
  }

  /** Remove a single blob by id. */
  removeBlob(id: string): void {
    const blob = this.blobs.get(id);
    if (!blob) return;

    this.currentStorageBytes -= blobByteSize(blob);
    this.blobs.delete(id);

    const dk = this.destKey(blob.destHash);
    const set = this.destIndex.get(dk);
    if (set) {
      set.delete(id);
      if (set.size === 0) this.destIndex.delete(dk);
    }

    const idx = this.insertionOrder.indexOf(id);
    if (idx !== -1) this.insertionOrder.splice(idx, 1);
  }

  /** Remove all blobs targeting a specific destination hash. */
  removeBlobsForDest(destHash: Uint8Array): void {
    const dk = this.destKey(destHash);
    const ids = this.destIndex.get(dk);
    if (!ids) return;
    // Snapshot the ids before iterating — removeBlob mutates the set.
    for (const id of [...ids]) {
      this.removeBlob(id);
    }
  }

  // ----- TTL management -----

  /** Remove all expired blobs. Returns count of blobs removed. */
  pruneExpired(): number {
    let removed = 0;
    // Iterate oldest-first for efficiency.
    for (let i = this.insertionOrder.length - 1; i >= 0; i--) {
      const id = this.insertionOrder[i];
      const blob = this.blobs.get(id);
      if (blob && this.isExpired(blob)) {
        this.removeBlob(id);
        removed++;
      }
    }
    return removed;
  }

  /** Start automatic periodic pruning. */
  startPruneInterval(intervalMs?: number): void {
    this.stopPruneInterval();
    this.pruneTimer = setInterval(
      () => this.pruneExpired(),
      intervalMs ?? DEFAULT_PRUNE_INTERVAL_MS,
    );
    // Allow the Node.js process to exit even if the timer is running.
    if (typeof this.pruneTimer === "object" && "unref" in this.pruneTimer) {
      this.pruneTimer.unref();
    }
  }

  /** Stop automatic periodic pruning. */
  stopPruneInterval(): void {
    if (this.pruneTimer !== null) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  // ----- Storage metrics -----

  /** Bytes currently consumed by stored blobs. */
  getStorageUsed(): number {
    return this.currentStorageBytes;
  }

  /** Configured maximum storage capacity in bytes. */
  getStorageCapacity(): number {
    return this.maxStorageBytes;
  }

  /** Total number of blobs currently stored. */
  getBlobCount(): number {
    return this.blobs.size;
  }

  // ----- Presence announcement -----

  /**
   * Handle a presence announcement. When a peer announces it is online we
   * return (and remove) all blobs matching its destination hash.
   *
   * Destination hashes rotate hourly. The caller should provide both the
   * current-epoch and the previous-epoch destination hashes so we can match
   * blobs stored under either.
   */
  handlePresenceAnnouncement(destHash: Uint8Array): StoredBlob[];
  handlePresenceAnnouncement(
    destHash: Uint8Array,
    previousEpochDestHash?: Uint8Array,
  ): StoredBlob[];
  handlePresenceAnnouncement(
    destHash: Uint8Array,
    previousEpochDestHash?: Uint8Array,
  ): StoredBlob[] {
    const delivered: StoredBlob[] = [];

    // Current epoch
    const currentBlobs = this.getBlobs(destHash);
    delivered.push(...currentBlobs);
    this.removeBlobsForDest(destHash);

    // Previous epoch (dest hashes rotate hourly)
    if (previousEpochDestHash && !uint8Equal(destHash, previousEpochDestHash)) {
      const prevBlobs = this.getBlobs(previousEpochDestHash);
      delivered.push(...prevBlobs);
      this.removeBlobsForDest(previousEpochDestHash);
    }

    return delivered;
  }

  // ----- Multi-hop forwarding -----

  /**
   * Decide whether a blob should be forwarded to a closer relay.
   * Returns true when the blob still has remaining hops and a closer relay
   * is available.
   */
  shouldForward(blob: StoredBlob, closerRelayAvailable: boolean): boolean {
    return closerRelayAvailable && blob.hopsRemaining > 0;
  }

  /**
   * Prepare a blob for multi-hop forwarding.
   * Returns a new StoredBlob with decremented hopsRemaining and a fresh id.
   */
  prepareForward(blob: StoredBlob): StoredBlob {
    if (blob.hopsRemaining <= 0) {
      throw new Error("Cannot forward blob with no remaining hops");
    }
    return {
      ...blob,
      id: generateBlobId(),
      hopsRemaining: blob.hopsRemaining - 1,
      receivedAt: Date.now(),
    };
  }
}

// ---------------------------------------------------------------------------
// StoreAndForwardManager — higher-level orchestration
// ---------------------------------------------------------------------------

export interface StoreAndForwardStats {
  blobCount: number;
  bytesUsed: number;
  oldestBlobAge: number; // milliseconds since the oldest blob was received
}

export class StoreAndForwardManager {
  private readonly store: RelayStore;

  constructor(store: RelayStore) {
    this.store = store;
  }

  /**
   * Store an encrypted payload destined for an offline peer.
   * Returns the generated blob id, or throws if storage is completely full.
   */
  storeForDelivery(
    destHash: Uint8Array,
    encryptedPayload: Uint8Array,
    ttlHours?: number,
  ): string {
    const blob: StoredBlob = {
      id: generateBlobId(),
      destHash,
      encryptedPayload,
      receivedAt: Date.now(),
      ttlHours: ttlHours ?? 72,
      hopsRemaining: 3, // sensible default for multi-hop
    };

    const stored = this.store.storeBlob(blob);
    if (!stored) {
      throw new Error(
        "Relay storage full: could not store blob even after eviction",
      );
    }

    return blob.id;
  }

  /**
   * Called when a peer comes online. Returns all stored blobs for its
   * destination hash and removes them from the store.
   */
  deliverStored(destHash: Uint8Array): StoredBlob[] {
    return this.store.handlePresenceAnnouncement(destHash);
  }

  /** Return aggregate stats about the relay store. */
  getStats(): StoreAndForwardStats {
    const blobCount = this.store.getBlobCount();
    const bytesUsed = this.store.getStorageUsed();

    let oldestBlobAge = 0;
    if (blobCount > 0) {
      // We don't have direct access to the internal insertion order,
      // so scan all blobs via a destHash-agnostic approach: use getBlobs
      // is not feasible without knowing hashes. Instead we expose a
      // helper below or compute from the public API. Since we control
      // both classes in this module, we reach into the store's blobs map
      // via a dedicated accessor.
      oldestBlobAge = this.computeOldestAge();
    }

    return { blobCount, bytesUsed, oldestBlobAge };
  }

  private computeOldestAge(): number {
    // Access internal state via the store — both classes live in the same
    // module, so this tightly-coupled reach is acceptable.
    const blobs = (this.store as unknown as { blobs: Map<string, StoredBlob> })
      .blobs;
    let oldest = Infinity;
    for (const blob of blobs.values()) {
      if (blob.receivedAt < oldest) oldest = blob.receivedAt;
    }
    return oldest === Infinity ? 0 : Date.now() - oldest;
  }
}
