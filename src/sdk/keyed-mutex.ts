// ============================================================
// MeshWhisper SDK — Keyed mutex for serialising async RMW
//
// Storage operations like saveMessage are read-modify-write on async
// kv storage. Two concurrent operations on the same key race and one
// silently loses its write — classic lost-update bug. This mutex lets
// callers say "while I'm working on this key, hold everyone else off."
//
// Usage:
//   await mutex.run('messages/peerX', async () => {
//     const cur = await storage.get('messages/peerX');
//     const next = mutate(cur);
//     await storage.set('messages/peerX', next);
//   });
// ============================================================

export class KeyedMutex {
  private readonly chains = new Map<string, Promise<unknown>>();

  /**
   * Run `fn` exclusively for `key`. Any concurrent `run` calls for the
   * same key wait their turn and execute in submission order. Different
   * keys do not block each other.
   */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(key, next);
    try {
      return await next;
    } finally {
      // Clean up if our chain link is still the tail. Avoids unbounded
      // map growth across many distinct keys over time.
      if (this.chains.get(key) === next) this.chains.delete(key);
    }
  }
}
