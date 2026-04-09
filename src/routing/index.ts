// ============================================================
// MeshWhisper SDK — Social Graph Routing
// Uses social proximity (not geographic or DHT) as routing
// topology.  Implements Bubble-Rap-inspired discovery with
// small-world properties (~6 hop average path length).
// See PRD section 7.1.
// ============================================================

import type { Packet, PeerProximityEntry, RouteRequest, RouteOffer } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default TTL for proximity table entries (1 hour). */
const DEFAULT_PEER_TTL_MS = 60 * 60 * 1000;

/** Default TTL for cached routes (5 minutes). */
const DEFAULT_ROUTE_TTL_MS = 5 * 60 * 1000;

/** Default timeout for pending route requests (5 seconds). */
const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 1000;

/** Maximum number of recent packet hashes kept for deduplication. */
const SEEN_PACKET_CAPACITY = 10_000;

/** Number of socially-closest peers to gossip route requests to. */
const GOSSIP_FANOUT = 5;

// ---------------------------------------------------------------------------
// Route type
// ---------------------------------------------------------------------------

export interface Route {
  destHash: Uint8Array;
  nextHop: string;
  hopCount: number;
  estimatedLatency: number;
  discoveredAt: number;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a Uint8Array to a hex string for use as a Map key. */
function hashToHex(hash: Uint8Array): string {
  let out = '';
  for (let i = 0; i < hash.length; i++) {
    out += hash[i].toString(16).padStart(2, '0');
  }
  return out;
}

/** Constant-time-ish byte array equality. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/**
 * XOR distance between two destination hashes.
 * Returns a number usable for comparison (lower = closer).
 * Works on up to 8-byte hashes.
 */
function xorDistance(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  let distance = 0;
  for (let i = 0; i < len; i++) {
    distance = distance * 256 + (a[i] ^ b[i]);
  }
  return distance;
}

/**
 * Compute a simple hash of a packet for deduplication.
 * Uses destHash + senderEphemeralId + first 8 bytes of payload.
 */
function packetFingerprint(packet: Packet): string {
  const parts: number[] = [];
  for (let i = 0; i < packet.destHash.length; i++) {
    parts.push(packet.destHash[i]);
  }
  for (let i = 0; i < packet.senderEphemeralId.length; i++) {
    parts.push(packet.senderEphemeralId[i]);
  }
  const payloadSample = Math.min(8, packet.encryptedPayload.length);
  for (let i = 0; i < payloadSample; i++) {
    parts.push(packet.encryptedPayload[i]);
  }
  return parts.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// PeerProximityTable
// ---------------------------------------------------------------------------

/**
 * Maintains a table of known peers indexed by social proximity.
 * Entries are keyed by peerId and can also be looked up by destHash.
 */
export class PeerProximityTable {
  private readonly entries: Map<string, PeerProximityEntry> = new Map();
  private readonly destHashIndex: Map<string, string> = new Map(); // hex(destHash) -> peerId
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_PEER_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** Add or replace a peer entry. */
  addPeer(entry: PeerProximityEntry): void {
    this.entries.set(entry.peerId, entry);
    this.destHashIndex.set(hashToHex(entry.destHash), entry.peerId);
  }

  /** Remove a peer by ID. */
  removePeer(peerId: string): void {
    const existing = this.entries.get(peerId);
    if (existing) {
      this.destHashIndex.delete(hashToHex(existing.destHash));
      this.entries.delete(peerId);
    }
  }

  /** Partially update an existing peer entry. */
  updatePeer(peerId: string, updates: Partial<PeerProximityEntry>): void {
    const existing = this.entries.get(peerId);
    if (!existing) return;

    // If destHash changes, update the index.
    if (updates.destHash && !bytesEqual(updates.destHash, existing.destHash)) {
      this.destHashIndex.delete(hashToHex(existing.destHash));
      this.destHashIndex.set(hashToHex(updates.destHash), peerId);
    }

    const updated: PeerProximityEntry = { ...existing, ...updates };
    this.entries.set(peerId, updated);
  }

  /** Find a peer that owns the given destination hash. */
  findPeer(destHash: Uint8Array): PeerProximityEntry | null {
    const hex = hashToHex(destHash);
    const peerId = this.destHashIndex.get(hex);
    if (peerId === undefined) return null;

    const entry = this.entries.get(peerId);
    if (!entry) {
      // Stale index entry — clean up.
      this.destHashIndex.delete(hex);
      return null;
    }

    return entry;
  }

  /**
   * Return the N peers whose known destHash is closest (by XOR distance) to
   * the target destination hash.  Results are sorted closest-first.
   */
  getClosestPeers(destHash: Uint8Array, count: number): PeerProximityEntry[] {
    const scored: Array<{ entry: PeerProximityEntry; distance: number }> = [];

    for (const entry of this.entries.values()) {
      scored.push({
        entry,
        distance: xorDistance(entry.destHash, destHash),
      });
    }

    scored.sort((a, b) => a.distance - b.distance);
    return scored.slice(0, count).map(s => s.entry);
  }

  /** Remove entries whose lastSeen is older than maxAgeMs. */
  pruneStale(maxAgeMs: number = this.ttlMs): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [peerId, entry] of this.entries) {
      if (entry.lastSeen < cutoff) {
        this.removePeer(peerId);
      }
    }
  }

