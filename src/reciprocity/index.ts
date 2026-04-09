// ============================================================
// MeshWhisper SDK — Reciprocity Engine
// Maintains a local relay ledger implementing tit-for-tat
// relay fairness as described in PRD section 7.3.
// ============================================================

import { RelayLedgerEntry, ReciprocityTier } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default grace period for newly registered devices (48 hours). */
const DEFAULT_GRACE_PERIOD_HOURS = 48;

/** Tier thresholds for reciprocity scoring. */
const TIER_CONTRIBUTOR_THRESHOLD = 1.0;
const TIER_BALANCED_THRESHOLD = 0.5;
const TIER_CONSUMER_THRESHOLD = 0.1;

/** Relay priority values per tier. */
const PRIORITY_CONTRIBUTOR = 1.0;
const PRIORITY_BALANCED = 0.7;
const PRIORITY_CONSUMER = 0.3;
const PRIORITY_FREERIDER = 0.0;

/** Serialization format version. */
const SERIALIZATION_VERSION = 1;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RelayLedgerOptions {
  /** Duration of the new-device grace period, in hours. Defaults to 48. */
  gracePeriodHours?: number;
}

// ---------------------------------------------------------------------------
// Internal serialization shape
// ---------------------------------------------------------------------------

interface SerializedLedger {
  version: number;
  gracePeriodHours: number;
  deviceId: string | null;
  deviceRegisteredAt: number | null;
  entries: RelayLedgerEntry[];
}

// ---------------------------------------------------------------------------
// RelayLedger
// ---------------------------------------------------------------------------

/**
 * Tracks bytes relayed for and by each peer, computes reciprocity scores,
 * and makes relay-priority decisions.  Purely local and approximate — there
 * is no global accounting.
 */
export class RelayLedger {
  private readonly gracePeriodMs: number;
  private entries: Map<string, RelayLedgerEntry> = new Map();
  private deviceId: string | null = null;
  private deviceRegisteredAt: number | null = null;

  constructor(options?: RelayLedgerOptions) {
    const hours = options?.gracePeriodHours ?? DEFAULT_GRACE_PERIOD_HOURS;
    if (hours < 0) {
      throw new RangeError('gracePeriodHours must be non-negative');
    }
    this.gracePeriodMs = hours * 60 * 60 * 1000;
  }

  // -----------------------------------------------------------------------
  // Ledger operations
  // -----------------------------------------------------------------------

  /**
   * Record that we relayed `bytes` of data on behalf of `peerId`.
   */
  recordRelayedForPeer(peerId: string, bytes: number): void {
    if (bytes < 0) {
      throw new RangeError('bytes must be non-negative');
    }
    const entry = this.getOrCreateEntry(peerId);
    entry.bytesRelayedForThem += bytes;
    entry.lastUpdated = Date.now();
  }

  /**
   * Record that `peerId` relayed `bytes` of data for us.
   */
  recordPeerRelayedForUs(peerId: string, bytes: number): void {
    if (bytes < 0) {
      throw new RangeError('bytes must be non-negative');
    }
    const entry = this.getOrCreateEntry(peerId);
    entry.bytesTheyRelayedForUs += bytes;
    entry.lastUpdated = Date.now();
  }

  /**
   * Return the ledger entry for a given peer, or `null` if none exists.
   */
  getEntry(peerId: string): RelayLedgerEntry | null {
    const entry = this.entries.get(peerId);
    return entry ? { ...entry } : null;
  }

  /**
   * Return a snapshot of all ledger entries.
   */
  getAllEntries(): RelayLedgerEntry[] {
    return Array.from(this.entries.values()).map((e) => ({ ...e }));
  }

  // -----------------------------------------------------------------------
  // Score computation
  // -----------------------------------------------------------------------

  /**
   * Compute the reciprocity score for a specific peer.
   *
   * Score = bytes_relayed_for_them / bytes_they_relayed_for_us
   *
   * - If neither party has relayed anything, returns 1.0 (neutral).
   * - If we have relayed for them but they haven't for us, returns Infinity
   *   (we are a pure contributor to this peer).
   * - If they have relayed for us but we haven't for them, returns 0.0
   *   (we are a pure consumer from this peer).
   */
  getScore(peerId: string): number {
    const entry = this.entries.get(peerId);
    if (!entry) {
      return 1.0; // unknown peer — treat as neutral
    }
    return this.computeScore(entry.bytesRelayedForThem, entry.bytesTheyRelayedForUs);
  }

  /**
   * Compute the aggregate reciprocity score across all peers.
   *
   * Uses total bytes relayed for all peers vs total bytes all peers
   * relayed for us.
   */
  getGlobalScore(): number {
    let totalRelayedForThem = 0;
    let totalTheyRelayedForUs = 0;
    for (const entry of this.entries.values()) {
      totalRelayedForThem += entry.bytesRelayedForThem;
      totalTheyRelayedForUs += entry.bytesTheyRelayedForUs;
    }
    return this.computeScore(totalRelayedForThem, totalTheyRelayedForUs);
  }

  /**
   * Determine the reciprocity tier for a given peer.
   */
  getTier(peerId: string): ReciprocityTier {
    if (this.isInGracePeriod()) {
      return 'balanced';
    }
    const score = this.getScore(peerId);
    return RelayLedger.tierFromScore(score);
  }

  // -----------------------------------------------------------------------
  // Relay priority
  // -----------------------------------------------------------------------

  /**
   * Determine whether we should relay traffic for this peer.
   *
   * Free-riders are refused unless we are still in our grace period.
   */
  shouldRelay(peerId: string): boolean {
    if (this.isInGracePeriod()) {
      return true;
    }
    return this.getTier(peerId) !== 'freerider';
  }

