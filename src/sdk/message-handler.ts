// ============================================================
// MeshWhisper SDK — Message Handler
//
// Owns inbound message processing:
//   - decrypt via trial-decryption across all sessions
//   - deduplication (seenMessageIds rolling 24h window)
//   - message persistence (save, update status, read history)
//   - control message dispatch (delivery receipts, read receipts)
//   - group message routing (detect __mw_grp envelope, delegate decryption)
//   - cluster sync queuing
// ============================================================

import type { Message, StorageBackend, StoredMessage, Conversation } from '../types.js';
import type { Packet } from '../types.js';
import { decompressPayload } from '../packet/index.js';
import { ratchetDecrypt } from '../ratchet/index.js';
import type { DeviceCluster } from '../cluster/index.js';
import type { SessionManager } from './session-manager.js';
import {
  deserializeRatchetHeader,
  tryParseControl,
  generateMessageId,
  uint8ArrayToHex,
  type ControlMessage,
  type MessageEnvelope,
} from './utils.js';
import { KeyedMutex } from './keyed-mutex.js';

/** Prefix that marks a group message envelope inside the pairwise channel. */
const GROUP_ENVELOPE_PREFIX = '{"__mw_grp":';

export class MessageHandler {
  // Rolling set of seen message IDs to prevent duplicate delivery.
  // Keyed by message ID; value is the timestamp for TTL pruning.
  private readonly seenMessageIds: Map<string, number> = new Map();

