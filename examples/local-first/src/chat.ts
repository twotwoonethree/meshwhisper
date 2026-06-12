// ============================================================
// local-first chat — human on-site comms
//
// Two peers on the same LAN keep messaging when the relay dies.
//
//   npx tsx src/chat.ts alice --lan-port 19401
//   npx tsx src/chat.ts bob   --lan-port 19402
//
// (distinct --lan-port values are only needed when both peers run
//  on the SAME machine; on two machines the defaults are fine)
//
// In alice:   /add @bob   — then chat.
// Then stop the relay and keep typing. Messages still arrive,
// peer-to-peer over the LAN. The [relay down] marker shows you
// when you're running infrastructure-free.
// ============================================================

import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { MeshWhisper } from '@meshwhisper/sdk';
import { NodeStorage } from '@meshwhisper/sdk/persistence/node';

const NAMESPACE = process.env.MW_NAMESPACE ?? 'org.example.local-first';
const NODE_URL = process.env.MW_NODE_URL ?? 'ws://localhost:8080';

const username = process.argv[2];
if (!username) {
  console.error('usage: npx tsx src/chat.ts <username> [--lan-port <tcpPort>]');
  process.exit(1);
}
const lanPortIdx = process.argv.indexOf('--lan-port');
const lanTcpPort = lanPortIdx > 0 ? parseInt(process.argv[lanPortIdx + 1]!, 10) : undefined;

let relayUp = false;

const mw = await MeshWhisper.init({
  namespace: NAMESPACE,
  node: NODE_URL,
  username,
  storage: new NodeStorage(`./.meshwhisper/${username}`),
  transports: { lan: lanTcpPort ? { tcpPort: lanTcpPort } : true },
  onMessage: async (message) => {
    const text = new TextDecoder().decode(new Uint8Array(message.payload));
    const via = relayUp ? '' : '  (peer-to-peer — no relay)';
    console.log(`\n  ${message.senderId.slice(0, 8)}…  ${text}${via}`);
    await MeshWhisper.markRead(message.id, message.senderId);
  },
  onConnectionStatus: (status) => {
    relayUp = status === 'connected';
    console.log(relayUp ? '  [relay up]' : '  [relay down — LAN-only mode]');
  },
});

console.log(`  you are @${username}  (${mw.getLocalPeerId().slice(0, 16)}…)`);
console.log('  /add @name to add a contact; anything else sends to the last contact\n');

let currentPeer: string | null = null;
const rl = readline.createInterface({ input, output });

for (;;) {
  const line = (await rl.question('> ')).trim();
  if (!line) continue;
  if (line === '/quit') break;
  if (line.startsWith('/add ')) {
    // Contact establishment needs the relay's prekey directory — do it
    // while the relay is up. Once the session exists, the conversation
    // itself no longer depends on any infrastructure.
    const peerId = await MeshWhisper.addContactByKey(line.slice(5).trim());
    if (peerId) {
      currentPeer = peerId;
      console.log(`  added → ${peerId.slice(0, 16)}…`);
    } else {
      console.log('  could not find that user (is the relay up? first contact needs it)');
    }
    continue;
  }
  if (!currentPeer) {
    console.log('  no contact yet — /add @name first');
    continue;
  }
  await MeshWhisper.send(currentPeer, new TextEncoder().encode(line)).catch(() => {
    // Relay send failed (it's down) — the LAN copy has already gone out.
  });
}

rl.close();
process.exit(0);
