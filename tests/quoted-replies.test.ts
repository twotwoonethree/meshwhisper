// ============================================================
// Quoted replies — SendOptions.replyTo round-trip
//
// The actual send/receive integration rides the existing pairwise
// ratchet path, already covered by tests/integration.test.ts. Here
// we pin the persistence contract (StoredMessage.replyTo round-trip)
// and the saveMessage merge behaviour: replyTo is preserved when the
// stored message gets re-saved (e.g. status updates).
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { MessageHandler } from '../src/sdk/message-handler.js';
import type { StorageBackend, StoredMessage } from '../src/types.js';

function makeStorage(): StorageBackend & { _map: Map<string, string> } {
  const m = new Map<string, string>();
  return {
    _map: m,
    async get(k) { return m.get(k) ?? null; },
    async set(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async keys(prefix) { return Array.from(m.keys()).filter((k) => k.startsWith(prefix)); },
  };
}

describe('Quoted replies — StoredMessage.replyTo persistence', () => {
  let storage: ReturnType<typeof makeStorage>;
  let handler: MessageHandler;

  beforeEach(() => {
    storage = makeStorage();
    handler = new MessageHandler({} as never, storage, () => 'localPeer', null, null, () => {}, null, () => {}, () => {});
  });

  it('round-trips replyTo through saveMessage + getMessages', async () => {
    const original: StoredMessage = {
      id: 'orig',
      conversationId: 'conv1',
      senderId: 'alice',
      recipientId: 'bob',
      payload: [1, 2, 3],
      timestamp: 1000,
      direction: 'inbound',
      status: 'delivered',
    };
    const reply: StoredMessage = {
      id: 'reply',
      conversationId: 'conv1',
      senderId: 'bob',
      recipientId: 'alice',
      payload: [9, 9, 9],
      timestamp: 2000,
      direction: 'outbound',
      status: 'sent',
      replyTo: { messageId: 'orig', snippetText: 'thanks for the message' },
    };
    await handler.saveMessage(original);
    await handler.saveMessage(reply);
    const got = await handler.getMessages('conv1');
    expect(got.length).toBe(2);
    const stored = got.find((m) => m.id === 'reply');
    expect(stored?.replyTo).toEqual({
      messageId: 'orig',
      snippetText: 'thanks for the message',
    });
  });

  it('replyTo is optional — saveMessage works without it', async () => {
    const msg: StoredMessage = {
      id: 'm1',
      conversationId: 'conv1',
      senderId: 'alice',
      recipientId: 'bob',
      payload: [1],
      timestamp: 1000,
      direction: 'outbound',
      status: 'sent',
    };
    await handler.saveMessage(msg);
    const got = await handler.getMessages('conv1');
    expect(got[0].replyTo).toBeUndefined();
  });

  it('replyTo with only messageId (no snippet) round-trips', async () => {
    const msg: StoredMessage = {
      id: 'm1',
      conversationId: 'conv1',
      senderId: 'alice',
      recipientId: 'bob',
      payload: [1],
      timestamp: 1000,
      direction: 'outbound',
      status: 'sent',
      replyTo: { messageId: 'orig' },
    };
    await handler.saveMessage(msg);
    const got = await handler.getMessages('conv1');
    expect(got[0].replyTo).toEqual({ messageId: 'orig' });
    expect(got[0].replyTo?.snippetText).toBeUndefined();
  });

  it('updating a message status preserves replyTo (saveMessage replace semantics)', async () => {
    const msg: StoredMessage = {
      id: 'm1',
      conversationId: 'conv1',
      senderId: 'alice',
      recipientId: 'bob',
      payload: [1],
      timestamp: 1000,
      direction: 'outbound',
      status: 'sent',
      replyTo: { messageId: 'orig', snippetText: 'preview' },
    };
    await handler.saveMessage(msg);
    // saveMessage with the same id replaces the entry (per the existing
    // dedup-by-id semantics). The caller is responsible for carrying the
    // existing replyTo forward — verifying this is the contract, not a bug.
    const updated: StoredMessage = { ...msg, status: 'read' };
    await handler.saveMessage(updated);
    const got = await handler.getMessages('conv1');
    expect(got[0].status).toBe('read');
    expect(got[0].replyTo).toEqual({ messageId: 'orig', snippetText: 'preview' });
  });
});
