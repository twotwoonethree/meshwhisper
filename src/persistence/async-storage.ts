// ============================================================
// MeshWhisper SDK — AsyncStorage backend for React Native
//
// React Native has no `indexedDB` and no `fs`. The community-
// standard persistence primitive is `@react-native-async-storage/
// async-storage`, an async string KV store with global
// (per-app) namespacing.
//
// We don't `import` AsyncStorage here — that would pull a
// platform-only dependency into every build of the SDK and break
// browser/Node bundles. Instead, the consumer passes it in:
//
//   import AsyncStorage from '@react-native-async-storage/async-storage';
//   import { AsyncStorageBackend } from '@meshwhisper/sdk/react-native';
//   const storage = new AsyncStorageBackend(AsyncStorage, 'com.yourapp');
//
// The constructor accepts anything that implements the four
// AsyncStorage methods we use (see `AsyncStorageLike`). That keeps
// the SDK genuinely platform-agnostic and lets you swap in mocks
// for testing.
// ============================================================

import type { StorageBackend } from './types.js';

/**
 * Subset of `@react-native-async-storage/async-storage`'s API that the
 * SDK touches. Anything that implements these four methods works —
 * including a Map-backed mock for tests.
 */
export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
}

/**
 * StorageBackend over a community-standard React Native AsyncStorage.
 *
 * Per-instance namespace prefix isolates this app's keys from anything
 * else the host RN app stores in AsyncStorage (typically just the
 * bundle ID; the same string used as MeshWhisper's `namespace` is a
 * sensible default).
 */
export class AsyncStorageBackend implements StorageBackend {
  private readonly prefix: string;

  constructor(
    private readonly asyncStorage: AsyncStorageLike,
    namespace: string,
  ) {
    if (!namespace) throw new Error('AsyncStorageBackend: namespace is required');
    this.prefix = `meshwhisper:${namespace}:`;
  }

  async get(key: string): Promise<string | null> {
    return await this.asyncStorage.getItem(this.prefix + key);
  }

  async set(key: string, value: string): Promise<void> {
    await this.asyncStorage.setItem(this.prefix + key, value);
  }

  async delete(key: string): Promise<void> {
    await this.asyncStorage.removeItem(this.prefix + key);
  }

  /**
   * Returns keys (without the namespace prefix) that start with `prefix`.
   * Walks `getAllKeys()` and filters in-process — AsyncStorage doesn't
   * have a prefix-scan primitive. Fine for typical MeshWhisper key
   * counts (low thousands at most for an active user); if you ever need
   * to scale beyond that, replace this backend with one built on
   * `expo-sqlite` or `op-sqlite` and a per-prefix index.
   */
  async keys(prefix: string): Promise<string[]> {
    const all = await this.asyncStorage.getAllKeys();
    const fullPrefix = this.prefix + prefix;
    const out: string[] = [];
    for (const k of all ?? []) {
      if (k.startsWith(fullPrefix)) out.push(k.slice(this.prefix.length));
    }
    return out;
  }
}
