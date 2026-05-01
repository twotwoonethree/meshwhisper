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
     * and that re-establishment should be attempted.
     */
    private readonly onDecryptFailure: (() => void) | null = null,
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
      const live = messages.filter((m) => !m.expiresAt || m.expiresAt > now);
      if (live.length !== messages.length) {
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

  handleDataPacket(packet: Packet): void {
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
        this.onDecryptFailure?.();
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
      // Malformed packet — drop silently
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

  private static readonly MAX_STORED_MESSAGES = 500;

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
        if (messages.length > MessageHandler.MAX_STORED_MESSAGES) {
          messages.splice(0, messages.length - MessageHandler.MAX_STORED_MESSAGES);
        }
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
