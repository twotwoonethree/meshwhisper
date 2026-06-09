// ============================================================
// Disappearing-messages policy (per-conversation TTL)
//
// The SDK-level setDisappearingMessages + auto-expiry on send hangs
// off a small Map<conversationId, ttlMs>, persisted under
// 'disappearing_messages'. Tests focus on the persistence contract
// and the toggle semantics; the actual auto-expiry of stored
// messages is covered by the existing retention-export suite (it
// just sets `expiresAt` and lets the existing eviction code run).
// ============================================================

import { describe, it, expect } from 'vitest';
import type { StorageBackend } from '../src/types.js';

function makeStorage(seed: Record<string, string> = {}): StorageBackend {
  const m = new Map<string, string>(Object.entries(seed));
  return {
    async get(k) { return m.get(k) ?? null; },
    async set(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async keys(prefix) { return Array.from(m.keys()).filter((k) => k.startsWith(prefix)); },
  };
}

/**
 * Mirror of what `loadPersistedState` does for the disappearing map.
 * Exists so the persistence shape is testable without spinning up a
 * full SDK (which needs a relay).
 */
async function readDisappearingMessages(storage: StorageBackend): Promise<Map<string, number>> {
  const raw = await storage.get('disappearing_messages');
  const map = new Map<string, number>();
  if (!raw) return map;
  try {
    const obj = JSON.parse(raw) as Record<string, number>;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'number' && v > 0) map.set(k, v);
    }
  } catch { /* malformed — return empty map */ }
  return map;
}

/** Symmetric writer matching the SDK's persistDisappearingMessages. */
async function writeDisappearingMessages(storage: StorageBackend, map: Map<string, number>): Promise<void> {
  const obj: Record<string, number> = {};
  for (const [k, v] of map) obj[k] = v;
  await storage.set('disappearing_messages', JSON.stringify(obj));
}

describe('Disappearing-messages persistence', () => {
  it('reads {} when the storage key is absent', async () => {
    const m = await readDisappearingMessages(makeStorage());
    expect(m.size).toBe(0);
  });

  it('round-trips a multi-conversation policy', async () => {
    const storage = makeStorage();
    const map = new Map<string, number>([
      ['alice', 7 * 24 * 60 * 60 * 1000], // 7 days
      ['bob', 60 * 1000],                  // 1 minute
    ]);
    await writeDisappearingMessages(storage, map);
    const got = await readDisappearingMessages(storage);
    expect(got.get('alice')).toBe(7 * 24 * 60 * 60 * 1000);
    expect(got.get('bob')).toBe(60 * 1000);
  });

  it('drops malformed JSON to empty', async () => {
    const storage = makeStorage({ disappearing_messages: '{ this is not json' });
    const m = await readDisappearingMessages(storage);
    expect(m.size).toBe(0);
  });

  it('drops non-positive values defensively', async () => {
    const storage = makeStorage({ disappearing_messages: JSON.stringify({
      alice: 5000,
      bob: 0,
      carol: -100,
      dave: 'not-a-number',
    }) });
    const m = await readDisappearingMessages(storage);
    expect(m.get('alice')).toBe(5000);
    expect(m.has('bob')).toBe(false);
    expect(m.has('carol')).toBe(false);
    expect(m.has('dave')).toBe(false);
  });

  it('overwriting the policy persists the new state, not the diff', async () => {
    const storage = makeStorage();
    await writeDisappearingMessages(storage, new Map([['alice', 1000], ['bob', 2000]]));
    await writeDisappearingMessages(storage, new Map([['alice', 5000]])); // bob dropped
    const got = await readDisappearingMessages(storage);
    expect(got.get('alice')).toBe(5000);
    expect(got.has('bob')).toBe(false);
  });
});

describe('TTL normalisation (matches SDK setDisappearingMessages)', () => {
  // Mirror of the normalisation in setDisappearingMessagesInstance.
  function normalize(ttlMs: number | null | undefined): number | null {
    return ttlMs && ttlMs > 0 ? Math.floor(ttlMs) : null;
  }

  it('positive values pass through (floored)', () => {
    expect(normalize(7000)).toBe(7000);
    expect(normalize(1234.5)).toBe(1234);
  });

  it('null / 0 / negative all normalize to null (clear policy)', () => {
    expect(normalize(null)).toBe(null);
    expect(normalize(0)).toBe(null);
    expect(normalize(-100)).toBe(null);
  });

  it('undefined normalises to null', () => {
    expect(normalize(undefined)).toBe(null);
  });
});
