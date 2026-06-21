// =============================================================================
// Customer service — the customer (a GUEST)
//
// This is the part that makes it a real customer-service system rather than a
// chat between registered users: the customer inits with NO username, so it
// runs on a generated guest identity — the way an anonymous web visitor would.
// It reaches support purely by the dispatcher's handle.
//
// It sends an opening message, then anything you type at the prompt. It marks
// inbound replies read (so the agent sees ✓✓), and once it's pulled into the
// escalated group, the prompt routes there automatically.
//
// Usage:  npm run customer            (opens with a default message)
//         npm run customer -- "my order 1234 never arrived"
// =============================================================================

import 'dotenv/config';
import * as readline from 'node:readline';
import { MeshWhisper } from '@meshwhisper/sdk';
import { startActor, decodeText } from './shared.js';

const DATA_DIR = process.env.CUSTOMER_DATA_DIR ?? './data/customer';
const DISPATCH_USERNAME = process.env.DISPATCH_USERNAME ?? 'acme-dispatch';
const OPENING = process.argv.slice(2).join(' ') || 'Hi, I need help with my order.';

let groupId: string | null = null;

const mw = await startActor({
  dataDir: DATA_DIR, // no username → guest identity

  onGroupInvite: (gid, name) => {
    groupId = gid;
    MeshWhisper.acceptGroupInvite(gid);
    console.log(`\n[you're now in "${name}" — a human agent is joining]`);
  },

  onMessage: async (msg) => {
    const me = MeshWhisper.getLocalPeerId();
    if (msg.senderId === me) return;
    const text = decodeText(msg.payload);
    if (text === null) return;

    // Mark group replies read so the agent gets a read receipt (✓✓).
    if (msg.groupId) await MeshWhisper.markGroupRead(msg.groupId, msg.id);

    const who = msg.groupId ? 'support' : 'dispatch';
    process.stdout.write(`\n${who}> ${text}\nyou> `);
  },
});

// Resolve the dispatcher and send the opening message.
const dispatchPeerId = await MeshWhisper.addContactByKey(`@${DISPATCH_USERNAME}`);
if (!dispatchPeerId) {
  console.error(`Could not reach @${DISPATCH_USERNAME} — is the dispatcher running?`);
  process.exit(1);
}
await MeshWhisper.send(dispatchPeerId, new TextEncoder().encode(OPENING));
console.log(`\nyou> ${OPENING}`);

// Interactive prompt: route to the group once escalated, else to the dispatcher.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'you> ' });
rl.on('line', (line) => {
  void (async () => {
    const text = line.trim();
    if (!text) { rl.prompt(); return; }
    if (groupId) {
      await MeshWhisper.getGroup(groupId)?.send(new TextEncoder().encode(text));
    } else {
      await MeshWhisper.send(dispatchPeerId, new TextEncoder().encode(text));
    }
  })();
});
void mw;
