// ============================================================
// MeshWhisper SDK — IndexedDB Storage Backend
// Implements StorageBackend for browsers and PWAs using the
// native IndexedDB API. No external dependencies.
// ============================================================

import type { StorageBackend } from './types.js';

const DB_NAME = 'meshwhisper';
const STORE_NAME = 'kv';
const DB_VERSION = 1;

function openDB(namespace: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(`${DB_NAME}:${namespace}`, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * IndexedDB-backed storage for MeshWhisper. Use this in browsers and PWAs.
 *
 * ```ts
 * import { IDBStorage } from '@meshwhisper/sdk/browser';
 *
 * const mw = await MeshWhisper.init({
 *   namespace: 'com.example.app',
 *   storage: new IDBStorage('com.example.app'),
 * });
 * ```
 *
 * When `MeshWhisper.init()` is called in a browser without an explicit
 * `storage` option, an `IDBStorage` is created automatically.
 */
export class IDBStorage implements StorageBackend {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly namespace: string = 'default') {}

  private getDB(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDB(this.namespace);
    }
    return this.dbPromise;
  }

  async get(key: string): Promise<string | null> {
    const db = await this.getDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const val = await request<string | undefined>(tx.objectStore(STORE_NAME).get(key));
    return val ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    const db = await this.getDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    await request(tx.objectStore(STORE_NAME).put(value, key));
  }

  async delete(key: string): Promise<void> {
    const db = await this.getDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    await request(tx.objectStore(STORE_NAME).delete(key));
  }

  async keys(prefix: string): Promise<string[]> {
    const db = await this.getDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const allKeys = await request<IDBValidKey[]>(tx.objectStore(STORE_NAME).getAllKeys());
    return (allKeys as string[]).filter((k) => k.startsWith(prefix));
  }
}
