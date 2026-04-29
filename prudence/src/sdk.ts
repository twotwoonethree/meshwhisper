import { MeshWhisper } from '@meshwhisper/sdk';
import type { Message } from '@meshwhisper/sdk';
import { idbStorage } from './storage.ts';
import type { WebPushSubscription } from './push.ts';

export const NAMESPACE = 'org.meshwhisper.prudence';
export const NODE = 'wss://relay.meshwhisper.org';

let instance: MeshWhisper | null = null;

export async function initSDK(
  username: string,
  handlers: {
    onMessage: (msg: Message) => void;
    onTyping: (peerId: string, isTyping: boolean) => void;
    onContactRequest: (peerId: string, introducedBy: string, username?: string) => void;
    onConnectionStatus: (status: 'connected' | 'disconnected') => void;
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
    ...handlers,
  });
  return instance;
}

export function getSDK() {
  return instance;
}
