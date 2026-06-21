// =============================================================================
// Customer service — dispatcher (presence-based routing)
//
// The front door. A guest customer DMs the dispatcher; the dispatcher routes
// them to an AVAILABLE human agent and opens a supervised group
// [customer, agent, supervisor].
//
// "Available" is real presence: agents announce liveness to the dispatcher on
// a heartbeat (see agent.ts), and the dispatcher polls getPresence() to pick
// one that's online. If none are online, the customer is told to hold rather
// than dropped into a dead group.
//
// This is the piece that distinguishes this example from ticket-lifecycle
// (LLM triage) and supervised-chat (audit). For triage-before-escalation,
// compose this with ticket-lifecycle's tool-use bot.
// =============================================================================

import 'dotenv/config';
import { MeshWhisper } from '@meshwhisper/sdk';
import { startActor, decodeText } from './shared.js';

const USERNAME = process.env.DISPATCH_USERNAME ?? 'acme-dispatch';
const DATA_DIR = process.env.DISPATCH_DATA_DIR ?? './data/dispatch';
const SUPERVISOR_USERNAME = process.env.SUPERVISOR_USERNAME ?? 'acme-supervisor';
const AGENT_USERNAMES = (process.env.CS_AGENTS ?? 'acme-agent-1,acme-agent-2')
  .split(',').map((s) => s.trim()).filter(Boolean);

// username → peerId resolution, cached for the process lifetime.
// (addContactByKey('@name') resolves the handle via the relay directory and
// returns the peerId. resolveUsername is the *reverse* lookup, peerId → name.)
const resolved = new Map<string, string>();
async function resolve(username: string): Promise<string | null> {
  if (resolved.has(username)) return resolved.get(username)!;
  const peerId = await MeshWhisper.addContactByKey(`@${username}`);
  if (peerId) resolved.set(username, peerId);
  return peerId ?? null;
}

// A customer we've already placed in a group; we stop routing them.
const placed = new Set<string>();

/** Find an agent whose presence currently reads 'online'. */
async function pickAvailableAgent(): Promise<{ username: string; peerId: string } | null> {
  for (const username of AGENT_USERNAMES) {
    const peerId = await resolve(username);
    const status = peerId ? MeshWhisper.getPresence(peerId) : 'unresolved';
    console.log(`[presence-check] @${username} → ${peerId ? peerId.slice(0, 8) : '—'} = ${status}`);
    if (peerId && status === 'online') return { username, peerId };
  }
  return null;
}

async function route(customerPeerId: string, firstMessage: string): Promise<void> {
  const agent = await pickAvailableAgent();
  if (!agent) {
    await MeshWhisper.send(
      customerPeerId,
      new TextEncoder().encode(
        "Thanks for reaching out! All our agents are with other customers right now — " +
        "please hold and we'll connect you as soon as one is free.",
      ),
    );
    console.log(`[hold] no agent online for ${customerPeerId.slice(0, 8)}`);
    return;
  }

  const supervisor = await resolve(SUPERVISOR_USERNAME);
  if (!supervisor) {
    console.warn(`[route] supervisor @${SUPERVISOR_USERNAME} not resolvable — is it running?`);
    return;
  }

  await MeshWhisper.send(
    customerPeerId,
    new TextEncoder().encode(`Connecting you to ${agent.username} now…`),
  );

  // Supervisor is a visible member of the roster — oversight by cryptographic
  // membership, not a hidden tap.
  const group = MeshWhisper.createGroup({
    name: 'Acme Support',
    members: [customerPeerId, agent.peerId, supervisor],
  });
  await group.send(new TextEncoder().encode(`[handoff] customer is here. First message: "${firstMessage}"`));

  placed.add(customerPeerId);
  console.log(`[route] ${customerPeerId.slice(0, 8)} → ${agent.username} (group ${group.id.slice(0, 8)})`);
}

await startActor({
  username: USERNAME,
  dataDir: DATA_DIR,

  onMessage: (msg) => {
    if (msg.groupId) return; // dispatcher only fields the initial DM
    const me = MeshWhisper.getLocalPeerId();
    if (msg.senderId === me) return;
    if (placed.has(msg.senderId)) return;

    const text = decodeText(msg.payload);
    if (!text || !text.trim()) return;
    console.log(`[inbound] ${msg.senderId.slice(0, 8)}: ${text.slice(0, 80)}`);
    void route(msg.senderId, text);
  },
});

console.log(`  routing to agents: ${AGENT_USERNAMES.map((u) => '@' + u).join(', ')}`);
