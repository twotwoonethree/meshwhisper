import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PeerProximityTable,
  SocialGraphRouter,
  type Route,
} from '../src/routing/index.js';
import {
  PacketFlags,
  type Packet,
  type PeerProximityEntry,
  type RouteOffer,
  type RouteRequest,
} from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function destHash(byte: number): Uint8Array {
  return new Uint8Array(8).fill(byte);
}

function makePeer(overrides: Partial<PeerProximityEntry> & { peerId: string }): PeerProximityEntry {
  return {
    peerId: overrides.peerId,
    destHash: overrides.destHash ?? destHash(0xaa),
    lastSeen: overrides.lastSeen ?? Date.now(),
    hopCount: overrides.hopCount ?? 1,
    latency: overrides.latency ?? 50,
    relayPath: overrides.relayPath ?? [],
  };
}

function makePacket(overrides: Partial<Packet> = {}): Packet {
  return {
    version: 1,
    flags: PacketFlags.DATA,
    destHash: overrides.destHash ?? destHash(0xaa),
    senderEphemeralId: overrides.senderEphemeralId ?? new Uint8Array(16).fill(0xcd),
    ttl: overrides.ttl ?? 5,
    payloadLength: overrides.payloadLength ?? 4,
    encryptedPayload: overrides.encryptedPayload ?? new Uint8Array([1, 2, 3, 4]),
  };
}

// ===========================================================================
// PeerProximityTable
// ===========================================================================

