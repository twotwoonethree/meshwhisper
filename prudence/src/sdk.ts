import { MeshWhisper } from '@meshwhisper/sdk';
import type { Message } from '@meshwhisper/sdk';
import { idbStorage } from './storage.ts';
import type { WebPushSubscription } from './push.ts';

export const NAMESPACE = 'org.meshwhisper.prudence';
// Relay URL is configurable via the VITE_RELAY_URL env var so e2e tests
// (and dev contributors) can point at a local relay without forking.
// In production builds this falls back to the Foundation relay.
export const NODE = (import.meta.env.VITE_RELAY_URL as string | undefined) ?? 'wss://relay.meshwhisper.org';

let instance: MeshWhisper | null = null;

export async function initSDK(
  username: string,
  handlers: {
    onMessage: (msg: Message) => void;
    onTyping: (peerId: string, isTyping: boolean) => void;
    onContactRequest: (peerId: string, introducedBy: string, username?: string) => void;
    onConnectionStatus: (status: 'connected' | 'disconnected') => void;
    onGroupInvite?: (groupId: string, groupName: string, invitedBy: string, members: string[]) => void;
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
    onTyping: handlers.onTyping,
    onContactRequest: handlers.onContactRequest,
    onConnectionStatus: handlers.onConnectionStatus,
    ...(handlers.onGroupInvite ? { onGroupInvite: handlers.onGroupInvite } : {}),
  });
  return instance;
}

export function getSDK() {
  return instance;
}
