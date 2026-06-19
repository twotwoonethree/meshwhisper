// Child-process worker for the customer-service end-to-end test.
// argv: <nodeUrl> <role> [username]
//   role ∈ triage | agent | supervisor | customer
//   customer is a GUEST: no username is passed, so it inits with a generated
//   identity and never registers a directory handle — the way an anonymous
//   web visitor reaches support.
//
// The triage role is an autonomous bot: on an inbound DM it either replies
// (rule-based stand-in for the LLM in examples/ticket-lifecycle) or, when the
// message asks for a human, escalates by creating a supervised group
// [customer, agent, supervisor] — the cryptographic-oversight pattern.
//
// Line protocol (stdio):
//   stdout:  READY <peerId>
//            ADDED <peerId>
//            PREPPED                         triage resolved agent+supervisor
//            SENT                            DM sent
//            GSENT                           group message sent
//            INVITED <groupId>               received + auto-accepted a group invite
//            ESCALATED <groupId> <peer8>     triage opened a supervised group
//            REPLY <peer8> <text>            triage answered a DM (no escalation)
//            MSG <conversationId> <messageId> <text>   inbound message
//            ERR <detail>
//   stdin:   ADD <@username>
//            PREP <@agent> <@supervisor>     (triage only)
//            SEND <peerId> <text>            DM
//            GSEND <groupId> <text>

import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MeshWhisper } from '../../src/index.js';
import { NodeStorage } from '../../src/persistence/node-storage.js';

const [, , nodeUrl, role, username] = process.argv;
const DEV_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const AGENT_USER = process.env.CS_AGENT_USER ?? '@acme-agent';
const SUPERVISOR_USER = process.env.CS_SUPERVISOR_USER ?? '@acme-supervisor';
const ESCALATE_RE = /\b(human|agent|supervisor|person)\b/i;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mw-cs-${role}-`));

// Decode an inbound payload to text, skipping internal control frames.
function decodeText(payload: ArrayLike<number>): string | null {
  try {
    const text = new TextDecoder().decode(new Uint8Array(payload));
    if (text.startsWith('{"__') && text.includes('_ctrl')) return null;
    return text;
  } catch {
    return null;
  }
}

// Triage state.
const escalated = new Set<string>();
const inFlight = new Set<string>();
let agentPeer: string | null = null;
let supervisorPeer: string | null = null;

async function escalate(customerPeerId: string, reason: string): Promise<void> {
  if (!agentPeer || !supervisorPeer) {
    console.log('ERR triage-not-prepped');
    return;
  }
  // Tell the customer first, in their existing DM session.
  await MeshWhisper.send(
    customerPeerId,
    new TextEncoder().encode(`Connecting you to a human now. Reason: ${reason}`),
  );
  // The supervisor is a visible member of the roster — oversight by
  // cryptographic membership, not a hidden tap.
  const handle = MeshWhisper.createGroup({
    name: 'Acme Support (escalated)',
    members: [customerPeerId, agentPeer, supervisorPeer],
  });
  await handle.send(
    new TextEncoder().encode(`[handoff] reason: ${reason} — customer is in this group now.`),
  );
  escalated.add(customerPeerId);
  console.log(`ESCALATED ${handle.id} ${customerPeerId.slice(0, 8)}`);
}

async function onTriageDm(senderId: string, text: string): Promise<void> {
  if (escalated.has(senderId)) return;
  if (inFlight.has(senderId)) return;
  inFlight.add(senderId);
  try {
    if (ESCALATE_RE.test(text)) {
      await escalate(senderId, text.slice(0, 60));
    } else {
      await MeshWhisper.send(senderId, new TextEncoder().encode(`ack: ${text}`));
      console.log(`REPLY ${senderId.slice(0, 8)} ack: ${text}`);
    }
  } catch (err) {
    console.log(`ERR escalate ${(err as Error).message?.slice(0, 120)}`);
  } finally {
    inFlight.delete(senderId);
  }
}

const mw = await MeshWhisper.init({
  namespace: 'com.test.customerservice',
  node: nodeUrl,
  developerKey: DEV_KEY,
  ...(username ? { username } : {}), // customer is a guest: no username
  storage: new NodeStorage(dir),
  transports: { lan: false },
  onMessage: (message) => {
    const me = MeshWhisper.getLocalPeerId();
    if (message.senderId === me) return;
    const text = decodeText(message.payload);
    if (text === null) return;
    const conv = message.groupId ?? message.senderId;
    console.log(`MSG ${conv} ${message.id} ${text}`);
    if (role === 'triage' && !message.groupId && text.trim()) {
      void onTriageDm(message.senderId, text);
    }
  },
  onGroupInvite: (groupId) => {
    MeshWhisper.acceptGroupInvite(groupId);
    console.log(`INVITED ${groupId}`);
  },
});

console.log(`READY ${mw.getLocalPeerId()}`);

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  void (async () => {
    try {
      if (line.startsWith('ADD ')) {
        const peerId = await MeshWhisper.addContactByKey(line.slice(4).trim());
        console.log(peerId ? `ADDED ${peerId}` : 'ERR add-failed');
        return;
      }
      if (line.startsWith('PREP ')) {
        const [a, s] = line.slice(5).trim().split(/\s+/);
        agentPeer = await MeshWhisper.addContactByKey(a ?? AGENT_USER);
        supervisorPeer = await MeshWhisper.addContactByKey(s ?? SUPERVISOR_USER);
        console.log(agentPeer && supervisorPeer ? 'PREPPED' : 'ERR prep-failed');
        return;
      }
      if (line.startsWith('SEND ')) {
        const idx = line.indexOf(' ', 5);
        const peerId = line.slice(5, idx);
        const text = line.slice(idx + 1);
        await MeshWhisper.send(peerId, new TextEncoder().encode(text));
        console.log('SENT');
        return;
      }
      if (line.startsWith('GSEND ')) {
        const idx = line.indexOf(' ', 6);
        const groupId = line.slice(6, idx);
        const text = line.slice(idx + 1);
        const handle = MeshWhisper.getGroup(groupId);
        if (!handle) { console.log('ERR no-group'); return; }
        await handle.send(new TextEncoder().encode(text));
        console.log('GSENT');
        return;
      }
    } catch (err) {
      console.log(`ERR ${(err as Error).message?.slice(0, 120)}`);
    }
  })();
});
rl.on('close', () => process.exit(0));