  /**
   * Return a relay-queue priority between 0.0 and 1.0 for this peer.
   *
   * Higher values mean packets for/from this peer should be relayed sooner.
   */
  getRelayPriority(peerId: string): number {
    const tier = this.getTier(peerId);
    switch (tier) {
      case 'contributor':
        return PRIORITY_CONTRIBUTOR;
      case 'balanced':
        return PRIORITY_BALANCED;
      case 'consumer':
        return PRIORITY_CONSUMER;
      case 'freerider':
        return PRIORITY_FREERIDER;
    }
  }

  // -----------------------------------------------------------------------
  // Grace period
  // -----------------------------------------------------------------------

  /**
   * Register this device, recording the current time as the creation
   * timestamp for grace-period purposes.
   */
  registerDevice(deviceId: string): void {
    if (!deviceId) {
      throw new TypeError('deviceId must be a non-empty string');
    }
    this.deviceId = deviceId;
    this.deviceRegisteredAt = Date.now();
  }

  /**
   * Returns `true` if this device was registered within the configured
   * grace period (default 48 hours).
   */
  isInGracePeriod(): boolean {
    if (this.deviceRegisteredAt === null) {
      return false;
    }
    return Date.now() - this.deviceRegisteredAt < this.gracePeriodMs;
  }

  // -----------------------------------------------------------------------
  // Ledger maintenance
  // -----------------------------------------------------------------------

  /**
   * Apply exponential decay to every entry in the ledger.
   *
   * Multiplies both byte counters by `factor` (should be between 0 and 1).
   * This prevents ancient history from permanently dominating the score.
   */
  decayLedger(factor: number): void {
    if (factor < 0 || factor > 1) {
      throw new RangeError('decay factor must be between 0 and 1');
    }
    for (const entry of this.entries.values()) {
      entry.bytesRelayedForThem = Math.floor(entry.bytesRelayedForThem * factor);
      entry.bytesTheyRelayedForUs = Math.floor(entry.bytesTheyRelayedForUs * factor);
    }
  }

  /**
   * Remove entries for peers whose `lastUpdated` timestamp is older
   * than `maxAgeMs` milliseconds ago.
   */
  pruneInactive(maxAgeMs: number): void {
    if (maxAgeMs < 0) {
      throw new RangeError('maxAgeMs must be non-negative');
    }
    const cutoff = Date.now() - maxAgeMs;
    for (const [peerId, entry] of this.entries) {
      if (entry.lastUpdated < cutoff) {
        this.entries.delete(peerId);
      }
    }
  }

  /**
   * Clear all ledger entries.  Device registration is preserved.
   */
  reset(): void {
    this.entries.clear();
  }

  // -----------------------------------------------------------------------
  // Serialization
  // -----------------------------------------------------------------------

  /**
   * Serialize the entire ledger state to a `Uint8Array` for persistence.
   */
  serialize(): Uint8Array {
    const payload: SerializedLedger = {
      version: SERIALIZATION_VERSION,
      gracePeriodHours: this.gracePeriodMs / (60 * 60 * 1000),
      deviceId: this.deviceId,
      deviceRegisteredAt: this.deviceRegisteredAt,
      entries: this.getAllEntries(),
    };
    const json = JSON.stringify(payload);
    return new TextEncoder().encode(json);
  }

  /**
   * Restore a `RelayLedger` from previously serialized data.
   */
  static deserialize(data: Uint8Array): RelayLedger {
    let parsed: SerializedLedger;
    try {
      const json = new TextDecoder().decode(data);
      parsed = JSON.parse(json) as SerializedLedger;
    } catch {
      throw new Error('Failed to deserialize RelayLedger: invalid data');
    }

    if (parsed.version !== SERIALIZATION_VERSION) {
      throw new Error(
        `Unsupported RelayLedger serialization version: ${parsed.version}`,
      );
    }

    const ledger = new RelayLedger({
      gracePeriodHours: parsed.gracePeriodHours,
    });

    if (parsed.deviceId !== null && parsed.deviceRegisteredAt !== null) {
      ledger.deviceId = parsed.deviceId;
      ledger.deviceRegisteredAt = parsed.deviceRegisteredAt;
    }

    for (const entry of parsed.entries) {
      ledger.entries.set(entry.peerId, {
        peerId: entry.peerId,
        bytesRelayedForThem: entry.bytesRelayedForThem,
        bytesTheyRelayedForUs: entry.bytesTheyRelayedForUs,
        lastUpdated: entry.lastUpdated,
      });
    }

    return ledger;
  }

  // -----------------------------------------------------------------------
  // Static helpers
  // -----------------------------------------------------------------------

  /**
   * Map a numeric reciprocity score to a tier label.
   */
  static tierFromScore(score: number): ReciprocityTier {
    if (score > TIER_CONTRIBUTOR_THRESHOLD) return 'contributor';
    if (score >= TIER_BALANCED_THRESHOLD) return 'balanced';
    if (score >= TIER_CONSUMER_THRESHOLD) return 'consumer';
    return 'freerider';
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private getOrCreateEntry(peerId: string): RelayLedgerEntry {
    let entry = this.entries.get(peerId);
    if (!entry) {
      entry = {
        peerId,
        bytesRelayedForThem: 0,
        bytesTheyRelayedForUs: 0,
        lastUpdated: Date.now(),
      };
      this.entries.set(peerId, entry);
    }
    return entry;
  }

  private computeScore(relayedForThem: number, theyRelayedForUs: number): number {
    if (relayedForThem === 0 && theyRelayedForUs === 0) {
      return 1.0; // no data — neutral
    }
    if (theyRelayedForUs === 0) {
      return Infinity; // pure contributor
    }
    return relayedForThem / theyRelayedForUs;
  }
}