  // Serialises read-modify-write on `messages/${conversationId}`.
  // Without this, two messages arriving in the same JS tick (or a live
  // message racing with mergeKv on boot) lose one of the two writes.
  // Exposed so the archive merge path can lock the same keys.
  readonly storageMutex = new KeyedMutex();

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly storage: StorageBackend | null,
    private readonly getLocalPeerId: () => string,
    private readonly onMessage: ((message: Message) => void) | null,
    private readonly onMessageStatus: ((messageId: string, status: StoredMessage['status']) => void) | null,
    /**
     * Called when an inbound message triggers a delivery receipt or read
     * receipt that must be sent back to the peer. Implemented by the
     * coordinator as a thin wrapper around sendMessage().
     */
    private readonly sendControl: (peerId: string, payload: Record<string, unknown>) => void,
    private readonly cluster: DeviceCluster | null,
    /**
     * Called for control message types MessageHandler doesn't own
     * (e.g. sybil: entropy_challenge, entropy_response, reputation_proof).
     * The coordinator handles these.
     */
    private readonly onUnhandledControl: ((ctrl: ControlMessage, fromPeerId: string) => void) | null = null,
    /**
     * Called when a DATA packet addressed to us fails to decrypt across all
     * known sessions. Signals that a session may be lost (e.g. after reinstall)
     * and that re-establishment should be attempted. The `hintPeerId` is set
     * when the failed packet's dhKey is indexed to a known peer — caller uses
     * it to drive a targeted re-handshake rather than a global one.
     */
    private readonly onDecryptFailure: ((hintPeerId: string | null) => void) | null = null,
    /**
     * Called when a group-envelope message is received after pairwise decryption.
     * The coordinator decrypts the inner ciphertext with the group sender key
     * and returns the plaintext, or null if the group/sender key is unknown.
     */
    private readonly onGroupData: ((
      groupId: string,
      groupSenderId: string,
      ciphertext: Uint8Array,
      fromPeerId: string,
    ) => { plaintext: Uint8Array } | null) | null = null,
    /**
     * Per-conversation retention policy. Default 'unbounded' — keep
     * everything. Apps can pass `{ kind: 'count', max }` or
     * `{ kind: 'ageMs', max }` to bound local storage.
     */
    private readonly retention: import('../types.js').MessageRetention = 'unbounded',
  ) {}

  // ----------------------------------------------------------------
  // Startup / shutdown
  // ----------------------------------------------------------------

  async loadSeenIds(): Promise<void> {
    if (!this.storage) return;
    const raw = await this.storage.get('seen_ids');
    if (!raw) return;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const entries = JSON.parse(raw) as Array<[string, number]>;
    for (const [id, ts] of entries) {
      if (ts > cutoff) this.seenMessageIds.set(id, ts);
    }
  }

  /** Purge all messages that have passed their expiresAt timestamp. */
  async purgeExpiredMessages(): Promise<void> {
    if (!this.storage) return;
    const keys = await this.storage.keys('messages/');
    const now = Date.now();
    for (const key of keys) {
      const raw = await this.storage.get(key);
      if (!raw) continue;
      const messages: StoredMessage[] = JSON.parse(raw);
      const beforeLen = messages.length;
      // Drop per-message expirations first…
      const live = messages.filter((m) => !m.expiresAt || m.expiresAt > now);
      // …then apply the global retention policy.
      this.applyRetention(live);
      if (live.length !== beforeLen) {
        await this.storage.set(key, JSON.stringify(live));
      }
    }
  }

  async persistSeenIds(): Promise<void> {
    if (!this.storage) return;
    const entries = [...this.seenMessageIds.entries()];
    await this.storage.set('seen_ids', JSON.stringify(entries));
  }

  // ----------------------------------------------------------------
  // Incoming data packets
  // ----------------------------------------------------------------

  handleDataPacket(packet: Packet, onUndecryptable?: () => void): void {
    try {
      const { header, ciphertextBody } = deserializeRatchetHeader(packet.encryptedPayload);

      let decrypted: Uint8Array | null = null;
      let matchedPeerId: string | null = null;

      // Fast path: look up the session by the sender's ratchet DH public key.
      const dhKeyHex = uint8ArrayToHex(header.dhPublicKey);
      const indexedPeerId = this.sessionManager.lookupByDhKey(dhKeyHex);

      if (indexedPeerId) {
        const session = this.sessionManager.getSession(indexedPeerId);
        if (session) {
          try {
            const result = ratchetDecrypt(session, header, ciphertextBody);
            this.sessionManager.setSession(indexedPeerId, result.state);
            this.sessionManager.registerDhKey(dhKeyHex, indexedPeerId);
            decrypted = result.plaintext;
            matchedPeerId = indexedPeerId;
          } catch {
            // Fall through to trial decryption
          }
        }
      }

      // Slow path: try every session.
      if (!decrypted) {
        for (const [peerId, session] of this.sessionManager.sessions_iter()) {
          try {
            const result = ratchetDecrypt(session, header, ciphertextBody);
            this.sessionManager.setSession(peerId, result.state);
            this.sessionManager.registerDhKey(dhKeyHex, peerId);
            decrypted = result.plaintext;
            matchedPeerId = peerId;
            break;
          } catch {
            continue;
          }
        }
      }

      if (!decrypted || !matchedPeerId) {
        // Undecryptable: release the packet-level dedup slot so a copy
        // arriving on another bearer (dual-send) can still be processed —
        // this copy consumed nothing.
        onUndecryptable?.();
        // If the dhKey indexed to a known peer but ratchetDecrypt threw,
        // the session for THAT peer is the broken one — pass the hint so
        // the coordinator can target a single re-handshake rather than
        // re-handshaking every contact globally.
        const hint = indexedPeerId ?? null;
        console.warn(
          '[meshwhisper] decrypt failed for inbound packet — no session matched. ' +
          `dhKey=${uint8ArrayToHex(header.dhPublicKey).slice(0, 16)}…` +
          (hint ? ` (hint peerId=${hint.slice(0, 8)})` : ''),
        );
        this.onDecryptFailure?.(hint);
        return;
      }

      const decompressed = decompressPayload(decrypted);
      const envelope: MessageEnvelope = JSON.parse(new TextDecoder().decode(decompressed));

      // Deduplicate
      if (this.seenMessageIds.has(envelope.id)) return;
      this.seenMessageIds.set(envelope.id, envelope.timestamp);
      this.pruneSeenIds();
      this.persistSeenIds().catch(() => {});

      // Control messages (delivery receipts, read receipts, typing, etc.)
      const payloadBytes = new Uint8Array(envelope.payload);
      const ctrl = tryParseControl(payloadBytes);
      if (ctrl) {
        this.handleControlMessage(ctrl, matchedPeerId);
        return;
      }

      // Expiry check
      if (envelope.expiry && Date.now() > envelope.timestamp + envelope.expiry * 1000) return;

      // Group message envelope — decode and delegate inner decryption
      const payloadText = new TextDecoder().decode(payloadBytes);
      if (payloadText.startsWith(GROUP_ENVELOPE_PREFIX)) {
        this.handleGroupEnvelope(payloadText, matchedPeerId, envelope);
        return;
      }

      const expiresAt = envelope.expiry ? envelope.timestamp + envelope.expiry * 1000 : undefined;

      const message: Message = {
        id: envelope.id,
        senderId: envelope.senderId,
        recipientId: envelope.recipientId,
        payload: payloadBytes,
        timestamp: envelope.timestamp,
        urgency: envelope.urgency as Message['urgency'],
        expiry: envelope.expiry,
        ...(envelope.replyTo ? { replyTo: envelope.replyTo } : {}),
        ...(envelope.forwardedFrom ? { forwardedFrom: envelope.forwardedFrom } : {}),
      };

      this.saveMessage({
        id: message.id,
        conversationId: matchedPeerId,
        senderId: message.senderId,
        recipientId: message.recipientId,
        payload: Array.from(payloadBytes),
        timestamp: message.timestamp,
        direction: 'inbound',
        status: 'delivered',
        expiresAt,
        ...(envelope.replyTo ? { replyTo: envelope.replyTo } : {}),
        ...(envelope.forwardedFrom ? { forwardedFrom: envelope.forwardedFrom } : {}),
      }).catch(() => {});

      if (this.onMessage) {
        this.onMessage(message);
      }

      this.sendControl(matchedPeerId, { __mw_ctrl: 'delivered', messageId: message.id });

      if (this.cluster) {
        this.cluster.syncManager.queueForSync({
          messageId: message.id,
          encryptedPayload: packet.encryptedPayload,
          receivedAt: Date.now(),
          receivedBy: this.getLocalPeerId(),
          syncedTo: new Set([this.getLocalPeerId()]),
        });
      }
    } catch {
      // Malformed packet — drop silently (and release the dedup slot;
      // an identical copy can't do better, but unmarking is harmless).
      onUndecryptable?.();
    }
  }

  private handleGroupEnvelope(
    payloadText: string,
    fromPeerId: string,
    envelope: MessageEnvelope,
  ): void {
    try {
      const grpEnv = JSON.parse(payloadText) as {
        __mw_grp: string;
        sid: string;
        d: number[];
      };
      const { __mw_grp: groupId, sid: groupSenderId, d } = grpEnv;
      const ciphertext = new Uint8Array(d);

      if (!this.onGroupData) return;
      const result = this.onGroupData(groupId, groupSenderId, ciphertext, fromPeerId);
      if (!result) return;

      const expiresAt = envelope.expiry ? envelope.timestamp + envelope.expiry * 1000 : undefined;

      const message: Message = {
        id: envelope.id,
        senderId: groupSenderId,
        recipientId: this.getLocalPeerId(),
        payload: result.plaintext,
        timestamp: envelope.timestamp,
        urgency: envelope.urgency as Message['urgency'],
        expiry: envelope.expiry,
        groupId,
        groupSenderId,
      };

      this.saveMessage({
        id: message.id,
        conversationId: groupId,
        senderId: groupSenderId,
        recipientId: this.getLocalPeerId(),
        payload: Array.from(result.plaintext),
        timestamp: message.timestamp,
        direction: 'inbound',
        status: 'delivered',
        groupId,
        groupSenderId,
        expiresAt,
      }).catch(() => {});

      if (this.onMessage) {
        this.onMessage(message);
      }
    } catch {
      // Malformed group envelope — drop
    }
  }

  handleControlMessage(ctrl: ControlMessage, fromPeerId: string): void {
    switch (ctrl.__mw_ctrl) {
      case 'delivered':
        if (ctrl.messageId) {
          this.updateMessageStatus(ctrl.messageId, fromPeerId, 'delivered').catch(() => {});
        }
        break;
      case 'read':
        if (ctrl.messageId) {
          this.updateMessageStatus(ctrl.messageId, fromPeerId, 'read').catch(() => {});
        }
        break;
      case 'delete':
        if (ctrl.messageId) {
          this.removeMessage(ctrl.messageId, fromPeerId).catch(() => {});
        }
        break;
      default:
        if (this.onUnhandledControl) {
          this.onUnhandledControl(ctrl, fromPeerId);
        }
        break;
    }
  }

  // ----------------------------------------------------------------
  // Message persistence
  // ----------------------------------------------------------------

  /**
   * Apply the configured retention policy to a sorted-oldest-first message
   * list. Mutates and returns. 'unbounded' = no-op.
   */
  private applyRetention(messages: StoredMessage[]): StoredMessage[] {
    if (this.retention === 'unbounded') return messages;
    if (this.retention.kind === 'count') {
      if (messages.length > this.retention.max) {
        messages.splice(0, messages.length - this.retention.max);
      }
      return messages;
    }
    if (this.retention.kind === 'ageMs') {
      const cutoff = Date.now() - this.retention.max;
      let firstKept = 0;
      while (firstKept < messages.length && messages[firstKept]!.timestamp < cutoff) {
        firstKept++;
      }
      if (firstKept > 0) messages.splice(0, firstKept);
      return messages;
    }
    return messages;
  }

  async saveMessage(message: StoredMessage): Promise<void> {
    if (!this.storage) return;
    const storage = this.storage;
    const key = `messages/${message.conversationId}`;
    await this.storageMutex.run(key, async () => {
      const raw = await storage.get(key);
      const messages: StoredMessage[] = raw ? JSON.parse(raw) : [];
      const existing = messages.findIndex((m) => m.id === message.id);
      if (existing >= 0) {
        messages[existing] = message;
      } else {
        messages.push(message);
        this.applyRetention(messages);
      }
      await storage.set(key, JSON.stringify(messages));
    });
  }

  async removeMessage(messageId: string, conversationId: string): Promise<void> {
    if (!this.storage) return;
    const storage = this.storage;
    const key = `messages/${conversationId}`;
    await this.storageMutex.run(key, async () => {
      const raw = await storage.get(key);
      if (!raw) return;
      const messages: StoredMessage[] = JSON.parse(raw);
      const filtered = messages.filter((m) => m.id !== messageId);
      if (filtered.length !== messages.length) {
        await storage.set(key, JSON.stringify(filtered));
      }
    });
  }

  /**
   * Toggle a single peer's reaction on a stored message. Returns the
   * effective change ('added', 'removed', or 'noop' if the message
   * wasn't found / the requested state already held). The persisted
   * reactions map is normalised on every write: empty arrays are
   * pruned, so a reader can treat an absent emoji and an empty array
   * identically.
   */
  async applyReaction(
    conversationId: string,
    messageId: string,
    peerId: string,
    emoji: string,
    add: boolean,
  ): Promise<'added' | 'removed' | 'noop'> {
    if (!this.storage) return 'noop';
    const storage = this.storage;
    const key = `messages/${conversationId}`;
    let outcome: 'added' | 'removed' | 'noop' = 'noop';
    await this.storageMutex.run(key, async () => {
      const raw = await storage.get(key);
      if (!raw) return;
      const messages: StoredMessage[] = JSON.parse(raw);
      const msg = messages.find((m) => m.id === messageId);
      if (!msg) return;
      const reactions = msg.reactions ?? {};
      const reactors = reactions[emoji] ?? [];
      const has = reactors.includes(peerId);
      if (add && !has) {
        reactions[emoji] = [...reactors, peerId];
        outcome = 'added';
      } else if (!add && has) {
        const next = reactors.filter((p) => p !== peerId);
        if (next.length === 0) {
          delete reactions[emoji];
        } else {
          reactions[emoji] = next;
        }
        outcome = 'removed';
      } else {
        return; // already in the requested state
      }
      msg.reactions = reactions;
      await storage.set(key, JSON.stringify(messages));
    });
    return outcome;
  }

  async updateMessageStatus(
    messageId: string,
    conversationId: string,
    status: StoredMessage['status'],
  ): Promise<void> {
    if (!this.storage) return;
    const storage = this.storage;
    const key = `messages/${conversationId}`;
    let updated = false;
    await this.storageMutex.run(key, async () => {
      const raw = await storage.get(key);
      if (!raw) return;
      const messages: StoredMessage[] = JSON.parse(raw);
      const msg = messages.find((m) => m.id === messageId);
      if (!msg) return;
      msg.status = status;
      await storage.set(key, JSON.stringify(messages));
      updated = true;
    });
    if (updated && this.onMessageStatus) {
      this.onMessageStatus(messageId, status);
    }
  }

  async getMessages(
    peerId: string,
    options?: { limit?: number; before?: number },
  ): Promise<StoredMessage[]> {
    if (!this.storage) return [];
    const raw = await this.storage.get(`messages/${peerId}`);
    if (!raw) return [];
    const now = Date.now();
    let messages: StoredMessage[] = (JSON.parse(raw) as StoredMessage[])
      .filter((m) => !m.expiresAt || m.expiresAt > now);
    if (options?.before !== undefined) {
      messages = messages.filter((m) => m.timestamp < options.before!);
    }
    if (options?.limit !== undefined) {
      messages = messages.slice(-options.limit);
    }
    return messages;
  }

  async getConversations(): Promise<Conversation[]> {
    if (!this.storage) return [];
    const keys = await this.storage.keys('messages/');
    const conversations: Conversation[] = [];
    const now = Date.now();
    for (const key of keys) {
      const peerId = key.slice('messages/'.length);
      const raw = await this.storage.get(key);
      if (!raw) continue;
      const messages: StoredMessage[] = (JSON.parse(raw) as StoredMessage[])
        .filter((m) => !m.expiresAt || m.expiresAt > now);
      if (messages.length === 0) continue;
      const lastMessage = messages[messages.length - 1];
      const unreadCount = messages.filter(
        (m) => m.direction === 'inbound' && m.status !== 'read',
      ).length;
      conversations.push({
        peerId,
        lastMessage,
        unreadCount,
        updatedAt: lastMessage.timestamp,
      });
    }
    conversations.sort((a, b) => b.updatedAt - a.updatedAt);
    return conversations;
  }

  // ----------------------------------------------------------------
  // Deduplication helpers
  // ----------------------------------------------------------------

  private pruneSeenIds(): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [id, ts] of this.seenMessageIds) {
      if (ts < cutoff) this.seenMessageIds.delete(id);
    }
  }

  // ----------------------------------------------------------------
  // Outbound message ID generation (used by coordinator for sendMessage)
  // ----------------------------------------------------------------

  createMessageId(): string {
    return generateMessageId();
  }
}
