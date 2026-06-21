// Common init helper for the customer-service actors. Each is a vanilla
// MeshWhisper peer; the only differences are which callbacks they wire up and
// whether they register a username. The customer registers NO username — it
// runs on a generated guest identity, the way an anonymous visitor reaches
// support.

import { MeshWhisper } from '@meshwhisper/sdk';
import { NodeStorage } from '@meshwhisper/sdk/persistence/node';
import type { Message } from '@meshwhisper/sdk';
import * as fs from 'node:fs';

const NAMESPACE = process.env.NAMESPACE ?? 'org.example.customer-service';
const NODE = process.env.MESHWHISPER_NODE ?? 'wss://relay.meshwhisper.org';

// A fixed developer key so every actor shares the same namespace and can find
// each other on a shared relay. In production this is YOUR stable app key.
const DEVELOPER_KEY = process.env.MESHWHISPER_DEV_KEY ?? 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export interface ActorConfig {
  /** Omit for a guest (the customer): no directory handle, generated identity. */
  username?: string;
  dataDir: string;
  onMessage?: (msg: Message) => void | Promise<void>;
  onGroupInvite?: (groupId: string, groupName: string, invitedBy: string, members: string[]) => void;
  onGroupReceipt?: (groupId: string, messageId: string, peerId: string, status: 'delivered' | 'read') => void;
  onPresence?: (peerId: string, status: string) => void;
}

/** Boot an actor and return the live instance. */
export async function startActor(cfg: ActorConfig): Promise<MeshWhisper> {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const storage = new NodeStorage(cfg.dataDir);
  const mw = await MeshWhisper.init({
    namespace: NAMESPACE,
    node: NODE,
    developerKey: DEVELOPER_KEY,
    storage,
    messageRetention: 'unbounded',
    ...(cfg.username ? { username: cfg.username } : {}),
    ...(cfg.onMessage ? { onMessage: cfg.onMessage } : {}),
    ...(cfg.onGroupInvite ? { onGroupInvite: cfg.onGroupInvite } : {}),
    ...(cfg.onGroupReceipt ? { onGroupReceipt: cfg.onGroupReceipt } : {}),
    ...(cfg.onPresence ? { onPresence: cfg.onPresence as (p: string, s: import('@meshwhisper/sdk').PresenceStatus) => void } : {}),
  });

  const label = cfg.username ? `@${cfg.username}` : 'guest';
  console.log('--');
  console.log(`[${label}] online`);
  console.log(`  peerId:   ${mw.getLocalPeerId()}`);
  console.log(`  data dir: ${cfg.dataDir}`);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[${label}] ${signal}`);
    await mw.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  return mw;
}

/** Decode an inbound payload to text, skipping internal control frames. */
export function decodeText(payload: ArrayLike<number>): string | null {
  try {
    const text = new TextDecoder().decode(new Uint8Array(payload));
    if (text.startsWith('{"__') && text.includes('_ctrl')) return null;
    return text;
  } catch {
    return null;
  }
}
