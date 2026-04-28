import { describe, it, expect, beforeEach } from 'vitest';
import { MessageHandler } from '../src/sdk/message-handler.js';
import type { StorageBackend, StoredMessage } from '../src/types.js';

// ---- In-memory StorageBackend ----

class MemoryStorage implements StorageBackend {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async keys(prefix: string): Promise<string[]> {
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
  }
}

// ---- Helpers ----

function makeHandler(storage: StorageBackend): MessageHandler {
  return new MessageHandler(
    null as any,
    storage,
    () => 'local-peer',
    null,
    null,
    () => {},
    null,
  );
}

function makeMessage(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    conversationId: 'peer-alice',
    senderId: 'peer-alice',
    recipientId: 'local-peer',
    payload: [1, 2, 3],
    timestamp: Date.now(),
    direction: 'inbound',
    status: 'delivered',
    ...overrides,
  };
}

// ---- Tests ----

describe('getConversations', () => {
  let storage: MemoryStorage;
  let handler: MessageHandler;

  beforeEach(() => {
    storage = new MemoryStorage();
    handler = makeHandler(storage);
  });

  it('returns empty array when no messages stored', async () => {
    const convs = await handler.getConversations();
    expect(convs).toEqual([]);
  });

  it('returns one conversation per peer', async () => {
    await handler.saveMessage(makeMessage({ conversationId: 'peer-alice', senderId: 'peer-alice' }));
    await handler.saveMessage(makeMessage({ conversationId: 'peer-bob', senderId: 'peer-bob' }));

    const convs = await handler.getConversations();
    expect(convs).toHaveLength(2);
    const peerIds = convs.map((c) => c.peerId).sort();
    expect(peerIds).toEqual(['peer-alice', 'peer-bob']);
  });

  it('lastMessage is the most recently saved message', async () => {
    const first = makeMessage({ conversationId: 'peer-alice', timestamp: 1000 });
    const second = makeMessage({ conversationId: 'peer-alice', timestamp: 2000 });
    await handler.saveMessage(first);
    await handler.saveMessage(second);

    const convs = await handler.getConversations();
    expect(convs[0].lastMessage?.id).toBe(second.id);
  });

  it('sorts conversations by most recent first', async () => {
    await handler.saveMessage(makeMessage({ conversationId: 'peer-alice', timestamp: 1000 }));
    await handler.saveMessage(makeMessage({ conversationId: 'peer-bob', timestamp: 3000 }));
    await handler.saveMessage(makeMessage({ conversationId: 'peer-carol', timestamp: 2000 }));

    const convs = await handler.getConversations();
    expect(convs.map((c) => c.peerId)).toEqual(['peer-bob', 'peer-carol', 'peer-alice']);
  });

  it('counts unread inbound messages correctly', async () => {
    await handler.saveMessage(makeMessage({ conversationId: 'peer-alice', direction: 'inbound', status: 'delivered' }));
    await handler.saveMessage(makeMessage({ conversationId: 'peer-alice', direction: 'inbound', status: 'delivered' }));
    await handler.saveMessage(makeMessage({ conversationId: 'peer-alice', direction: 'inbound', status: 'read' }));
    await handler.saveMessage(makeMessage({ conversationId: 'peer-alice', direction: 'outbound', status: 'sent' }));

    const convs = await handler.getConversations();
    expect(convs[0].unreadCount).toBe(2);
  });

  it('unreadCount is zero when all messages are read or outbound', async () => {
    await handler.saveMessage(makeMessage({ conversationId: 'peer-alice', direction: 'inbound', status: 'read' }));
    await handler.saveMessage(makeMessage({ conversationId: 'peer-alice', direction: 'outbound', status: 'delivered' }));

    const convs = await handler.getConversations();
    expect(convs[0].unreadCount).toBe(0);
  });

  it('updatedAt matches the last message timestamp', async () => {
    await handler.saveMessage(makeMessage({ conversationId: 'peer-alice', timestamp: 5000 }));
    await handler.saveMessage(makeMessage({ conversationId: 'peer-alice', timestamp: 8000 }));

    const convs = await handler.getConversations();
    expect(convs[0].updatedAt).toBe(8000);
  });

  it('returns no storage result when storage is null', async () => {
    const nullHandler = makeHandler(null as any);
    const convs = await nullHandler.getConversations();
    expect(convs).toEqual([]);
  });
});
