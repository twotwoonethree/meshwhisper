// StorageBackend matches @meshwhisper/sdk's interface exactly
interface StorageBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
}

const DB_NAME = 'prudence';
const STORE_NAME = 'kv';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;
function getDb(): Promise<IDBDatabase> {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

function tx(db: IDBDatabase, mode: IDBTransactionMode) {
  return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const idbStorage: StorageBackend = {
  async get(key: string) {
    const db = await getDb();
    const val = await wrap<unknown>(tx(db, 'readonly').get(key));
    return typeof val === 'string' ? val : null;
  },
  async set(key: string, value: string) {
    const db = await getDb();
    await wrap(tx(db, 'readwrite').put(value, key));
  },
  async delete(key: string) {
    const db = await getDb();
    await wrap(tx(db, 'readwrite').delete(key));
  },
  async keys(prefix: string) {
    const db = await getDb();
    const range = IDBKeyRange.bound(prefix, prefix + '￿');
    const keys = await wrap<IDBValidKey[]>(tx(db, 'readonly').getAllKeys(range));
    return (keys as string[]).filter((k) => k.startsWith(prefix));
  },
};
