/** Cached relay-visible bytes for one outbound message (from onCiphertext),
 *  hex-encoded for the Ciphertext Peek inspector. */
export interface CiphertextInfo {
  ciphertextHex: string;
  destHashHex: string;
  byteLength: number;
  plaintextLength: number;
}

export interface Contact {
  peerId: string;
  username?: string;
  displayName: string;
  addedAt: number;
}

export interface GroupInfo {
  id: string;
  name: string;
  members: { peerId: string; username?: string; role: 'admin' | 'member' }[];
}

export interface AppMessageMedia {
  url: string;
  key: string;
  mimeType: string;
  thumb?: string;
  fileName?: string;
  fileSize?: number;
  status: 'uploading' | 'pending' | 'downloading' | 'ready' | 'error';
  objectUrl?: string;
}

export interface AppMessage {
  id: string;
  conversationId: string;
  text: string;
  timestamp: number;
  direction: 'inbound' | 'outbound';
  status: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  senderId?: string;
  senderName?: string;
  media?: AppMessageMedia;
  /** Per-emoji set of peerIds currently reacting. Mirrors the SDK's
   *  StoredMessage.reactions shape. */
  reactions?: Record<string, string[]>;
  /** Set when this message was sent as a quoted reply. */
  replyTo?: { messageId: string; snippetText?: string };
  /** Set when this message was forwarded; peerId of the original author. */
  forwardedFrom?: string;
}

export interface Conversation {
  id: string;
  contact: Contact;
  group?: GroupInfo;
  lastMessage?: AppMessage;
  unread: number;
  isTyping: boolean;
}

export interface AppState {
  myUsername: string;
  conversations: Conversation[];
  activeConversationId: string | null;
  messages: Record<string, AppMessage[]>;
  pendingRequests: Array<{ peerId: string; username?: string; introducedBy: string }>;
  pendingGroupInvites: Array<{ groupId: string; groupName: string; invitedBy: string; members: string[] }>;
  connected: boolean;
  /** Disappearing-messages policy per conversation. Mirrors the SDK's
   *  in-memory map so the header UI can reflect it without re-querying. */
  disappearingByConversation?: Record<string, number | null>;
}
