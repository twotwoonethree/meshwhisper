// =============================================================================
// Supervised-chat — support agent
//
// Behaviour:
//   - Publishes username @acme-support so customers can add it from their app.
//   - Auto-accepts every group invite (a real deployment gates on tenant ID).
//   - When a customer sends a message to a group, replies with a canned
//     acknowledgement. Swap in any logic (LLM, human queue, ticket-creation,
//     handoff to a CRM) without touching the rest of the integration.
//
// What this demonstrates: the agent is just a MeshWhisper peer. Nothing about
// being in a "supervised" group changes its code — the supervisor is invisible
// to the protocol layer. Transparency comes from the supervisor's peerId
// being visible in the group roster.
// =============================================================================

import 'dotenv/config';
import { MeshWhisper } from '@meshwhisper/sdk';
import { startBot, decodeText } from './shared.js';

const USERNAME = process.env.AGENT_USERNAME ?? 'acme-support';
const DATA_DIR = process.env.AGENT_DATA_DIR ?? './data/agent';

const CANNED_REPLY = `Thanks for reaching out — I'll take a look and get back to you.`;

// Per-group concurrency guard. Avoids stacking replies if a customer sends
// several messages in quick succession.
const inFlight = new Set<string>();

await startBot({
  username: USERNAME,
  dataDir: DATA_DIR,

  onGroupInvite: (groupId, groupName, invitedBy, members) => {
    // Note the supervisor's peerId(s) visible here — proof that no hidden
    // supervisor can be added without the agent (and the customer) seeing
    // them in the roster.
    console.log(
      `[invite] joining "${groupName}" (${groupId.slice(0, 8)}, ` +
      `${members.length} members) invited by ${invitedBy.slice(0, 8)}`,
    );
    MeshWhisper.acceptGroupInvite(groupId);
  },

  onMessage: async (msg) => {
    // Only respond to messages addressed to a group we're in. DMs to the
    // agent are out of scope for this demo.
    if (!msg.groupId) return;

    // Don't reply to our own group messages (mirrored back through the
    // group sender-key fan-out).
    const me = MeshWhisper.getLocalPeerId();
    if (msg.groupSenderId === me) return;

    const text = decodeText(msg.payload);
    if (!text || !text.trim()) return;

    const groupKey = msg.groupId;
    if (inFlight.has(groupKey)) return;
    inFlight.add(groupKey);

    console.log(
      `[recv ${msg.groupId.slice(0, 8)}] ${(msg.groupSenderId ?? msg.senderId).slice(0, 8)}: ${text.slice(0, 80)}`,
    );

    try {
      const handle = MeshWhisper.getGroup(msg.groupId);
      if (!handle) {
        console.warn(`[err] no GroupHandle for ${msg.groupId.slice(0, 8)}`);
        return;
      }
      await handle.send(new TextEncoder().encode(CANNED_REPLY));
      console.log(`[sent ${msg.groupId.slice(0, 8)}] ${CANNED_REPLY}`);
    } catch (err) {
      console.error(`[err] reply to ${msg.groupId.slice(0, 8)} failed:`, err);
    } finally {
      inFlight.delete(groupKey);
    }
  },
});