  /** Number of entries currently in the table. */
  get size(): number {
    return this.entries.size;
  }

  /** Iterate all entries (snapshot). */
  allEntries(): PeerProximityEntry[] {
    return Array.from(this.entries.values());
  }
}

// ---------------------------------------------------------------------------
// Seen-packet LRU set (bounded ring buffer)
// ---------------------------------------------------------------------------

class SeenPacketSet {
  private readonly capacity: number;
  private readonly set: Set<string> = new Set();
  private readonly ring: string[];
  private cursor = 0;

  constructor(capacity: number = SEEN_PACKET_CAPACITY) {
    this.capacity = capacity;
    this.ring = new Array<string>(capacity).fill('');
  }

  /** Returns true if the fingerprint was already in the set. */
  testAndAdd(fingerprint: string): boolean {
    if (this.set.has(fingerprint)) return true;

    // Evict oldest if at capacity.
    if (this.set.size >= this.capacity) {
      const evict = this.ring[this.cursor];
      if (evict) this.set.delete(evict);
    }

    this.ring[this.cursor] = fingerprint;
    this.set.add(fingerprint);
    this.cursor = (this.cursor + 1) % this.capacity;
    return false;
  }

  has(fingerprint: string): boolean {
    return this.set.has(fingerprint);
  }
}

// ---------------------------------------------------------------------------
// Pending request tracker
// ---------------------------------------------------------------------------

interface PendingRequest {
  request: RouteRequest;
  createdAt: number;
  timeoutMs: number;
  offers: RouteOffer[];
  resolve: (route: Route | null) => void;
}

// ---------------------------------------------------------------------------
// Route cache
// ---------------------------------------------------------------------------

class RouteCache {
  private readonly routes: Map<string, Route> = new Map();

  getCachedRoute(destHash: Uint8Array): Route | null {
    const key = hashToHex(destHash);
    const route = this.routes.get(key);
    if (!route) return null;
    if (Date.now() > route.expiresAt) {
      this.routes.delete(key);
      return null;
    }
    return route;
  }

  cacheRoute(route: Route): void {
    this.routes.set(hashToHex(route.destHash), route);
  }

  invalidateRoute(destHash: Uint8Array): void {
    this.routes.delete(hashToHex(destHash));
  }
}

// ---------------------------------------------------------------------------
// SocialGraphRouter
// ---------------------------------------------------------------------------

/**
 * Core social graph router.
 *
 * Uses the peer proximity table as the routing topology.
 * Route discovery gossips route requests to socially proximate peers
 * and selects the shortest/fastest offered route.
 */
export class SocialGraphRouter {
  readonly localPeerId: string;
  readonly proximityTable: PeerProximityTable;

  private readonly routeCache: RouteCache = new RouteCache();
  private readonly seenPackets: SeenPacketSet = new SeenPacketSet();
  private readonly pendingRequests: Map<string, PendingRequest> = new Map();
  private readonly routeTtlMs: number;
  private readonly requestTimeoutMs: number;