describe('PeerProximityTable', () => {
  describe('addPeer / findPeer', () => {
    it('stores and retrieves a peer by destHash', () => {
      const table = new PeerProximityTable();
      const peer = makePeer({ peerId: 'alice', destHash: destHash(0x11) });
      table.addPeer(peer);

      const found = table.findPeer(destHash(0x11));
      expect(found).not.toBeNull();
      expect(found?.peerId).toBe('alice');
    });

    it('returns null for unknown destHash', () => {
      const table = new PeerProximityTable();
      expect(table.findPeer(destHash(0x99))).toBeNull();
    });

    it('addPeer with existing peerId replaces the entry', () => {
      const table = new PeerProximityTable();
      table.addPeer(makePeer({ peerId: 'alice', destHash: destHash(0x11), latency: 10 }));
      table.addPeer(makePeer({ peerId: 'alice', destHash: destHash(0x11), latency: 999 }));

      expect(table.size).toBe(1);
      expect(table.findPeer(destHash(0x11))?.latency).toBe(999);
    });
  });

  describe('removePeer', () => {
    it('removes the peer and clears the destHash index', () => {
      const table = new PeerProximityTable();
      table.addPeer(makePeer({ peerId: 'alice', destHash: destHash(0x11) }));
      table.removePeer('alice');

      expect(table.size).toBe(0);
      expect(table.findPeer(destHash(0x11))).toBeNull();
    });

    it('is a no-op for unknown peer', () => {
      const table = new PeerProximityTable();
      table.addPeer(makePeer({ peerId: 'alice', destHash: destHash(0x11) }));
      table.removePeer('nobody');

      expect(table.size).toBe(1);
    });
  });

  describe('updatePeer', () => {
    it('merges partial updates into existing entry', () => {
      const table = new PeerProximityTable();
      table.addPeer(makePeer({ peerId: 'alice', latency: 50, hopCount: 1 }));
      table.updatePeer('alice', { latency: 75 });

      const found = table.findPeer(destHash(0xaa));
      expect(found?.latency).toBe(75);
      expect(found?.hopCount).toBe(1);
    });

    it('rewires destHash index when destHash changes', () => {
      const table = new PeerProximityTable();
      table.addPeer(makePeer({ peerId: 'alice', destHash: destHash(0x11) }));
      table.updatePeer('alice', { destHash: destHash(0x22) });

      expect(table.findPeer(destHash(0x11))).toBeNull();
      expect(table.findPeer(destHash(0x22))?.peerId).toBe('alice');
    });

    it('does not touch index when destHash bytes are identical', () => {
      const table = new PeerProximityTable();
      table.addPeer(makePeer({ peerId: 'alice', destHash: destHash(0x11) }));
      // Same bytes, different Uint8Array instance.
      table.updatePeer('alice', { destHash: destHash(0x11), latency: 5 });

      expect(table.findPeer(destHash(0x11))?.latency).toBe(5);
    });

    it('is a no-op for unknown peer', () => {
      const table = new PeerProximityTable();
      table.updatePeer('ghost', { latency: 1 });
      expect(table.size).toBe(0);
    });
  });

  describe('getClosestPeers (XOR distance)', () => {
    it('sorts peers closest-first by XOR distance', () => {
      const table = new PeerProximityTable();
      // Target = 0x00. Distance is determined by destHash bytes XOR'd with 0.
      table.addPeer(makePeer({ peerId: 'far', destHash: destHash(0xff) }));
      table.addPeer(makePeer({ peerId: 'near', destHash: destHash(0x01) }));
      table.addPeer(makePeer({ peerId: 'mid', destHash: destHash(0x80) }));

      const closest = table.getClosestPeers(destHash(0x00), 3);
      expect(closest.map(p => p.peerId)).toEqual(['near', 'mid', 'far']);
    });

    it('clamps to the requested count', () => {
      const table = new PeerProximityTable();
      table.addPeer(makePeer({ peerId: 'a', destHash: destHash(0x01) }));
      table.addPeer(makePeer({ peerId: 'b', destHash: destHash(0x02) }));
      table.addPeer(makePeer({ peerId: 'c', destHash: destHash(0x03) }));

      expect(table.getClosestPeers(destHash(0x00), 2)).toHaveLength(2);
    });

    it('returns empty array when table is empty', () => {
      const table = new PeerProximityTable();
      expect(table.getClosestPeers(destHash(0x00), 5)).toEqual([]);
    });
  });

  describe('pruneStale', () => {
    it('removes entries older than maxAgeMs', () => {
      const table = new PeerProximityTable();
      const now = Date.now();
      table.addPeer(makePeer({ peerId: 'old', lastSeen: now - 10_000 }));
      table.addPeer(makePeer({ peerId: 'fresh', destHash: destHash(0xbb), lastSeen: now }));

      table.pruneStale(5_000);

      expect(table.size).toBe(1);
      expect(table.findPeer(destHash(0xaa))).toBeNull();
      expect(table.findPeer(destHash(0xbb))?.peerId).toBe('fresh');
    });

    it('uses the constructor TTL when no argument is passed', () => {
      const table = new PeerProximityTable(1_000);
      table.addPeer(makePeer({ peerId: 'old', lastSeen: Date.now() - 10_000 }));

      table.pruneStale();
      expect(table.size).toBe(0);
    });
  });

  describe('allEntries', () => {
    it('returns a snapshot of all entries', () => {
      const table = new PeerProximityTable();
      table.addPeer(makePeer({ peerId: 'a', destHash: destHash(0x01) }));
      table.addPeer(makePeer({ peerId: 'b', destHash: destHash(0x02) }));

      const snapshot = table.allEntries();
      expect(snapshot).toHaveLength(2);

      // Mutating the snapshot doesn't affect the table.
      snapshot.pop();
      expect(table.size).toBe(2);
    });
  });
});

// ===========================================================================
// SocialGraphRouter — route cache
// ===========================================================================

