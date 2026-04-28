export interface Contact {
  peerId: string;
  username?: string;
  displayName: string;
  addedAt: number;
}

export interface AppMessage {
  id: string;
  conversationId: string;
  text: string;
  timestamp: number;
  direction: 'inbound' | 'outbound';
  status: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
}

export interface Conversation {
  id: string;
  contact: Contact;
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
  connected: boolean;
}
