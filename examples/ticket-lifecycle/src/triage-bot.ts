// =============================================================================
// Ticket lifecycle — triage bot
//
// First touch for a customer. Runs LLM-backed triage on inbound DMs and
// decides on each turn whether to:
//   (a) answer directly, OR
//   (b) escalate to a human by creating a supervised group containing the
//       customer, a human agent, and a compliance supervisor.
//
// The decision uses Claude's tool-use API: a single `escalate_to_human`
// tool exposed to the model. When Claude calls the tool, this bot does the
// handoff. Otherwise it replies with whatever text Claude returned.
//
// Why this shape: tool-use puts the escalation policy in the model's
// hands (where it can read the conversation) rather than in keyword
// heuristics. The bot author just describes "when to escalate" in the
// system prompt; the model decides per turn.
// =============================================================================

import 'dotenv/config';
import { MeshWhisper } from '@meshwhisper/sdk';
import Anthropic from '@anthropic-ai/sdk';
import { startBot, decodeText } from './shared.js';

const USERNAME = process.env.TRIAGE_USERNAME ?? 'acme-triage';
const DATA_DIR = process.env.TRIAGE_DATA_DIR ?? './data/triage';
const AGENT_USERNAME = process.env.AGENT_USERNAME ?? 'acme-human-agent';
const SUPERVISOR_USERNAME = process.env.SUPERVISOR_USERNAME ?? 'acme-compliance';
const HISTORY_TURNS = 20;

const SYSTEM_PROMPT = `You are the first-line customer-support assistant for Acme.
Be concise — most replies should be one or two sentences.

Use the escalate_to_human tool when:
- the customer explicitly asks to talk to a human, agent, or supervisor
- the issue requires authority you don't have (refunds over policy, account
  cancellation, legal questions, billing disputes)
- the customer is angry or distressed and a human can help better
- you've made two unsuccessful attempts to resolve the same issue

Otherwise, just answer the customer's question. Never invent product details.`;

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('ticket-lifecycle/triage-bot requires ANTHROPIC_API_KEY in env.');
  process.exit(1);
}
const anthropic = new Anthropic({ apiKey });

// Once a customer is escalated, the triage bot goes quiet on their DM —
// the conversation continues in the supervised group. In-memory is fine
// for the demo; a real deployment persists this to NodeStorage so it
// survives restarts.
const escalated = new Set<string>();

// Per-peer in-flight guard so back-to-back messages don't fire two LLM
// calls. The SDK already handles ratchet ordering; this just avoids
// wasted prompt cost.
const inFlight = new Set<string>();

// Resolve agent + supervisor peerIds from the relay directory once at
// startup. Cached for the lifetime of the bot — restart to pick up
// directory changes.
let cachedAgentPeerId: string | null = null;
let cachedSupervisorPeerId: string | null = null;

async function resolveTargets(): Promise<{ agent: string; supervisor: string } | null> {
  if (cachedAgentPeerId && cachedSupervisorPeerId) {
    return { agent: cachedAgentPeerId, supervisor: cachedSupervisorPeerId };
  }
  const agent = await MeshWhisper.resolveUsername(AGENT_USERNAME);
  const supervisor = await MeshWhisper.resolveUsername(SUPERVISOR_USERNAME);
  if (!agent || !supervisor) {
    console.warn(
      `[triage] cannot resolve targets — ` +
      `@${AGENT_USERNAME}=${agent ?? 'missing'}, ` +
      `@${SUPERVISOR_USERNAME}=${supervisor ?? 'missing'}. ` +
      `Make sure both bots are running.`,
    );
    return null;
  }
  cachedAgentPeerId = agent;
  cachedSupervisorPeerId = supervisor;
  return { agent, supervisor };
}

