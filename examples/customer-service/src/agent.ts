// =============================================================================
// Customer service — human agent
//
// Two things make this more than a chat bot, and both use primitives the SDK
// gained for customer service:
//
//  1. PRESENCE HEARTBEAT — the agent calls announcePresence([dispatcher]) on
//     an interval so the dispatcher's getPresence() reads it as online and
//     routes new customers to it. Stop the heartbeat (kill the process) and
//     the dispatcher stops routing here — that's availability.
//
//  2. READ RECEIPTS — when the agent's reply is read by the customer, the
//     agent's onGroupReceipt fires (✓✓). The agent also markGroupRead()s the
//     customer's messages, so the customer sees the agent has read theirs.
//
// Replace the canned replies with your CRM / portal UI; the messaging is the
// only part MeshWhisper owns.
// =============================================================================

import 'dotenv/config';
import { MeshWhisper } from '@meshwhisper/sdk';
import { startActor, decodeText } from './shared.js';

const USERNAME = process.env.AGENT_USERNAME ?? 'acme-agent-1';
const DATA_DIR = process.env.AGENT_DATA_DIR ?? `./data/${USERNAME}`;
const DISPATCH_USERNAME = process.env.DISPATCH_USERNAME ?? 'acme-dispatch';
const HEARTBEAT_MS = Number(process.env.CS_HEARTBEAT_MS ?? 4000);

const greeted = new Set<string>();
const inFlight = new Set<string>();

const mw = await startActor({
  username: USERNAME,
  dataDir: DATA_DIR,

  onGroupInvite: (groupId, groupName, invitedBy, members) => {
    console.log(`[invite] ${groupName} (${groupId.slice(0, 8)}, ${members.length} members)`);
    MeshWhisper.acceptGroupInvite(groupId);
  },

  // Fires on OUR device when a reply we sent is delivered to / read by a member.
  onGroupReceipt: (groupId, messageId, peerId, status) => {
    const mark = status === 'read' ? '✓✓ read' : '✓ delivered';
    console.log(`[receipt ${groupId.slice(0, 8)}] ${mark} by ${peerId.slice(0, 8)} (msg ${messageId.slice(0, 8)})`);
  },

  onMessage: async (msg) => {
    if (!msg.groupId) return;
    const me = MeshWhisper.getLocalPeerId();
    if (msg.groupSenderId === me) return;

    const text = decodeText(msg.payload);
    if (!text || !text.trim()) return;

    // Let the sender know we've seen their message (sends a read receipt to them).
    await MeshWhisper.markGroupRead(msg.groupId, msg.id);

    if (inFlight.has(msg.groupId)) return;
    inFlight.add(msg.groupId);
    try {
      const handle = MeshWhisper.getGroup(msg.groupId);
      if (!handle) return;

      if (!greeted.has(msg.groupId) && text.startsWith('[handoff]')) {
        greeted.add(msg.groupId);
        await handle.send(new TextEncoder().encode(
          `Hi, I'm ${USERNAME} on the Acme support team — I've got the context and I'm here to help. ` +
          `What can I do for you?`,
        ));
        console.log(`[greet ${msg.groupId.slice(0, 8)}]`);
        return;
      }

      console.log(`[recv ${msg.groupId.slice(0, 8)}] ${(msg.groupSenderId ?? msg.senderId).slice(0, 8)}: ${text.slice(0, 80)}`);
      await handle.send(new TextEncoder().encode(`Got it — looking into that now.`));
    } finally {
      inFlight.delete(msg.groupId);
    }
  },
});

// --- Presence heartbeat: advertise availability to the dispatcher ---
let dispatchPeerId: string | null = null;
async function heartbeat(): Promise<void> {
  try {
    if (!dispatchPeerId) {
      dispatchPeerId = await MeshWhisper.addContactByKey(`@${DISPATCH_USERNAME}`);
      if (dispatchPeerId) console.log(`[presence] advertising availability to @${DISPATCH_USERNAME}`);
    }
    if (dispatchPeerId) MeshWhisper.announcePresence([dispatchPeerId]);
  } catch { /* dispatcher not up yet — retry next tick */ }
}
await heartbeat();
const timer = setInterval(() => void heartbeat(), HEARTBEAT_MS);
timer.unref?.();
void mw;
