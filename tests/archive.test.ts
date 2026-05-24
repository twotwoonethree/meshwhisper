import { describe, it, expect, beforeEach } from 'vitest';
import {
  mergeKv,
  readTombstones,
  readRevivals,
  addTombstone,
  addRevival,
} from '../src/sdk/archive.js';
import type { StorageBackend } from '../src/persistence/types.js';

// ---------------------------------------------------------------------------
// In-memory storage shim
// ---------------------------------------------------------------------------

function memoryStorage(initial: Record<string, string> = {}): StorageBackend & { dump: () => Record<string, string> } {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    async get(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    async set(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async keys(prefix: string) {
      return [...store.keys()].filter((k) => k.startsWith(prefix));
    },
    dump() {
      return Object.fromEntries(store);
    },
  };
}

// ===========================================================================
// Tombstone read/write helpers
// ===========================================================================

describe('tombstone helpers', () => {
  it('reads an empty object when no tombstones are stored', async () => {
    const s = memoryStorage();
    expect(await readTombstones(s)).toEqual({});
  });

  it('reads a corrupted tombstones blob as empty', async () => {
    const s = memoryStorage({ tombstones: 'not-json' });
    expect(await readTombstones(s)).toEqual({});
  });

  it('addTombstone records peer with current timestamp', async () => {
    const s = memoryStorage();
    const before = Date.now();
    await addTombstone(s, 'alice');
    const after = Date.now();
    const t = await readTombstones(s);
    expect(Object.keys(t)).toEqual(['alice']);
    expect(t.alice).toBeGreaterThanOrEqual(before);
    expect(t.alice).toBeLessThanOrEqual(after);
  });

  it('addRevival records peer with current timestamp', async () => {
    const s = memoryStorage();
    const before = Date.now();
    await addRevival(s, 'alice');
    const after = Date.now();
    const r = await readRevivals(s);
    expect(Object.keys(r)).toEqual(['alice']);
    expect(r.alice).toBeGreaterThanOrEqual(before);
    expect(r.alice).toBeLessThanOrEqual(after);
  });

  it('addRevival does not delete the tombstone entry', async () => {
    // The revival event is recorded alongside the tombstone — mergeKv picks
    // the most recent of the two. Keeping both lets the revival propagate to
    // other devices that still have the old tombstone.
    const s = memoryStorage();
    await addTombstone(s, 'alice');
    await addRevival(s, 'alice');
    expect(Object.keys(await readTombstones(s))).toEqual(['alice']);
    expect(Object.keys(await readRevivals(s))).toEqual(['alice']);
  });
});

// ===========================================================================
// mergeKv — tombstones suppress resurrection
// ===========================================================================

describe('mergeKv with tombstones', () => {
  let local: ReturnType<typeof memoryStorage>;

  beforeEach(() => {
    local = memoryStorage();
  });

  it('suppresses messages/{peer} from remote when peer is in remote tombstones', async () => {
    await mergeKv(
      { 'messages/alice': JSON.stringify([{ id: 'm1', timestamp: 1 }]) },
      local,
      undefined,
      { alice: Date.now() },
    );
    expect(await local.get('messages/alice')).toBeNull();
  });

  it('suppresses peers/{peer} and edkeys/{peer} for tombstoned peer', async () => {
    await mergeKv(
      {
        'peers/alice': 'aa',
        'edkeys/alice': 'bb',
      },
      local,
      undefined,
      { alice: Date.now() },
    );
    expect(await local.get('peers/alice')).toBeNull();
    expect(await local.get('edkeys/alice')).toBeNull();
  });

  it('filters tombstoned peer out of a unioned contacts array', async () => {
    await local.set('contacts', JSON.stringify(['alice', 'carol']));
    await mergeKv(
      { contacts: JSON.stringify(['alice', 'bob']) },
      local,
      undefined,
      { alice: Date.now() },
    );
    const contacts = JSON.parse(await local.get('contacts') as string) as string[];
    expect(contacts.sort()).toEqual(['bob', 'carol']);
  });

  it('filters tombstoned peer when local had no contacts and remote dropped some directly', async () => {
    // Local has only the tombstone; remote contacts merges in via direct set
    // (no existing local key). Post-merge filter should still apply.
    await mergeKv(
      { contacts: JSON.stringify(['alice', 'bob']) },
      local,
      undefined,
      { alice: 99 },
    );
    const contacts = JSON.parse(await local.get('contacts') as string) as string[];
    expect(contacts).toEqual(['bob']);
  });

  it('still allows non-tombstoned peers through', async () => {
    await mergeKv(
      {
        'messages/alice': JSON.stringify([{ id: 'm1', timestamp: 1 }]),
        'messages/bob': JSON.stringify([{ id: 'm2', timestamp: 2 }]),
        'peers/alice': 'aa',
        'peers/bob': 'bb',
      },
      local,
      undefined,
      { alice: Date.now() },
    );
    expect(await local.get('messages/alice')).toBeNull();
    expect(await local.get('peers/alice')).toBeNull();
    expect(await local.get('messages/bob')).not.toBeNull();
    expect(await local.get('peers/bob')).toBe('bb');
  });

  it('unions local and remote tombstones, taking the max timestamp per peer', async () => {
    await local.set('tombstones', JSON.stringify({ alice: 10, bob: 50 }));
    await mergeKv(
      {},
      local,
      undefined,
      { alice: 30, carol: 100 },
    );
    const merged = await readTombstones(local);
    expect(merged).toEqual({ alice: 30, bob: 50, carol: 100 });
  });

  it('preserves local tombstones when remote sends none', async () => {
    await local.set('tombstones', JSON.stringify({ alice: 10 }));
    await mergeKv({ 'messages/alice': '[]' }, local, undefined, {});
    // Remote messages/alice should be suppressed because LOCAL tombstone applies.
    expect(await local.get('messages/alice')).toBeNull();
    const merged = await readTombstones(local);
    expect(merged).toEqual({ alice: 10 });
  });

  it('messages/ for non-tombstoned peer still does id-based merge', async () => {
    await local.set('messages/bob', JSON.stringify([
      { id: 'a', timestamp: 1 },
      { id: 'b', timestamp: 2 },
    ]));
    await mergeKv(
      {
        'messages/bob': JSON.stringify([
          { id: 'b', timestamp: 2 },
          { id: 'c', timestamp: 3 },
        ]),
      },
      local,
    );
    const msgs = JSON.parse(await local.get('messages/bob') as string) as Array<{ id: string }>;
    expect(msgs.map((m) => m.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('end-to-end: delete → push → pull does not resurrect', async () => {
    // Simulate the bug scenario.
    // Step 1: pre-delete local state.
    await local.set('contacts', JSON.stringify(['alice', 'bob']));
    await local.set('messages/alice', JSON.stringify([{ id: 'm1', timestamp: 1 }]));
    await local.set('peers/alice', 'a-pub');
    await local.set('edkeys/alice', 'a-ed');

    // Step 2: snapshot the relay archive at this moment (this is what
    // gets pulled back later).
    const relayKv = {
      contacts: JSON.stringify(['alice', 'bob']),
      'messages/alice': JSON.stringify([{ id: 'm1', timestamp: 1 }]),
      'peers/alice': 'a-pub',
      'edkeys/alice': 'a-ed',
    };

    // Step 3: user deletes Alice locally — wipes keys, sets tombstone.
    await local.delete('messages/alice');
    await local.delete('peers/alice');
    await local.delete('edkeys/alice');
    await local.set('contacts', JSON.stringify(['bob']));
    await addTombstone(local, 'alice');

    // Step 4: app reopens, pulls the (pre-delete) relay archive. The remote
    // tombstones map is empty because the push hadn't happened yet — this is
    // the exact race the user reported.
    await mergeKv(relayKv, local, undefined, {});

    // Step 5: Alice must still be gone.
    expect(await local.get('messages/alice')).toBeNull();
    expect(await local.get('peers/alice')).toBeNull();
    expect(await local.get('edkeys/alice')).toBeNull();
    const contacts = JSON.parse(await local.get('contacts') as string) as string[];
    expect(contacts).toEqual(['bob']);
  });

  it('revival beats a stale remote tombstone — re-add survives reload', async () => {
    // The follow-up bug: user deleted Alice, then re-added her, but the
    // post-revival archive push never reached the relay (e.g. Prudence handler
    // missed scheduleArchiveSync). On next reload, the relay archive still
    // has the tombstone — and without revivals, mergeKv re-applies it.
    // With revivals, the locally-recorded revival event beats the stale
    // remote tombstone.

    // Local state post-re-add: contacts include alice, tombstone older, revival fresh.
    await local.set('contacts', JSON.stringify(['alice', 'bob']));
    await local.set('tombstones', JSON.stringify({ alice: 100 }));
    await local.set('revivals', JSON.stringify({ alice: 200 }));

    // Stale relay archive: still has the tombstone, no revival, contacts pre-add.
    await mergeKv(
      { contacts: JSON.stringify(['bob']) },
      local,
      undefined,
      { alice: 100 },
      {},
    );

    const contacts = JSON.parse(await local.get('contacts') as string) as string[];
    expect(contacts.sort()).toEqual(['alice', 'bob']);
  });

  it('revival in remote archive beats local tombstone (cross-device re-add)', async () => {
    // Another device re-added Alice and pushed the revival. This device still
    // has the old tombstone but no revival yet. Merge should clear the
    // suppression because the remote revival is newer.
    await local.set('tombstones', JSON.stringify({ alice: 100 }));

    await mergeKv(
      {
        contacts: JSON.stringify(['alice']),
        'messages/alice': JSON.stringify([{ id: 'm1', timestamp: 1 }]),
      },
      local,
      undefined,
      { alice: 100 },
      { alice: 200 },
    );

    expect(await local.get('messages/alice')).not.toBeNull();
    const contacts = JSON.parse(await local.get('contacts') as string) as string[];
    expect(contacts).toEqual(['alice']);
  });

  it('tombstone newer than revival still suppresses (re-delete after re-add)', async () => {
    // User re-added then re-deleted. The newer tombstone should win.
    await local.set('tombstones', JSON.stringify({ alice: 300 }));
    await local.set('revivals', JSON.stringify({ alice: 200 }));

    await mergeKv(
      { 'messages/alice': JSON.stringify([{ id: 'm1', timestamp: 1 }]) },
      local,
      undefined,
      { alice: 300 },
      { alice: 200 },
    );

    expect(await local.get('messages/alice')).toBeNull();
  });
});
