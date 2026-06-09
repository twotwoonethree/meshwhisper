// ============================================================
// Persisted device-announcement replay protection
//
// Phase B v1 kept the per-(account, device) LWW seen-map in memory
// only. A fresh device boot — or any process restart — had no
// historical replay protection: an attacker who captured an old
// `device_revoked` could replay it after a re-add and silently
// undo the re-add.
//
// These tests pin the persistence contract (storage key, JSON
// shape) and the rehydrate-on-load behaviour.
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  readDeviceAnnouncementSeen,
  writeDeviceAnnouncementSeen,
} from '../src/sdk/archive.js';
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

describe('readDeviceAnnouncementSeen / writeDeviceAnnouncementSeen', () => {
  it('writes under the documented storage key', async () => {
    const m = new Map<string, string>();
    const storage: StorageBackend = {
      async get(k) { return m.get(k) ?? null; },
      async set(k, v) { m.set(k, v); },
      async delete(k) { m.delete(k); },
      async keys(prefix) { return Array.from(m.keys()).filter((k) => k.startsWith(prefix)); },
    };
    await writeDeviceAnnouncementSeen(storage, { 'acc:dev': 1000 });
    expect(m.has('device_announcement_seen')).toBe(true);
  });

  it('round-trips a non-trivial map', async () => {
    const storage = makeStorage();
    const original: Record<string, number> = {
      'aaaa1111:bbbb2222': 100,
      'aaaa1111:cccc3333': 200,
      'dddd4444:eeee5555': 300,
    };
    await writeDeviceAnnouncementSeen(storage, original);
    const got = await readDeviceAnnouncementSeen(storage);
    expect(got).toEqual(original);
  });

  it('returns {} when the key is absent', async () => {
    const storage = makeStorage();
    expect(await readDeviceAnnouncementSeen(storage)).toEqual({});
  });

  it('returns {} when the stored value is malformed (best-effort recovery)', async () => {
    const storage = makeStorage({ device_announcement_seen: 'not valid json {' });
    expect(await readDeviceAnnouncementSeen(storage)).toEqual({});
  });

  it('overwrites on subsequent writes (LWW semantics at storage layer)', async () => {
    const storage = makeStorage();
    await writeDeviceAnnouncementSeen(storage, { 'acc:dev': 100 });
    await writeDeviceAnnouncementSeen(storage, { 'acc:dev': 500, 'acc:dev2': 100 });
    const got = await readDeviceAnnouncementSeen(storage);
    expect(got).toEqual({ 'acc:dev': 500, 'acc:dev2': 100 });
  });
});