  constructor(
    localPeerId: string,
    proximityTable: PeerProximityTable,
    options?: {
      routeTtlMs?: number;
      requestTimeoutMs?: number;
    },
  ) {
    this.localPeerId = localPeerId;
    this.proximityTable = proximityTable;
    this.routeTtlMs = options?.routeTtlMs ?? DEFAULT_ROUTE_TTL_MS;
    this.requestTimeoutMs = options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  // -----------------------------------------------------------------------
  // Route cache public API
  // -----------------------------------------------------------------------

  /** Retrieve a cached route if it exists and has not expired. */
  getCachedRoute(destHash: Uint8Array): Route | null {
    return this.routeCache.getCachedRoute(destHash);
  }

  /** Store a route in the cache. */
  cacheRoute(route: Route): void {
    this.routeCache.cacheRoute(route);
  }

  /** Remove a cached route. */
  invalidateRoute(destHash: Uint8Array): void {
    this.routeCache.invalidateRoute(destHash);
  }

  // -----------------------------------------------------------------------
  // Route discovery (PRD section 7.1)
  // -----------------------------------------------------------------------

  /**
   * Discover a route to the given destination hash.
   *
   * Algorithm:
   *   1. Check the route cache for a non-expired entry.
   *   2. Check if any connected peer in the proximity table has a recent
   *      relay path to the destination.
   *   3. If not, create a RouteRequest (containing only dest_hash, not
   *      sender identity) and gossip it to socially proximate peers.
   *   4. Collect RouteOffer responses within the request timeout.
   *   5. Select the shortest/fastest offered route.
   *
   * Returns the route, or null if no route could be discovered within the
   * timeout window.
   */
  findRoute(destHash: Uint8Array): Promise<Route | null> {
    // 1. Check cache.
    const cached = this.routeCache.getCachedRoute(destHash);
    if (cached) return Promise.resolve(cached);

    // 2. Check proximity table for a direct or relay path.
    const directPeer = this.proximityTable.findPeer(destHash);
    if (directPeer && this.isRecent(directPeer.lastSeen)) {
      const route = this.peerToRoute(directPeer, destHash);
      this.routeCache.cacheRoute(route);
      return Promise.resolve(route);
    }

    // 3. Create a RouteRequest and gossip to close peers.
    const requestId = this.generateRequestId();
    const request: RouteRequest = {
      destHash,
      requestId,
      ttl: 6, // small-world average path length
      timestamp: Date.now(),
    };

    return new Promise<Route | null>((resolve) => {
      const pending: PendingRequest = {
        request,
        createdAt: Date.now(),
        timeoutMs: this.requestTimeoutMs,
        offers: [],
        resolve,
      };

      const key = hashToHex(requestId);
      this.pendingRequests.set(key, pending);

      // 4-5. Timeout: after the window closes, pick the best offer.
      setTimeout(() => {
        this.resolvePendingRequest(key);
      }, this.requestTimeoutMs);
    });
  }

  /**
   * Handle an incoming route request from a neighbouring peer.
   *
   * If this node knows the destination (via its proximity table), it
   * returns a RouteOffer.  Otherwise returns null (the caller should
   * decide whether to forward the request further).
   */
  handleRouteRequest(request: RouteRequest, fromPeer: string): RouteOffer | null {
    const peer = this.proximityTable.findPeer(request.destHash);
    if (!peer) return null;
    if (!this.isRecent(peer.lastSeen)) return null;

    return {
      requestId: request.requestId,
      hopCount: peer.hopCount + 1, // +1 for this node in the path
      estimatedLatency: peer.latency,
      offeredBy: this.localPeerId,
    };
  }

  /**
   * Register a received route offer against the matching pending request.
   * If no pending request exists for the offer's requestId, the offer is
   * silently dropped.
   */
  handleRouteOffer(offer: RouteOffer): void {
    const key = hashToHex(offer.requestId);
    const pending = this.pendingRequests.get(key);
    if (!pending) return;

    pending.offers.push(offer);
  }

  /**
   * Return a list of the RouteRequests that are still awaiting responses.
   * Expired requests are pruned as a side-effect.
   */
  getPendingRequests(): RouteRequest[] {
    this.pruneExpiredRequests();
    const result: RouteRequest[] = [];
    for (const pending of this.pendingRequests.values()) {
      result.push(pending.request);
    }
    return result;
  }

  /**
   * Return the list of socially proximate peers that a route request
   * should be gossiped to.  Useful for the transport layer to know where
   * to send route requests produced by findRoute.
   */
  getGossipTargets(destHash: Uint8Array): PeerProximityEntry[] {
    return this.proximityTable.getClosestPeers(destHash, GOSSIP_FANOUT);
  }

  // -----------------------------------------------------------------------
  // Message forwarding
  // -----------------------------------------------------------------------

  /**
   * Determine the next-hop peer to forward a message to for the given
   * destination hash.
   *
   * Returns null if no route is known.
   */
  getNextHop(destHash: Uint8Array): string | null {
    // Try cache first.
    const cached = this.routeCache.getCachedRoute(destHash);
    if (cached) return cached.nextHop;

    // Try direct peer from proximity table.
    const peer = this.proximityTable.findPeer(destHash);
    if (peer && this.isRecent(peer.lastSeen)) {
      return peer.relayPath.length > 0 ? peer.relayPath[0] : peer.peerId;
    }

    // Try closest peer as a heuristic relay.
    const closest = this.proximityTable.getClosestPeers(destHash, 1);
    if (closest.length > 0 && this.isRecent(closest[0].lastSeen)) {
      return closest[0].peerId;
    }

    return null;
  }

  /**
   * Determine whether this device should relay a given packet.
   *
   * A packet is relayed when:
   *   - Its TTL is greater than 0
   *   - It has not been seen before (deduplication)
   */
  shouldRelay(packet: Packet): boolean {
    if (packet.ttl <= 0) return false;

    const fp = packetFingerprint(packet);
    const alreadySeen = this.seenPackets.testAndAdd(fp);
    return !alreadySeen;
  }

  /**
   * Return a copy of the packet with TTL decremented by 1.
   * Callers must ensure TTL > 0 before calling (see shouldRelay).
   */
  decrementTTL(packet: Packet): Packet {
    if (packet.ttl <= 0) {
      throw new RangeError('Cannot decrement TTL below 0');
    }
    return {
      ...packet,
      ttl: packet.ttl - 1,
    };
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /** Check if a timestamp is recent enough to trust. */
  private isRecent(timestamp: number): boolean {
    return (Date.now() - timestamp) < DEFAULT_PEER_TTL_MS;
  }

  /** Convert a proximity entry to a Route. */
  private peerToRoute(peer: PeerProximityEntry, destHash: Uint8Array): Route {
    const now = Date.now();
    return {
      destHash,
      nextHop: peer.relayPath.length > 0 ? peer.relayPath[0] : peer.peerId,
      hopCount: peer.hopCount,
      estimatedLatency: peer.latency,
      discoveredAt: now,
      expiresAt: now + this.routeTtlMs,
    };
  }

  /** Resolve a pending request by selecting the best offer. */
  private resolvePendingRequest(key: string): void {
    const pending = this.pendingRequests.get(key);
    if (!pending) return;

    this.pendingRequests.delete(key);

    if (pending.offers.length === 0) {
      pending.resolve(null);
      return;
    }

    // Select best offer: prefer fewest hops, then lowest latency.
    pending.offers.sort((a, b) => {
      if (a.hopCount !== b.hopCount) return a.hopCount - b.hopCount;
      return a.estimatedLatency - b.estimatedLatency;
    });

    const best = pending.offers[0];
    const now = Date.now();
    const route: Route = {
      destHash: pending.request.destHash,
      nextHop: best.offeredBy,
      hopCount: best.hopCount,
      estimatedLatency: best.estimatedLatency,
      discoveredAt: now,
      expiresAt: now + this.routeTtlMs,
    };

    this.routeCache.cacheRoute(route);
    pending.resolve(route);
  }

  /** Remove pending requests that have exceeded their timeout. */
  private pruneExpiredRequests(): void {
    const now = Date.now();
    for (const [key, pending] of this.pendingRequests) {
      if (now - pending.createdAt > pending.timeoutMs) {
        this.pendingRequests.delete(key);
        pending.resolve(null);
      }
    }
  }

  /** Generate a random 16-byte request ID. */
  private generateRequestId(): Uint8Array {
    const id = new Uint8Array(16);
    if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.getRandomValues === 'function') {
      globalThis.crypto.getRandomValues(id);
    } else {
      // Fallback for environments without Web Crypto.
      for (let i = 0; i < 16; i++) {
        id[i] = Math.floor(Math.random() * 256);
      }
    }
    return id;
  }
}