async function buildHistoryForLLM(peerId: string): Promise<Anthropic.MessageParam[]> {
  const stored = await MeshWhisper.getMessages(peerId, { limit: HISTORY_TURNS });
  return stored
    .map((m) => ({
      role: (m.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: new TextDecoder().decode(new Uint8Array(m.payload)),
    }))
    .filter((m) => m.content.trim().length > 0);
}

async function escalate(
  customerPeerId: string,
  reason: string,
  messages: Anthropic.MessageParam[],
): Promise<void> {
  const targets = await resolveTargets();
  if (!targets) {
    await MeshWhisper.send(
      customerPeerId,
      new TextEncoder().encode(
        "I'd like to escalate this to a human, but the support team is offline right now. " +
        "Please try again in a moment.",
      ),
    );
    return;
  }

  // 1. Tell the customer what's happening.
  await MeshWhisper.send(
    customerPeerId,
    new TextEncoder().encode(
      `Connecting you to a human agent now in a supervised conversation. ` +
      `Reason: ${reason}`,
    ),
  );

  // 2. Create the supervised group. Customer + agent + supervisor.
  //    The supervisor's peerId is visible in the group roster — cryptographic
  //    transparency, not a hidden monitor.
  const handle = MeshWhisper.createGroup({
    name: 'Acme Support (escalated)',
    members: [customerPeerId, targets.agent, targets.supervisor],
  });

  // 3. Drop a short context message into the group so the human agent
  //    isn't starting from zero. Includes the recent turns so they can
  //    see what the bot already tried.
  const transcript = messages
    .slice(-10)
    .map((m) => {
      const role = m.role === 'user' ? 'Customer' : 'Bot';
      const text = typeof m.content === 'string'
        ? m.content
        : '[non-text]';
      return `${role}: ${text}`;
    })
    .join('\n');

  const contextMsg =
    `[Triage handoff]\n` +
    `Reason: ${reason}\n\n` +
    `Recent conversation:\n${transcript}\n\n` +
    `Over to you — the customer is in this group now.`;

  await handle.send(new TextEncoder().encode(contextMsg));

  // 4. Mark the customer as escalated so we stop replying to them in DM.
  escalated.add(customerPeerId);

  console.log(`[escalated] ${customerPeerId.slice(0, 8)} → group ${handle.id.slice(0, 8)}`);
}

async function handleCustomerMessage(senderId: string, text: string): Promise<void> {
  if (escalated.has(senderId)) {
    // Customer is in an escalated group now. Don't reply in DM — they
    // should continue in the group. (Could send a one-time nudge, but
    // duplicating noise is worse than silence.)
    return;
  }

  const messages = await buildHistoryForLLM(senderId);

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 1024,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tools: [
      {
        name: 'escalate_to_human',
        description:
          'Escalate the conversation to a human agent by creating a supervised group ' +
          'containing the customer, a human agent, and a compliance supervisor.',
        input_schema: {
          type: 'object',
          properties: {
            reason: {
              type: 'string',
              description:
                'Brief, customer-facing reason for the escalation. ' +
                'Will be shown to the customer and logged for the human agent.',
            },
          },
          required: ['reason'],
        },
      },
    ],
    messages,
  });

  // Check for tool use first — if Claude called escalate_to_human, do that
  // and skip any text reply.
  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  );
  if (toolUse && toolUse.name === 'escalate_to_human') {
    const input = toolUse.input as { reason?: string };
    const reason = input.reason ?? 'human assistance requested';
    await escalate(senderId, reason, messages);
    return;
  }

  // No tool use → reply with the model's text response.
  const reply = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
  if (!reply) return;

  await MeshWhisper.send(senderId, new TextEncoder().encode(reply));
  console.log(`[reply] ${senderId.slice(0, 8)}: ${reply.slice(0, 80)}`);
  void text;
}

await startBot({
  username: USERNAME,
  dataDir: DATA_DIR,

  onMessage: async (msg) => {
    if (msg.groupId) return; // triage bot only handles DMs
    const me = MeshWhisper.getLocalPeerId();
    if (msg.senderId === me) return;

    const text = decodeText(msg.payload);
    if (!text || !text.trim()) return;

    const sender = msg.senderId;
    if (inFlight.has(sender)) return;
    inFlight.add(sender);

    console.log(`[recv] ${sender.slice(0, 8)}: ${text.slice(0, 80)}`);

    try {
      MeshWhisper.sendTyping(sender);
      await handleCustomerMessage(sender, text);
      MeshWhisper.stopTyping(sender);
    } catch (err) {
      MeshWhisper.stopTyping(sender);
      console.error(`[err] ${sender.slice(0, 8)} failed:`, err);
    } finally {
      inFlight.delete(sender);
    }
  },
});
