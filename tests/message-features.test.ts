import { describe, it, expect, beforeEach } from 'vitest';
import { MessageHandler } from '../src/sdk/message-handler.js';
import type { StorageBackend, StoredMessage } from '../src/types.js';

// ---- In-memory StorageBackend ----

class MemoryStorage implements StorageBackend {
  private store = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
  async set(key: string, value: string): Promise<void> { this.store.set(key, value); }
  async delete(key: string): Promise<void> { this.store.delete(key); }
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

let storage: MemoryStorage;
let handler: MessageHandler;

function msg(overrides: Partial<StoredMessage> = {}): StoredMessage {
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

beforeEach(() => {
  storage = new MemoryStorage();
  handler = makeHandler(storage);
});

// ================================================================
// Message expiry
// ================================================================

describe('message expiry', () => {
  it('getMessages filters out expired messages', async () => {
    const live = msg({ id: 'live', expiresAt: Date.now() + 60_000 });
    const expired = msg({ id: 'expired', expiresAt: Date.now() - 1 });
    await handler.saveMessage(live);
    await handler.saveMessage(expired);

    const result = await handler.getMessages('peer-alice');
    expect(result.map((m) => m.id)).toEqual(['live']);
  });

  it('getMessages includes messages with no expiresAt', async () => {
    const noExpiry = msg({ id: 'no-expiry' });
    await handler.saveMessage(noExpiry);
    const result = await handler.getMessages('peer-alice');
    expect(result).toHaveLength(1);
  });

  it('getConversations excludes expired messages from unread count', async () => {
    const live = msg({ id: 'live', direction: 'inbound', status: 'delivered', expiresAt: Date.now() + 60_000 });
    const expired = msg({ id: 'expired', direction: 'inbound', status: 'delivered', expiresAt: Date.now() - 1 });
    await handler.saveMessage(live);
    await handler.saveMessage(expired);

    const convs = await handler.getConversations();
    expect(convs[0].unreadCount).toBe(1);
  });

  it('purgeExpiredMessages removes expired messages from storage', async () => {
    const live = msg({ id: 'live', expiresAt: Date.now() + 60_000 });
    const expired = msg({ id: 'expired', expiresAt: Date.now() - 1 });
    await handler.saveMessage(live);
    await handler.saveMessage(expired);

    await handler.purgeExpiredMessages();

    const raw = await storage.get('messages/peer-alice');
    const stored: StoredMessage[] = JSON.parse(raw!);
    expect(stored.map((m) => m.id)).toEqual(['live']);
  });

  it('purgeExpiredMessages does nothing when no messages are expired', async () => {
    const live = msg({ expiresAt: Date.now() + 60_000 });
    await handler.saveMessage(live);
    await handler.purgeExpiredMessages();

    const result = await handler.getMessages('peer-alice');
    expect(result).toHaveLength(1);
  });
});

// ================================================================
// deleteMessage / removeMessage
// ================================================================

describe('removeMessage', () => {
  it('removes a message by id from storage', async () => {
    const a = msg({ id: 'a' });
    const b = msg({ id: 'b' });
    await handler.saveMessage(a);
    await handler.saveMessage(b);

    await handler.removeMessage('a', 'peer-alice');
    const result = await handler.getMessages('peer-alice');
    expect(result.map((m) => m.id)).toEqual(['b']);
  });

  it('is a no-op when the message does not exist', async () => {
    const a = msg({ id: 'a' });
    await handler.saveMessage(a);
    await handler.removeMessage('nonexistent', 'peer-alice');
    const result = await handler.getMessages('peer-alice');
    expect(result).toHaveLength(1);
  });

  it('is a no-op when the conversation does not exist', async () => {
    await expect(handler.removeMessage('x', 'unknown-peer')).resolves.toBeUndefined();
  });
});

// ================================================================
// Group message storage (outbound stored under groupId)
// ================================================================

describe('group message outbound storage', () => {
  it('saves outbound group message under group conversation ID', async () => {
    const groupMsg = msg({
      id: 'grp-msg-1',
      conversationId: 'group-abc',
      recipientId: 'group-abc',
      groupId: 'group-abc',
      groupSenderId: 'local-peer',
      direction: 'outbound',
      status: 'sent',
    });
    await handler.saveMessage(groupMsg);

    const result = await handler.getMessages('group-abc');
    expect(result).toHaveLength(1);
    expect(result[0].groupId).toBe('group-abc');
  });

  it('group message does not appear in member peer conversation', async () => {
    const groupMsg = msg({
      conversationId: 'group-abc',
      recipientId: 'group-abc',
      groupId: 'group-abc',
      direction: 'outbound',
      status: 'sent',
    });
    await handler.saveMessage(groupMsg);

    const memberConv = await handler.getMessages('peer-alice');
    expect(memberConv).toHaveLength(0);
  });

  it('getConversations lists group as a separate conversation', async () => {
    await handler.saveMessage(msg({ id: 'dm', conversationId: 'peer-alice' }));
    await handler.saveMessage(msg({
      id: 'grp',
      conversationId: 'group-abc',
      recipientId: 'group-abc',
      groupId: 'group-abc',
      direction: 'outbound',
      status: 'sent',
    }));

    const convs = await handler.getConversations();
    expect(convs.map((c) => c.peerId).sort()).toEqual(['group-abc', 'peer-alice']);
  });
});

// ================================================================
// updateMessageStatus
// ================================================================

describe('updateMessageStatus', () => {
  it('updates the status of a stored message', async () => {
    const m = msg({ id: 'status-test', status: 'sent', direction: 'outbound', senderId: 'local-peer' });
    await handler.saveMessage(m);
    await handler.updateMessageStatus('status-test', 'peer-alice', 'delivered');
    const result = await handler.getMessages('peer-alice');
    expect(result[0].status).toBe('delivered');
  });

  it('fires onMessageStatus callback', async () => {
    const statuses: string[] = [];
    const h = new MessageHandler(
      null as any, storage, () => 'local-peer', null,
      (id, status) => statuses.push(status),
      () => {}, null,
    );
    const m = msg({ id: 'cb-test', status: 'sent', direction: 'outbound', senderId: 'local-peer' });
    await h.saveMessage(m);
    await h.updateMessageStatus('cb-test', 'peer-alice', 'read');
    expect(statuses).toEqual(['read']);
  });
});
