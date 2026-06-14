import { MeshWhisper } from '@meshwhisper/sdk';
import type { Message, OutboundCiphertext } from '@meshwhisper/sdk';
import { idbStorage } from './storage.ts';
import type { WebPushSubscription } from './push.ts';

export const NAMESPACE = 'org.meshwhisper.prudence';
// Relay URL is configurable via the VITE_RELAY_URL env var so e2e tests
// (and dev contributors) can point at a local relay without forking.
// In production builds this falls back to the Foundation relay.
export const NODE = (import.meta.env.VITE_RELAY_URL as string | undefined) ?? 'wss://relay.meshwhisper.org';

let instance: MeshWhisper | null = null;

// SDK reference: canonical MeshWhisper.init() pattern with every callback
// wired. See ../REFERENCE.md "Init and storage backend" for the full map.
export async function initSDK(
  username: string,
  handlers: {
    onMessage: (msg: Message) => void;
    onMessageStatus?: (messageId: string, status: 'sending' | 'sent' | 'delivered' | 'read' | 'failed') => void;
    onCiphertext?: (info: OutboundCiphertext) => void;
    onTyping: (peerId: string, isTyping: boolean) => void;
    onContactRequest: (peerId: string, introducedBy: string, username?: string) => void;
    onConnectionStatus: (status: 'connected' | 'disconnected') => void;
    onGroupInvite?: (groupId: string, groupName: string, invitedBy: string, members: string[]) => void;
    onGroupMemberLeft?: (groupId: string, peerId: string) => void;
    onGroupMemberAdded?: (groupId: string, peerId: string, addedBy: string) => void;
    onGroupAdminChanged?: (groupId: string, newAdminId: string, changedBy: string) => void;
    onGroupMemberKicked?: (groupId: string, peerId: string, kickedBy: string) => void;
    onKickedFromGroup?: (groupId: string, kickedBy: string) => void;
    onGroupRenamed?: (groupId: string, newName: string, renamedBy: string) => void;
    onReactionUpdated?: (conversationId: string, messageId: string, peerId: string, emoji: string, added: boolean) => void;
    onDisappearingMessagesChanged?: (conversationId: string, ttlMs: number | null, changedBy: string) => void;
    onArchiveDirty?: (reason: 'tombstone' | 'revival') => void;
    onHistoryRequest?: (peerId: string) => boolean | Promise<boolean>;
    onHistoryRestored?: (peerId: string, count: number) => void;
  },
  pushSubscription?: WebPushSubscription | null,
) {
  if (instance) return instance;
  instance = await MeshWhisper.init({
    namespace: NAMESPACE,
    node: NODE,
    username,
    storage: idbStorage,
    ...(pushSubscription ? { push: { platform: 'webpush' as const, subscription: pushSubscription } } : {}),
    onMessage: handlers.onMessage,
    ...(handlers.onMessageStatus ? { onMessageStatus: handlers.onMessageStatus } : {}),
    ...(handlers.onCiphertext ? { onCiphertext: handlers.onCiphertext } : {}),
    onTyping: handlers.onTyping,
    onContactRequest: handlers.onContactRequest,
    onConnectionStatus: handlers.onConnectionStatus,
    ...(handlers.onGroupInvite ? { onGroupInvite: handlers.onGroupInvite } : {}),
    ...(handlers.onGroupMemberLeft ? { onGroupMemberLeft: handlers.onGroupMemberLeft } : {}),
    ...(handlers.onGroupMemberAdded ? { onGroupMemberAdded: handlers.onGroupMemberAdded } : {}),
    ...(handlers.onGroupAdminChanged ? { onGroupAdminChanged: handlers.onGroupAdminChanged } : {}),
    ...(handlers.onGroupMemberKicked ? { onGroupMemberKicked: handlers.onGroupMemberKicked } : {}),
    ...(handlers.onKickedFromGroup ? { onKickedFromGroup: handlers.onKickedFromGroup } : {}),
    ...(handlers.onGroupRenamed ? { onGroupRenamed: handlers.onGroupRenamed } : {}),
    ...(handlers.onReactionUpdated ? { onReactionUpdated: handlers.onReactionUpdated } : {}),
    ...(handlers.onDisappearingMessagesChanged ? { onDisappearingMessagesChanged: handlers.onDisappearingMessagesChanged } : {}),
    ...(handlers.onArchiveDirty ? { onArchiveDirty: handlers.onArchiveDirty } : {}),
    ...(handlers.onHistoryRequest ? { onHistoryRequest: handlers.onHistoryRequest } : {}),
    ...(handlers.onHistoryRestored ? { onHistoryRestored: handlers.onHistoryRestored } : {}),
  });
  return instance;
}

export function getSDK() {
  return instance;
}
