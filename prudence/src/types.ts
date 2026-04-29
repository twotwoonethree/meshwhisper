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

export interface AppMessage {
  id: string;
  conversationId: string;
  text: string;
  timestamp: number;
  direction: 'inbound' | 'outbound';
  status: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  senderId?: string;
  senderName?: string;
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
}
