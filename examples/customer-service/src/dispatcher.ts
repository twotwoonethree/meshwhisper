// =============================================================================
// Customer service — dispatcher (presence-based routing + queue)
//
// The front door. A guest customer DMs the dispatcher; the dispatcher routes
// them to an AVAILABLE human agent and opens a supervised group
// [customer, agent, supervisor].
//
// "Available" is real presence: agents announce liveness to the dispatcher on
// a heartbeat (see agent.ts), and the dispatcher polls getPresence() to pick
// one that's online. If none are online the customer is QUEUED (FIFO) and told
// their position; a drain loop connects waiting customers as agents come
// available — first-come, first-served.
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
const DRAIN_MS = Number(process.env.CS_QUEUE_DRAIN_MS ?? 3000);

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

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

// Customers already placed in a group — we stop fielding their DMs.
const placed = new Set<string>();
// Waiting customers, FIFO. `queuedSet` dedupes against the array.
interface Waiting { peerId: string; firstMessage: string; queuedAt: number; }
const queue: Waiting[] = [];
const queuedSet = new Set<string>();

/** First agent whose presence currently reads 'online', else null. */
async function pickAvailableAgent(): Promise<{ username: string; peerId: string } | null> {
  for (const username of AGENT_USERNAMES) {
    const peerId = await resolve(username);
    if (peerId && MeshWhisper.getPresence(peerId) === 'online') return { username, peerId };
  }
  return null;
}

/** Open a supervised group and hand the customer off. Returns false if it
 *  couldn't (e.g. supervisor not resolvable) so the caller can keep them queued. */
async function escalate(
  customerPeerId: string,
  agent: { username: string; peerId: string },
  firstMessage: string,
): Promise<boolean> {
  const supervisor = await resolve(SUPERVISOR_USERNAME);
  if (!supervisor) {
    console.warn(`[route] supervisor @${SUPERVISOR_USERNAME} not resolvable — is it running?`);
    return false;
  }
  await MeshWhisper.send(customerPeerId, encode(`Connecting you to ${agent.username} now…`));
  // Supervisor is a visible member of the roster — oversight by cryptographic
  // membership, not a hidden tap.
  const group = MeshWhisper.createGroup({
    name: 'Acme Support',
    members: [customerPeerId, agent.peerId, supervisor],
  });
  await group.send(encode(`[handoff] customer is here. First message: "${firstMessage}"`));
  placed.add(customerPeerId);
  queuedSet.delete(customerPeerId);
  console.log(`[route] ${customerPeerId.slice(0, 8)} → ${agent.username} (group ${group.id.slice(0, 8)})`);
  return true;
}

/** Route now if an agent is free, otherwise queue and report position. */
async function routeOrQueue(customerPeerId: string, firstMessage: string): Promise<void> {
  const agent = await pickAvailableAgent();
  if (agent) {
    await escalate(customerPeerId, agent, firstMessage);
    return;
  }
  if (!queuedSet.has(customerPeerId)) {
    queuedSet.add(customerPeerId);
    queue.push({ peerId: customerPeerId, firstMessage, queuedAt: Date.now() });
  }
  const position = queue.findIndex((w) => w.peerId === customerPeerId) + 1;
  await MeshWhisper.send(customerPeerId, encode(
    `Thanks for reaching out! All our agents are busy right now. ` +
    `You're #${position} in the queue — we'll connect you the moment one is free.`,
  ));
  console.log(`[queue] ${customerPeerId.slice(0, 8)} waiting (#${position}, ${queue.length} total)`);
}

/** Connect queued customers, oldest first, while agents are available. */
async function drainQueue(): Promise<void> {
  while (queue.length > 0) {
    const agent = await pickAvailableAgent();
    if (!agent) break; // nobody free — leave the rest waiting
    const next = queue[0]!;
    const ok = await escalate(next.peerId, agent, next.firstMessage);
    if (!ok) break; // transient (e.g. supervisor down) — retry on the next tick
    queue.shift();
    console.log(`[drain] connected ${next.peerId.slice(0, 8)}; ${queue.length} still waiting`);
  }
}

await startActor({
  username: USERNAME,
  dataDir: DATA_DIR,

  onMessage: (msg) => {
    if (msg.groupId) return; // dispatcher only fields the initial DM
    const me = MeshWhisper.getLocalPeerId();
    if (msg.senderId === me) return;
    if (placed.has(msg.senderId)) return;       // already in a conversation
    if (queuedSet.has(msg.senderId)) return;    // already waiting — sit tight

    const text = decodeText(msg.payload);
    if (!text || !text.trim()) return;
    console.log(`[inbound] ${msg.senderId.slice(0, 8)}: ${text.slice(0, 80)}`);
    void routeOrQueue(msg.senderId, text);
  },
});

// Drain loop: agents come online via their presence heartbeat, so poll.
const drainTimer = setInterval(() => void drainQueue(), DRAIN_MS);
drainTimer.unref?.();

console.log(`  routing to agents: ${AGENT_USERNAMES.map((u) => '@' + u).join(', ')}`);
console.log(`  queue drain every ${DRAIN_MS}ms`);
