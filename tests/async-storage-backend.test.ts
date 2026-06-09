// ============================================================
// AsyncStorageBackend — adapter over the React Native AsyncStorage API
//
// Tested against a Map-backed mock that mirrors AsyncStorage's
// four-method surface. The whole point of accepting an AsyncStorageLike
// in the constructor (rather than importing AsyncStorage directly) is
// that the same code runs against any conforming impl, so testing
// against a fake is faithful — there's no platform-specific behaviour
// hidden inside.
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { AsyncStorageBackend, type AsyncStorageLike } from '../src/persistence/async-storage.js';

function makeMockAsyncStorage(): AsyncStorageLike & { _store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    _store: store,
    async getItem(key) { return store.get(key) ?? null; },
    async setItem(key, value) { store.set(key, value); },
    async removeItem(key) { store.delete(key); },
    async getAllKeys() { return Array.from(store.keys()); },
  };
}

describe('AsyncStorageBackend', () => {
  let mock: ReturnType<typeof makeMockAsyncStorage>;
  let backend: AsyncStorageBackend;

  beforeEach(() => {
    mock = makeMockAsyncStorage();
    backend = new AsyncStorageBackend(mock, 'com.test.app');
  });

  it('namespaces every write under meshwhisper:<namespace>:', async () => {
    await backend.set('identity', 'hex...');
    expect(mock._store.has('meshwhisper:com.test.app:identity')).toBe(true);
    expect(mock._store.has('identity')).toBe(false);
  });

  it('round-trips a value through set/get', async () => {
    await backend.set('foo', 'bar');
    expect(await backend.get('foo')).toBe('bar');
  });

  it('returns null for a missing key', async () => {
    expect(await backend.get('not-set')).toBeNull();
  });

  it('delete removes the namespaced key without touching others', async () => {
    await backend.set('a', '1');
    await backend.set('b', '2');
    await backend.delete('a');
    expect(await backend.get('a')).toBeNull();
    expect(await backend.get('b')).toBe('2');
  });

  it('keys(prefix) returns unprefixed keys matching the in-namespace prefix', async () => {
    await backend.set('peers/aaaa', '1');
    await backend.set('peers/bbbb', '2');
    await backend.set('messages/cccc', '3');
    await backend.set('identity', '4');
    const peerKeys = await backend.keys('peers/');
    expect(peerKeys.sort()).toEqual(['peers/aaaa', 'peers/bbbb']);
    const msgKeys = await backend.keys('messages/');
    expect(msgKeys).toEqual(['messages/cccc']);
  });

  it('keys() with empty prefix returns every in-namespace key', async () => {
    await backend.set('a', '1');
    await backend.set('b/c', '2');
    const all = await backend.keys('');
    expect(all.sort()).toEqual(['a', 'b/c']);
  });

  it('two backends with different namespaces are isolated', async () => {
    const backendA = new AsyncStorageBackend(mock, 'app.a');
    const backendB = new AsyncStorageBackend(mock, 'app.b');
    await backendA.set('foo', 'A');
    await backendB.set('foo', 'B');
    expect(await backendA.get('foo')).toBe('A');
    expect(await backendB.get('foo')).toBe('B');
    expect(await backendA.keys('')).toEqual(['foo']);
    expect(await backendB.keys('')).toEqual(['foo']);
  });

  it('handles getAllKeys returning a readonly array (RN typing)', async () => {
    // AsyncStorage's official type is `Promise<readonly string[]>`. The
    // backend must not assume mutability.
    const readonlyMock: AsyncStorageLike = {
      ...mock,
      async getAllKeys(): Promise<readonly string[]> {
        return Object.freeze(Array.from(mock._store.keys()));
      },
    };
    const b = new AsyncStorageBackend(readonlyMock, 'com.test.app');
    await backend.set('hello', 'world');
    expect(await b.get('hello')).toBe('world');
    expect(await b.keys('')).toEqual(['hello']);
  });

  it('constructor throws on empty namespace', () => {
    expect(() => new AsyncStorageBackend(mock, '')).toThrow(/namespace/);
  });
});
