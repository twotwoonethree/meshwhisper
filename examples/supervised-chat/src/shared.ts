// Shared init helper for both actors in this demo. Both the support agent
// and the compliance supervisor are just MeshWhisper peers running in Node;
// the only differences are which callbacks they wire up and whether they
// reply (agent: yes, supervisor: no by convention).

import { MeshWhisper } from '@meshwhisper/sdk';
import { NodeStorage } from '@meshwhisper/sdk/persistence/node';
import type { Message } from '@meshwhisper/sdk';
import * as fs from 'node:fs';

const NAMESPACE = process.env.NAMESPACE ?? 'org.example.supervised-chat';
const NODE = process.env.MESHWHISPER_NODE ?? 'wss://relay.meshwhisper.org';

export interface BotConfig {
  username: string;
  dataDir: string;
  onMessage?: (msg: Message) => void;
  onGroupInvite?: (
    groupId: string,
    groupName: string,
    invitedBy: string,
    members: string[],
  ) => void;
}

export async function startBot(cfg: BotConfig): Promise<void> {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const storage = new NodeStorage(cfg.dataDir);

  const mw = await MeshWhisper.init({
    namespace: NAMESPACE,
    node: NODE,
    username: cfg.username,
    storage,
    // Customer-service tickets need full history on demand. For chattier
    // deployments swap in { kind: 'ageMs', max: ... } to bound disk growth.
    messageRetention: 'unbounded',
    onConnectionStatus: (status) => {
      console.log(`[${cfg.username}] net: ${status}`);
    },
    ...(cfg.onMessage ? { onMessage: cfg.onMessage } : {}),
    ...(cfg.onGroupInvite ? { onGroupInvite: cfg.onGroupInvite } : {}),
  });

  console.log('--');
  console.log(`[${cfg.username}] online`);
  console.log(`  peerId:   ${mw.getLocalPeerId()}`);
  console.log(`  username: @${cfg.username}`);
  console.log(`  data dir: ${cfg.dataDir}`);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[${cfg.username}] ${signal}`);
    await mw.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/**
 * Decode a payload to UTF-8 text. Returns null when the bytes don't look
 * like text (e.g. media-pointer messages, binary protocol envelopes).
 */
export function decodeText(payload: Uint8Array): string | null {
  try {
    const text = new TextDecoder().decode(payload);
    // Filter app-level control envelopes (Prudence uses __prudence_ctrl, etc).
    if (text.startsWith('{"__') && text.includes('_ctrl')) return null;
    return text;
  } catch {
    return null;
  }
}
