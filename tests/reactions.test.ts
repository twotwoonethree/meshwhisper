// ============================================================
// Message reactions — MessageHandler.applyReaction
//
// Focused unit tests on the state-machine layer (toggle semantics,
// empty-array pruning, idempotence) using a Map-backed storage
// fake. The SDK-level send/receive round-trip rides the existing
// control-message machinery already covered by the integration
// tests; here we pin the persisted shape that round-trip depends on.
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

async function seedMessage(storage: StorageBackend, conversationId: string, msg: Partial<StoredMessage> & { id: string }): Promise<void> {
  const full: StoredMessage = {
    id: msg.id,
    conversationId,
    senderId: msg.senderId ?? 'sender',
    recipientId: msg.recipientId ?? 'recipient',
    payload: msg.payload ?? [1, 2, 3],
    timestamp: msg.timestamp ?? Date.now(),
    direction: msg.direction ?? 'inbound',
    status: msg.status ?? 'delivered',
    ...(msg.reactions ? { reactions: msg.reactions } : {}),
  };
  const raw = await storage.get(`messages/${conversationId}`);
  const existing: StoredMessage[] = raw ? JSON.parse(raw) : [];
  existing.push(full);
  await storage.set(`messages/${conversationId}`, JSON.stringify(existing));
}

async function readReactions(storage: StorageBackend, conversationId: string, messageId: string): Promise<Record<string, string[]> | undefined> {
  const raw = await storage.get(`messages/${conversationId}`);
  if (!raw) return undefined;
  const arr: StoredMessage[] = JSON.parse(raw);
  return arr.find((m) => m.id === messageId)?.reactions;
}

describe('MessageHandler.applyReaction', () => {
  let storage: ReturnType<typeof makeStorage>;
  let handler: MessageHandler;

  beforeEach(() => {
    storage = makeStorage();
    handler = new MessageHandler({} as never, storage, () => 'localPeer', null, null, () => {}, null, () => {}, () => {});
  });

  it('adds a reaction and reports "added"', async () => {
    await seedMessage(storage, 'conv1', { id: 'm1' });
    const outcome = await handler.applyReaction('conv1', 'm1', 'alice', '👍', true);
    expect(outcome).toBe('added');
    expect(await readReactions(storage, 'conv1', 'm1')).toEqual({ '👍': ['alice'] });
  });

  it('idempotent: re-adding the same peer/emoji is a noop', async () => {
    await seedMessage(storage, 'conv1', { id: 'm1' });
    await handler.applyReaction('conv1', 'm1', 'alice', '👍', true);
    const outcome = await handler.applyReaction('conv1', 'm1', 'alice', '👍', true);
    expect(outcome).toBe('noop');
    expect(await readReactions(storage, 'conv1', 'm1')).toEqual({ '👍': ['alice'] });
  });

  it('removes a reaction and prunes the emoji entry when the last reactor leaves', async () => {
    await seedMessage(storage, 'conv1', { id: 'm1' });
    await handler.applyReaction('conv1', 'm1', 'alice', '👍', true);
    const outcome = await handler.applyReaction('conv1', 'm1', 'alice', '👍', false);
    expect(outcome).toBe('removed');
    // Pruned to an empty object, not lingering with an empty array.
    expect(await readReactions(storage, 'conv1', 'm1')).toEqual({});
  });

  it('removing a non-existent reaction is a noop', async () => {
    await seedMessage(storage, 'conv1', { id: 'm1' });
    const outcome = await handler.applyReaction('conv1', 'm1', 'alice', '👍', false);
    expect(outcome).toBe('noop');
  });

  it('multiple peers can react with the same emoji', async () => {
    await seedMessage(storage, 'conv1', { id: 'm1' });
    await handler.applyReaction('conv1', 'm1', 'alice', '🎉', true);
    await handler.applyReaction('conv1', 'm1', 'bob', '🎉', true);
    await handler.applyReaction('conv1', 'm1', 'carol', '🎉', true);
    const r = await readReactions(storage, 'conv1', 'm1');
    expect(r!['🎉'].sort()).toEqual(['alice', 'bob', 'carol']);
  });

  it('removing one reactor keeps the emoji entry while others remain', async () => {
    await seedMessage(storage, 'conv1', { id: 'm1' });
    await handler.applyReaction('conv1', 'm1', 'alice', '🎉', true);
    await handler.applyReaction('conv1', 'm1', 'bob', '🎉', true);
    await handler.applyReaction('conv1', 'm1', 'alice', '🎉', false);
    expect(await readReactions(storage, 'conv1', 'm1')).toEqual({ '🎉': ['bob'] });
  });

  it('the same peer can react with multiple emojis independently', async () => {
    await seedMessage(storage, 'conv1', { id: 'm1' });
    await handler.applyReaction('conv1', 'm1', 'alice', '👍', true);
    await handler.applyReaction('conv1', 'm1', 'alice', '❤️', true);
    const r = await readReactions(storage, 'conv1', 'm1');
    expect(r).toEqual({ '👍': ['alice'], '❤️': ['alice'] });
  });

  it('reactions on a non-existent message are a noop and create no state', async () => {
    const outcome = await handler.applyReaction('conv1', 'no-such-message', 'alice', '👍', true);
    expect(outcome).toBe('noop');
    expect(await readReactions(storage, 'conv1', 'no-such-message')).toBeUndefined();
  });

  it('does not perturb other messages in the same conversation', async () => {
    await seedMessage(storage, 'conv1', { id: 'm1' });
    await seedMessage(storage, 'conv1', { id: 'm2' });
    await handler.applyReaction('conv1', 'm1', 'alice', '👍', true);
    expect(await readReactions(storage, 'conv1', 'm1')).toEqual({ '👍': ['alice'] });
    expect(await readReactions(storage, 'conv1', 'm2')).toBeUndefined();
  });
});
