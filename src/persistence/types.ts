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
