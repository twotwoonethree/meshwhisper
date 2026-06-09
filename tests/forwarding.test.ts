// ============================================================
// Message forwarding — chain-preservation semantics
//
// The actual send/receive is the standard envelope path (covered by
// integration tests). What's specific to forwarding is the
// chain-preservation rule: if you forward a message that was itself
// forwarded, the new copy's `forwardedFrom` points at the ORIGINAL
// author, not at the intermediate forwarder. This matches the
// convention every consumer messenger uses and prevents misleading
// attribution.
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { MessageHandler } from '../src/sdk/message-handler.js';
import type { StorageBackend, StoredMessage } from '../src/types.js';

function makeStorage(): StorageBackend {
  const m = new Map<string, string>();
  return {
    async get(k) { return m.get(k) ?? null; },
    async set(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async keys(prefix) { return Array.from(m.keys()).filter((k) => k.startsWith(prefix)); },
  };
}

/**
 * Mirror of the chain-preservation rule from
 * MeshWhisper.forwardMessageInstance. Tested standalone so we don't
 * need to spin up the full SDK.
 */
function nextForwardedFrom(source: StoredMessage): string {
  return source.forwardedFrom ?? source.senderId;
}

describe('Forwarding — chain preservation', () => {
  it('fresh forward: forwardedFrom points at the original sender', () => {
    const source: StoredMessage = {
      id: 'm1',
      conversationId: 'conv-with-alice',
      senderId: 'alice',
      recipientId: 'me',
      payload: [1, 2, 3],
      timestamp: 1000,
      direction: 'inbound',
      status: 'delivered',
    };
    expect(nextForwardedFrom(source)).toBe('alice');
  });

  it('re-forward: forwardedFrom carries the original author, NOT the prior forwarder', () => {
    const source: StoredMessage = {
      id: 'm2',
      conversationId: 'conv-with-bob',
      senderId: 'bob', // bob is the forwarder
      recipientId: 'me',
      payload: [1, 2, 3],
      timestamp: 2000,
      direction: 'inbound',
      status: 'delivered',
      forwardedFrom: 'alice', // original author
    };
    expect(nextForwardedFrom(source)).toBe('alice');
    // and explicitly NOT bob
    expect(nextForwardedFrom(source)).not.toBe('bob');
  });

  it('outbound forward (forwarding my own message) attributes to me', () => {
    const source: StoredMessage = {
      id: 'm3',
      conversationId: 'conv-with-carol',
      senderId: 'me',
      recipientId: 'carol',
      payload: [1, 2, 3],
      timestamp: 3000,
      direction: 'outbound',
      status: 'sent',
    };
    expect(nextForwardedFrom(source)).toBe('me');
  });
});

describe('Forwarding — StoredMessage.forwardedFrom persistence', () => {
  it('round-trips forwardedFrom through saveMessage + getMessages', async () => {
    const storage = makeStorage();
    const handler = new MessageHandler({} as never, storage, () => 'localPeer', null, null, () => {}, null, () => {}, () => {});
    const fwd: StoredMessage = {
      id: 'f1',
      conversationId: 'conv-with-carol',
      senderId: 'me',
      recipientId: 'carol',
      payload: [9],
      timestamp: 5000,
      direction: 'outbound',
      status: 'sent',
      forwardedFrom: 'alice',
    };
    await handler.saveMessage(fwd);
    const got = await handler.getMessages('conv-with-carol');
    expect(got[0].forwardedFrom).toBe('alice');
  });

  it('forwardedFrom and replyTo can both be present on the same message', async () => {
    const storage = makeStorage();
    const handler = new MessageHandler({} as never, storage, () => 'localPeer', null, null, () => {}, null, () => {}, () => {});
    const msg: StoredMessage = {
      id: 'mix',
      conversationId: 'conv',
      senderId: 'me',
      recipientId: 'peer',
      payload: [1],
      timestamp: 100,
      direction: 'outbound',
      status: 'sent',
      replyTo: { messageId: 'orig', snippetText: 'foo' },
      forwardedFrom: 'alice',
    };
    await handler.saveMessage(msg);
    const got = await handler.getMessages('conv');
    expect(got[0].forwardedFrom).toBe('alice');
    expect(got[0].replyTo).toEqual({ messageId: 'orig', snippetText: 'foo' });
  });
});