describe('SocialGraphRouter.routeCache', () => {
  it('cacheRoute / getCachedRoute roundtrip', () => {
    const router = new SocialGraphRouter('me', new PeerProximityTable());
    const route: Route = {
      destHash: destHash(0x11),
      nextHop: 'alice',
      hopCount: 2,
      estimatedLatency: 100,
      discoveredAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    router.cacheRoute(route);

    expect(router.getCachedRoute(destHash(0x11))?.nextHop).toBe('alice');
  });

  it('returns null for unknown destHash', () => {
    const router = new SocialGraphRouter('me', new PeerProximityTable());
    expect(router.getCachedRoute(destHash(0x99))).toBeNull();
  });

  it('returns null for expired routes and evicts them', () => {
    const router = new SocialGraphRouter('me', new PeerProximityTable());
    router.cacheRoute({
      destHash: destHash(0x11),
      nextHop: 'alice',
      hopCount: 1,
      estimatedLatency: 10,
      discoveredAt: Date.now() - 60_000,
      expiresAt: Date.now() - 1,
    });

    expect(router.getCachedRoute(destHash(0x11))).toBeNull();
    // Subsequent lookups also miss (evicted).
    expect(router.getCachedRoute(destHash(0x11))).toBeNull();
  });

  it('invalidateRoute removes a cached route', () => {
    const router = new SocialGraphRouter('me', new PeerProximityTable());
    router.cacheRoute({
      destHash: destHash(0x11),
      nextHop: 'alice',
      hopCount: 1,
      estimatedLatency: 10,
      discoveredAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    router.invalidateRoute(destHash(0x11));

    expect(router.getCachedRoute(destHash(0x11))).toBeNull();
  });
});

// ===========================================================================
// SocialGraphRouter.findRoute
// ===========================================================================

describe('SocialGraphRouter.findRoute', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('short-circuits to cached route when present', async () => {
    const router = new SocialGraphRouter('me', new PeerProximityTable());
    const cached: Route = {
      destHash: destHash(0x11),
      nextHop: 'alice',
      hopCount: 1,
      estimatedLatency: 42,
      discoveredAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    router.cacheRoute(cached);

    const found = await router.findRoute(destHash(0x11));
    expect(found?.nextHop).toBe('alice');
    expect(found?.estimatedLatency).toBe(42);
  });

  it('resolves immediately when a direct peer is known', async () => {
    const table = new PeerProximityTable();
    table.addPeer(makePeer({ peerId: 'alice', destHash: destHash(0x11), hopCount: 1, latency: 33 }));
    const router = new SocialGraphRouter('me', table);

    const found = await router.findRoute(destHash(0x11));
    expect(found).not.toBeNull();
    expect(found?.nextHop).toBe('alice');
    expect(found?.hopCount).toBe(1);
    expect(found?.estimatedLatency).toBe(33);
  });

  it('uses the first relayPath hop as nextHop when present', async () => {
    const table = new PeerProximityTable();
    table.addPeer(makePeer({
      peerId: 'alice',
      destHash: destHash(0x11),
      relayPath: ['bob', 'carol'],
    }));
    const router = new SocialGraphRouter('me', table);

    const found = await router.findRoute(destHash(0x11));
    expect(found?.nextHop).toBe('bob');
  });

  it('caches the route discovered via direct peer lookup', async () => {
    const table = new PeerProximityTable();
    table.addPeer(makePeer({ peerId: 'alice', destHash: destHash(0x11) }));
    const router = new SocialGraphRouter('me', table);

    await router.findRoute(destHash(0x11));
    expect(router.getCachedRoute(destHash(0x11))?.nextHop).toBe('alice');
  });

  it('resolves to null when no offers arrive before timeout', async () => {
    const router = new SocialGraphRouter('me', new PeerProximityTable(), {
      requestTimeoutMs: 1_000,
    });

    const promise = router.findRoute(destHash(0x99));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await promise).toBeNull();
  });

  it('selects the offer with fewest hops, then lowest latency', async () => {
    const router = new SocialGraphRouter('me', new PeerProximityTable(), {
      requestTimeoutMs: 1_000,
    });

    const promise = router.findRoute(destHash(0x99));

    const [pending] = router.getPendingRequests();
    expect(pending).toBeDefined();

    router.handleRouteOffer({
      requestId: pending.requestId,
      hopCount: 4,
      estimatedLatency: 10,
      offeredBy: 'far-but-fast',
    });
    router.handleRouteOffer({
      requestId: pending.requestId,
      hopCount: 2,
      estimatedLatency: 500,
      offeredBy: 'near-but-slow',
    });
    router.handleRouteOffer({
      requestId: pending.requestId,
      hopCount: 2,
      estimatedLatency: 100,
      offeredBy: 'best',
    });

    await vi.advanceTimersByTimeAsync(1_000);
    const route = await promise;

    expect(route?.nextHop).toBe('best');
    expect(route?.hopCount).toBe(2);
    expect(route?.estimatedLatency).toBe(100);
  });

  it('caches the discovered route after offer resolution', async () => {
    const router = new SocialGraphRouter('me', new PeerProximityTable(), {
      requestTimeoutMs: 1_000,
    });

    const promise = router.findRoute(destHash(0x99));
    const [pending] = router.getPendingRequests();
    router.handleRouteOffer({
      requestId: pending.requestId,
      hopCount: 3,
      estimatedLatency: 200,
      offeredBy: 'alice',
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await promise;

    expect(router.getCachedRoute(destHash(0x99))?.nextHop).toBe('alice');
  });

  it('drops offers whose requestId has no matching pending request', async () => {
    const router = new SocialGraphRouter('me', new PeerProximityTable(), {
      requestTimeoutMs: 1_000,
    });

    // No findRoute was called — this offer should be silently ignored.
    router.handleRouteOffer({
      requestId: new Uint8Array(16).fill(0xff),
      hopCount: 1,
      estimatedLatency: 10,
      offeredBy: 'alice',
    });

    expect(router.getPendingRequests()).toHaveLength(0);
  });

  it('ignores stale proximity entries and falls through to gossip', async () => {
    const table = new PeerProximityTable();
    // Lastseen older than DEFAULT_PEER_TTL_MS (1h) — should be treated as not recent.
    table.addPeer(makePeer({
      peerId: 'alice',
      destHash: destHash(0x11),
      lastSeen: Date.now() - (2 * 60 * 60 * 1000),
    }));
    const router = new SocialGraphRouter('me', table, { requestTimeoutMs: 500 });

    const promise = router.findRoute(destHash(0x11));
    // No offers will arrive — should time out to null rather than returning alice.
    await vi.advanceTimersByTimeAsync(500);
    expect(await promise).toBeNull();
  });

  it('generates unique requestIds across calls', async () => {
    const router = new SocialGraphRouter('me', new PeerProximityTable(), {
      requestTimeoutMs: 1_000,
    });

    void router.findRoute(destHash(0x91));
    void router.findRoute(destHash(0x92));
    void router.findRoute(destHash(0x93));

    const pending = router.getPendingRequests();
    const seen = new Set(pending.map(p => Array.from(p.requestId).join(',')));
    expect(seen.size).toBe(3);

    await vi.advanceTimersByTimeAsync(1_000);
  });
});

// ===========================================================================
// SocialGraphRouter — request/offer handling
// ===========================================================================

describe('SocialGraphRouter.handleRouteRequest', () => {
  it('returns an offer with hopCount+1 when destination is known', () => {
    const table = new PeerProximityTable();
    table.addPeer(makePeer({
      peerId: 'alice',
      destHash: destHash(0x11),
      hopCount: 2,
      latency: 80,
    }));
    const router = new SocialGraphRouter('me', table);

    const request: RouteRequest = {
      destHash: destHash(0x11),
      requestId: new Uint8Array(16).fill(0x01),
      ttl: 6,
      timestamp: Date.now(),
    };
    const offer = router.handleRouteRequest(request, 'neighbour');

    expect(offer).not.toBeNull();
    expect(offer?.hopCount).toBe(3); // peer hopCount + 1 for self
    expect(offer?.estimatedLatency).toBe(80);
    expect(offer?.offeredBy).toBe('me');
    expect(offer?.requestId).toEqual(request.requestId);
  });

  it('returns null when destination is unknown', () => {
    const router = new SocialGraphRouter('me', new PeerProximityTable());
    const offer = router.handleRouteRequest(
      {
        destHash: destHash(0x99),
        requestId: new Uint8Array(16),
        ttl: 6,
        timestamp: Date.now(),
      },
      'neighbour',
    );
    expect(offer).toBeNull();
  });

  it('returns null when peer entry is stale', () => {
    const table = new PeerProximityTable();
    table.addPeer(makePeer({
      peerId: 'alice',
      destHash: destHash(0x11),
      lastSeen: Date.now() - (2 * 60 * 60 * 1000),
    }));
    const router = new SocialGraphRouter('me', table);

    const offer = router.handleRouteRequest(
      {
        destHash: destHash(0x11),
        requestId: new Uint8Array(16),
        ttl: 6,
        timestamp: Date.now(),
      },
      'neighbour',
    );
    expect(offer).toBeNull();
  });
});

// ===========================================================================
// SocialGraphRouter.getGossipTargets
// ===========================================================================

describe('SocialGraphRouter.getGossipTargets', () => {
  it('returns up to GOSSIP_FANOUT (5) closest peers', () => {
    const table = new PeerProximityTable();
    for (let i = 1; i <= 8; i++) {
      table.addPeer(makePeer({ peerId: `p${i}`, destHash: destHash(i) }));
    }
    const router = new SocialGraphRouter('me', table);

    const targets = router.getGossipTargets(destHash(0x00));
    expect(targets).toHaveLength(5);
    // Closest 5 should be p1..p5 (lowest XOR with 0).
    expect(targets.map(t => t.peerId)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  });

  it('returns fewer than 5 when table is sparse', () => {
    const table = new PeerProximityTable();
    table.addPeer(makePeer({ peerId: 'only', destHash: destHash(0x05) }));
    const router = new SocialGraphRouter('me', table);

    expect(router.getGossipTargets(destHash(0x00))).toHaveLength(1);
  });
});

// ===========================================================================
// SocialGraphRouter.getNextHop
// ===========================================================================

describe('SocialGraphRouter.getNextHop', () => {
  it('prefers cached route over proximity table', () => {
    const table = new PeerProximityTable();
    table.addPeer(makePeer({ peerId: 'direct', destHash: destHash(0x11) }));
    const router = new SocialGraphRouter('me', table);
    router.cacheRoute({
      destHash: destHash(0x11),
      nextHop: 'cached-relay',
      hopCount: 1,
      estimatedLatency: 5,
      discoveredAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });

    expect(router.getNextHop(destHash(0x11))).toBe('cached-relay');
  });

  it('falls back to direct proximity-table entry when not cached', () => {
    const table = new PeerProximityTable();
    table.addPeer(makePeer({ peerId: 'alice', destHash: destHash(0x11) }));
    const router = new SocialGraphRouter('me', table);

    expect(router.getNextHop(destHash(0x11))).toBe('alice');
  });

  it('uses relayPath[0] as next hop when the direct peer has one', () => {
    const table = new PeerProximityTable();
    table.addPeer(makePeer({
      peerId: 'alice',
      destHash: destHash(0x11),
      relayPath: ['hop1', 'hop2'],
    }));
    const router = new SocialGraphRouter('me', table);

    expect(router.getNextHop(destHash(0x11))).toBe('hop1');
  });

  it('falls back to closest peer as heuristic relay', () => {
    const table = new PeerProximityTable();
    // No peer owns 0x11, but 'closest' has a destHash that's nearby.
    table.addPeer(makePeer({ peerId: 'closest', destHash: destHash(0x10) }));
    const router = new SocialGraphRouter('me', table);

    expect(router.getNextHop(destHash(0x11))).toBe('closest');
  });

  it('returns null when no peers are known and no route is cached', () => {
    const router = new SocialGraphRouter('me', new PeerProximityTable());
    expect(router.getNextHop(destHash(0x11))).toBeNull();
  });

  it('ignores stale proximity entries', () => {
    const table = new PeerProximityTable();
    table.addPeer(makePeer({
      peerId: 'alice',
      destHash: destHash(0x11),
      lastSeen: Date.now() - (2 * 60 * 60 * 1000),
    }));
    const router = new SocialGraphRouter('me', table);

    expect(router.getNextHop(destHash(0x11))).toBeNull();
  });
});

// ===========================================================================
// SocialGraphRouter — relay / TTL
// ===========================================================================

describe('SocialGraphRouter.shouldRelay', () => {
  it('returns true for an unseen, live packet', () => {
    const router = new SocialGraphRouter('me', new PeerProximityTable());
    expect(router.shouldRelay(makePacket())).toBe(true);
  });

  it('returns false when TTL is 0', () => {
    const router = new SocialGraphRouter('me', new PeerProximityTable());
    expect(router.shouldRelay(makePacket({ ttl: 0 }))).toBe(false);
  });

  it('deduplicates by packet fingerprint', () => {
    const router = new SocialGraphRouter('me', new PeerProximityTable());
    const packet = makePacket();

    expect(router.shouldRelay(packet)).toBe(true);
    expect(router.shouldRelay(packet)).toBe(false);
  });

  it('treats packets with different payloads as distinct', () => {
    const router = new SocialGraphRouter('me', new PeerProximityTable());
    const a = makePacket({ encryptedPayload: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) });
    const b = makePacket({ encryptedPayload: new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]) });

    expect(router.shouldRelay(a)).toBe(true);
    expect(router.shouldRelay(b)).toBe(true);
  });

  it('treats packets with different senderEphemeralId as distinct', () => {
    const router = new SocialGraphRouter('me', new PeerProximityTable());
    const a = makePacket({ senderEphemeralId: new Uint8Array(16).fill(0x01) });
    const b = makePacket({ senderEphemeralId: new Uint8Array(16).fill(0x02) });

    expect(router.shouldRelay(a)).toBe(true);
    expect(router.shouldRelay(b)).toBe(true);
  });
});

describe('SocialGraphRouter.decrementTTL', () => {
  it('returns a copy with TTL reduced by 1', () => {
    const router = new SocialGraphRouter('me', new PeerProximityTable());
    const original = makePacket({ ttl: 3 });
    const decremented = router.decrementTTL(original);

    expect(decremented.ttl).toBe(2);
    // Original is untouched.
    expect(original.ttl).toBe(3);
  });

  it('throws when TTL is already 0', () => {
    const router = new SocialGraphRouter('me', new PeerProximityTable());
    expect(() => router.decrementTTL(makePacket({ ttl: 0 }))).toThrow(RangeError);
  });

  it('preserves all other packet fields', () => {
    const router = new SocialGraphRouter('me', new PeerProximityTable());
    const original = makePacket({ ttl: 5 });
    const decremented = router.decrementTTL(original);

    expect(decremented.version).toBe(original.version);
    expect(decremented.flags).toBe(original.flags);
    expect(decremented.destHash).toEqual(original.destHash);
    expect(decremented.senderEphemeralId).toEqual(original.senderEphemeralId);
    expect(decremented.encryptedPayload).toEqual(original.encryptedPayload);
  });
});

// ===========================================================================
// SocialGraphRouter — pending requests housekeeping
// ===========================================================================

describe('SocialGraphRouter.getPendingRequests', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns currently pending requests', () => {
    const router = new SocialGraphRouter('me', new PeerProximityTable(), {
      requestTimeoutMs: 1_000,
    });

    void router.findRoute(destHash(0x91));
    void router.findRoute(destHash(0x92));

    const pending = router.getPendingRequests();
    expect(pending).toHaveLength(2);
    expect(pending.map(p => p.destHash[0]).sort()).toEqual([0x91, 0x92]);
  });

  it('prunes expired requests as a side effect', async () => {
    const router = new SocialGraphRouter('me', new PeerProximityTable(), {
      requestTimeoutMs: 100,
    });

    const promise = router.findRoute(destHash(0x91));
    expect(router.getPendingRequests()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await promise;

    expect(router.getPendingRequests()).toHaveLength(0);
  });
});
