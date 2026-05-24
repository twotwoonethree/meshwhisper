import { describe, it, expect, beforeEach } from 'vitest';
import { MessageHandler } from '../src/sdk/message-handler.js';
import type { StorageBackend, StoredMessage } from '../src/persistence/types.js';
import type { MessageRetention } from '../src/types.js';

// ---------------------------------------------------------------------------
// In-memory storage for unit tests (mirrors tests/archive.test.ts)
// ---------------------------------------------------------------------------

function memoryStorage(): StorageBackend {
  const store = new Map<string, string>();
  return {
    async get(k) { return store.get(k) ?? null; },
    async set(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
    async keys(prefix) { return [...store.keys()].filter((k) => k.startsWith(prefix)); },
  };
}

// Minimal MessageHandler factory — most callbacks aren't exercised here.
function makeHandler(storage: StorageBackend, retention: MessageRetention = 'unbounded') {
  return new MessageHandler(
    // sessionManager — not used in saveMessage / purgeExpiredMessages
    null as never,
    storage,
    () => 'me',
    null,
    null,
    () => { /* sendControl noop */ },
    null,
    null,
    null,
    null,
    retention,
  );
}

function msg(id: string, timestamp: number, peerId = 'alice'): StoredMessage {
  return {
    id,
    conversationId: peerId,
    senderId: peerId,
    recipientId: 'me',
    payload: Array.from(new TextEncoder().encode(`msg ${id}`)),
    timestamp,
    direction: 'inbound',
    status: 'delivered',
  };
}

// ===========================================================================
// Retention policies
// ===========================================================================

describe('messageRetention', () => {
  let storage: StorageBackend;

  beforeEach(() => {
    storage = memoryStorage();
  });

  describe('unbounded (default)', () => {
    it('keeps every message regardless of count', async () => {
      const h = makeHandler(storage, 'unbounded');
      // 800 well above the old hard-coded MAX_STORED_MESSAGES=500 cap.
      // Seed directly to keep the test fast — saveMessage is O(n) per call
      // because it re-serialises the growing array.
      const seeded: StoredMessage[] = [];
      for (let i = 0; i < 800; i++) seeded.push(msg(`m${i}`, i));
      await storage.set('messages/alice', JSON.stringify(seeded));
      // Trigger the retention path via purgeExpiredMessages.
      await h.purgeExpiredMessages();
      const all = await h.getMessages('alice');
      expect(all.length).toBe(800);
    });
  });

  describe('count', () => {
    it('caps to `max` newest, evicting oldest on write', async () => {
      const h = makeHandler(storage, { kind: 'count', max: 10 });
      for (let i = 0; i < 25; i++) {
        await h.saveMessage(msg(`m${i}`, i));
      }
      const all = await h.getMessages('alice');
      expect(all.length).toBe(10);
      // Should be the most-recent 10: m15..m24
      expect(all[0]!.id).toBe('m15');
      expect(all[9]!.id).toBe('m24');
    });

    it('per-conversation, not global', async () => {
      const h = makeHandler(storage, { kind: 'count', max: 3 });
      for (let i = 0; i < 5; i++) {
        await h.saveMessage(msg(`a${i}`, i, 'alice'));
        await h.saveMessage(msg(`b${i}`, i, 'bob'));
      }
      expect((await h.getMessages('alice')).length).toBe(3);
      expect((await h.getMessages('bob')).length).toBe(3);
    });
  });

  describe('ageMs', () => {
    it('drops messages older than the cutoff on write', async () => {
      const h = makeHandler(storage, { kind: 'ageMs', max: 60_000 });
      const now = Date.now();
      await h.saveMessage(msg('old1', now - 120_000));
      await h.saveMessage(msg('old2', now - 90_000));
      await h.saveMessage(msg('fresh', now - 10_000));
      const all = await h.getMessages('alice');
      expect(all.map((m) => m.id)).toEqual(['fresh']);
    });

    it('purgeExpiredMessages applies retention even without new writes', async () => {
      const h = makeHandler(storage, { kind: 'ageMs', max: 30_000 });
      const now = Date.now();
      // Seed storage directly so saveMessage's eviction-on-write doesn't fire.
      await storage.set(
        'messages/alice',
        JSON.stringify([
          msg('stale1', now - 60_000),
          msg('stale2', now - 45_000),
          msg('fresh', now - 5_000),
        ]),
      );
      await h.purgeExpiredMessages();
      const all = JSON.parse(await storage.get('messages/alice') as string) as StoredMessage[];
      expect(all.map((m) => m.id)).toEqual(['fresh']);
    });
  });

  describe('preserves per-message expiresAt alongside global retention', () => {
    it('purge drops both expired and retention-aged messages', async () => {
      const h = makeHandler(storage, { kind: 'ageMs', max: 60_000 });
      const now = Date.now();
      await storage.set(
        'messages/alice',
        JSON.stringify([
          { ...msg('old', now - 90_000) },
          { ...msg('expired', now - 5_000), expiresAt: now - 1_000 },
          { ...msg('keep', now - 30_000) },
        ]),
      );
      await h.purgeExpiredMessages();
      const all = JSON.parse(await storage.get('messages/alice') as string) as StoredMessage[];
      expect(all.map((m) => m.id)).toEqual(['keep']);
    });
  });
});
