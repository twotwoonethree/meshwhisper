// ============================================================
// MeshWhisper SDK — Persistence Types
// ============================================================

/**
 * Minimal key-value storage interface. Implement this for your platform:
 *   - Node.js:      NodeStorage (provided)
 *   - React Native: AsyncStorage or SQLCipher wrapper
 *   - Browser:      IndexedDB wrapper
 *
 * Values are always JSON strings. Keys use forward-slash namespacing:
 *   identity, sessions/<peerId>, peers/<peerId>, contacts, messages/<peerId>, seen_ids
 */
export interface StorageBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Returns all stored keys that start with the given prefix. */
  keys(prefix: string): Promise<string[]>;
}

export interface StoredMessage {
  id: string;
  /** The peer ID of the other party in this conversation. */
  conversationId: string;
  senderId: string;
  recipientId: string;
  /** Message payload as a plain number array (JSON-serialisable Uint8Array). */
  payload: number[];
  timestamp: number;
  direction: 'inbound' | 'outbound';
  status: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  /** Set for group messages. */
  groupId?: string;
  groupSenderId?: string;
  /** Unix ms after which this message should be considered expired and purged. */
  expiresAt?: number;
  /**
   * Per-emoji set of peerIds that have currently reacted to this message.
   * Toggle semantics: a peer's emoji is present iff they're currently
   * reacting. Empty arrays MAY be stored or pruned — both are valid;
   * UIs should treat an absent emoji and an empty array identically.
   */
  reactions?: Record<string, string[]>;
  /**
   * Per-member delivery/read status for a group message you sent. Keyed by
   * member peerId → the furthest status that member has reported
   * ('delivered' | 'read'). Absent peer = no receipt yet. DMs use the scalar
   * `status` field instead; groups need a map because one message has many
   * recipients, each acking independently. Only the sender's outbound copy
   * accumulates this.
   */
  groupReceipts?: Record<string, 'delivered' | 'read'>;
  /**
   * Set when this message was sent as a reply to an earlier one (via
   * `SendOptions.replyTo`). `messageId` references the original in the
   * same conversation; `snippetText` is a short preview the sender
   * included so UIs can render the quote inline without looking up the
   * source. Round-trips through the envelope on send.
   */
  replyTo?: { messageId: string; snippetText?: string };
  /**
   * Set when this message was sent via `MeshWhisper.forwardMessage` or
   * with `SendOptions.forwardedFrom`. Holds the peerId of the message's
   * original sender (NOT the forwarder — that's `senderId`). UIs
   * typically render a small "Forwarded" label with the original
   * sender's display name.
   */
  forwardedFrom?: string;
}

export interface Conversation {
  /** The peer ID of the other party. */
  peerId: string;
  /** The most recent message in the conversation, or null if none. */
  lastMessage: StoredMessage | null;
  /** Number of inbound messages not yet marked as read. */
  unreadCount: number;
  /** Timestamp of the most recent message (ms since epoch). */
  updatedAt: number;
}
