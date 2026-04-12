// ============================================================
// MeshWhisper SDK — Message Handler
//
// Owns inbound message processing:
//   - decrypt via trial-decryption across all sessions
//   - deduplication (seenMessageIds rolling 24h window)
//   - message persistence (save, update status, read history)
//   - control message dispatch (delivery receipts, read receipts)
//   - cluster sync queuing
// ============================================================

import type { Message, StorageBackend, StoredMessage } from '../types.js';
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

export class MessageHandler {
  // Rolling set of seen message IDs to prevent duplicate delivery.
  // Keyed by message ID; value is the timestamp for TTL pruning.
  private readonly seenMessageIds: Map<string, number> = new Map();

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
      // This is O(1) and avoids leaking timing information across sessions.
      // The index is populated on first successful decryption; until then we
      // fall through to trial decryption (only on the first message or after
      // each DH ratchet step, which happens at most every other message).
      const dhKeyHex = uint8ArrayToHex(header.dhPublicKey);
      const indexedPeerId = this.sessionManager.lookupByDhKey(dhKeyHex);

      if (indexedPeerId) {
        const session = this.sessionManager.getSession(indexedPeerId);
        if (session) {
          try {
            const result = ratchetDecrypt(session, header, ciphertextBody);
            this.sessionManager.setSession(indexedPeerId, result.state);
            // Re-register in case the DH key changed during this decrypt (ratchet step)
            this.sessionManager.registerDhKey(dhKeyHex, indexedPeerId);
            decrypted = result.plaintext;
            matchedPeerId = indexedPeerId;
          } catch {
            // Index hit but decrypt failed — key may have been re-used across
            // a ratchet boundary. Fall through to trial decryption below.
          }
        }
      }

      // Slow path: try every session. Runs only on cache miss (first message
      // from a peer or first message after their DH ratchet step).
      if (!decrypted) {
        for (const [peerId, session] of this.sessionManager.sessions_iter()) {
          try {
            const result = ratchetDecrypt(session, header, ciphertextBody);
            this.sessionManager.setSession(peerId, result.state);
            // Seed the index so future messages from this peer are O(1).
            this.sessionManager.registerDhKey(dhKeyHex, peerId);
            decrypted = result.plaintext;
            matchedPeerId = peerId;
            break;
          } catch {
            continue;
          }
        }
      }

      if (!decrypted || !matchedPeerId) return;

      const decompressed = decompressPayload(decrypted);
      const envelope: MessageEnvelope = JSON.parse(new TextDecoder().decode(decompressed));

      // Deduplicate
      if (this.seenMessageIds.has(envelope.id)) return;
      this.seenMessageIds.set(envelope.id, envelope.timestamp);
      this.pruneSeenIds();
      // Persist immediately so the dedup window survives unclean exits
      // (crash, OOM kill). Without this, reconnect causes duplicate delivery.
      this.persistSeenIds().catch(() => {});

      // Control messages (delivery receipts, read receipts, typing)
      const payloadBytes = new Uint8Array(envelope.payload);
      const ctrl = tryParseControl(payloadBytes);
      if (ctrl) {
        this.handleControlMessage(ctrl, matchedPeerId);
        return;
      }

      // Expiry check
      if (envelope.expiry) {
        if (Date.now() > envelope.timestamp + envelope.expiry * 1000) return;
      }

      const message: Message = {
        id: envelope.id,
        senderId: envelope.senderId,
        recipientId: envelope.recipientId,
        payload: payloadBytes,
        timestamp: envelope.timestamp,
        urgency: envelope.urgency as Message['urgency'],
        expiry: envelope.expiry,
      };

      // Persist inbound message
      this.saveMessage({
        id: message.id,
        conversationId: matchedPeerId,
        senderId: message.senderId,
        recipientId: message.recipientId,
        payload: Array.from(payloadBytes),
        timestamp: message.timestamp,
        direction: 'inbound',
        status: 'delivered',
      }).catch(() => {});

      // Surface to app
      if (this.onMessage) {
        this.onMessage(message);
      }

      // Send delivery receipt
      this.sendControl(matchedPeerId, { __mw_ctrl: 'delivered', messageId: message.id });

      // Cluster sync
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
      default:
        // Delegate sybil and other coordinator-owned control types
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
    const key = `messages/${message.conversationId}`;
    const raw = await this.storage.get(key);
    const messages: StoredMessage[] = raw ? JSON.parse(raw) : [];
    const existing = messages.findIndex((m) => m.id === message.id);
    if (existing >= 0) {
      messages[existing] = message;
    } else {
      messages.push(message);
      // Keep the newest N messages; drop oldest when over the cap
      if (messages.length > MessageHandler.MAX_STORED_MESSAGES) {
        messages.splice(0, messages.length - MessageHandler.MAX_STORED_MESSAGES);
      }
    }
    await this.storage.set(key, JSON.stringify(messages));
  }

  async updateMessageStatus(
    messageId: string,
    conversationId: string,
    status: StoredMessage['status'],
  ): Promise<void> {
    if (!this.storage) return;
    const key = `messages/${conversationId}`;
    const raw = await this.storage.get(key);
    if (!raw) return;
    const messages: StoredMessage[] = JSON.parse(raw);
    const msg = messages.find((m) => m.id === messageId);
    if (!msg) return;
    msg.status = status;
    await this.storage.set(key, JSON.stringify(messages));
    if (this.onMessageStatus) {
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
    let messages: StoredMessage[] = JSON.parse(raw);
    if (options?.before !== undefined) {
      messages = messages.filter((m) => m.timestamp < options.before!);
    }
    if (options?.limit !== undefined) {
      messages = messages.slice(-options.limit);
    }
    return messages;
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
