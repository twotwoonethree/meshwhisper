// =============================================================================
// Ticket lifecycle — human agent
//
// Simulates the human picking up after the triage bot escalates. Auto-accepts
// any group invite (a real deployment would route to specific agents based
// on team, skill, language, on-call rotation, etc.).
//
// First inbound message to a newly-joined group is typically the triage
// handoff context. The agent replies with a courteous "I've got it from
// here" acknowledgement, then leaves the conversation open for whichever
// real human takes the ticket. Replace the canned reply with your CRM /
// ticket-system integration.
// =============================================================================

import 'dotenv/config';
import { MeshWhisper } from '@meshwhisper/sdk';
import { startBot, decodeText } from './shared.js';

const USERNAME = process.env.AGENT_USERNAME ?? 'acme-human-agent';
const DATA_DIR = process.env.AGENT_DATA_DIR ?? './data/agent';

const GREETING =
  `Hi — I'm Sam from the Acme support team. I've read the context from our triage bot ` +
  `and I'll take this from here. Could you confirm the order or account ID this relates to?`;

// Groups we've already greeted, so the canned greeting doesn't fire on
// every inbound message. Per-process; resets on restart.
const greeted = new Set<string>();

const inFlight = new Set<string>();

await startBot({
  username: USERNAME,
  dataDir: DATA_DIR,

  onGroupInvite: (groupId, groupName, invitedBy, members) => {
    console.log(
      `[invite] ${groupName} (${groupId.slice(0, 8)}, ${members.length} members) ` +
      `from ${invitedBy.slice(0, 8)}`,
    );
    MeshWhisper.acceptGroupInvite(groupId);
  },

  onMessage: async (msg) => {
    if (!msg.groupId) return;
    const me = MeshWhisper.getLocalPeerId();
    if (msg.groupSenderId === me) return;

    const text = decodeText(msg.payload);
    if (!text || !text.trim()) return;

    const key = msg.groupId;
    if (inFlight.has(key)) return;
    inFlight.add(key);

    console.log(
      `[recv ${msg.groupId.slice(0, 8)}] ${(msg.groupSenderId ?? msg.senderId).slice(0, 8)}: ${text.slice(0, 80)}`,
    );

    try {
      const handle = MeshWhisper.getGroup(msg.groupId);
      if (!handle) return;

      // First message in a freshly-escalated group is the bot's context
      // dump. Respond with a greeting; let the customer take it from there.
      if (!greeted.has(msg.groupId) && text.startsWith('[Triage handoff]')) {
        greeted.add(msg.groupId);
        await handle.send(new TextEncoder().encode(GREETING));
        console.log(`[greet ${msg.groupId.slice(0, 8)}]`);
        return;
      }

      // Otherwise, respond with a generic acknowledgement. A real agent
      // would type their own reply via a portal UI; for this demo we
      // confirm the customer's message so the flow is visible.
      const ack = `Got it — looking into that now. One moment.`;
      await handle.send(new TextEncoder().encode(ack));
      console.log(`[ack ${msg.groupId.slice(0, 8)}]`);
    } catch (err) {
      console.error(`[err] ${msg.groupId.slice(0, 8)} failed:`, err);
    } finally {
      inFlight.delete(key);
    }
  },
});
