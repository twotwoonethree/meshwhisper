// =============================================================================
// MeshWhisper support-bot — reference example
//
// An AI customer-service agent that runs as a MeshWhisper peer. Users add the
// bot in their MeshWhisper app exactly like any other contact; messages flow
// end-to-end encrypted; the bot replies.
//
// Two modes selected by the BOT_MODE env var:
//   echo  — replies with the same text (no API key needed)
//   llm   — sends the conversation to Claude and replies with the response
//
// The SDK shape demonstrated here is the same shape any agent author would
// use: identity-as-a-peer, NodeStorage backend, onMessage callback, send()
// for replies, getMessages() to recover per-user context.
// =============================================================================

import 'dotenv/config';
import { MeshWhisper } from '@meshwhisper/sdk';
import { NodeStorage } from '@meshwhisper/sdk/persistence/node';
import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'node:fs';

const NAMESPACE = process.env.BOT_NAMESPACE ?? 'org.example.support-bot';
const NODE = process.env.MESHWHISPER_NODE ?? 'wss://relay.meshwhisper.org';
const DATA_DIR = process.env.BOT_DATA_DIR ?? './bot-data';
const USERNAME = process.env.BOT_USERNAME ?? 'support-bot';
const MODE = (process.env.BOT_MODE ?? 'echo') as 'echo' | 'llm';

// System prompt for LLM mode. Tuned for a generic customer-service voice; for
// a real bot you'd describe the product, escalation policy, refund rules, etc.
const SYSTEM_PROMPT = `You are a friendly customer-support assistant.
Be concise — most replies should be 1-2 sentences. Ask clarifying questions
when the user's request is ambiguous rather than guessing. If a question
needs a human, say so plainly. Never invent product details you don't know.`;

// How many prior turns of context to include when calling the LLM. The SDK
// stores all messages locally; for a long-running conversation we still cap
// the prompt size to keep latency and cost predictable.
const LLM_HISTORY_TURNS = 20;

// ----- LLM client -----------------------------------------------------------

let anthropic: Anthropic | null = null;
if (MODE === 'llm') {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('BOT_MODE=llm requires ANTHROPIC_API_KEY in env.');
    process.exit(1);
  }
  anthropic = new Anthropic({ apiKey });
}

// Generate a reply for a single inbound user message. Returns the text to
// send back, or null to stay silent (e.g. when the message is just a control
// payload we don't care about).
async function generateReply(senderId: string, text: string): Promise<string | null> {
  if (!text.trim()) return null;

  if (MODE === 'echo') {
    return `echo: ${text}`;
  }

  // LLM mode. The SDK already persisted this incoming message before firing
  // onMessage, so getMessages includes it as the most recent entry.
  const history = await MeshWhisper.getMessages(senderId, { limit: LLM_HISTORY_TURNS });
  const messages = history
    .map((m) => ({
      role: (m.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: new TextDecoder().decode(new Uint8Array(m.payload)),
    }))
    .filter((m) => m.content.trim().length > 0);

  // Cache the system prompt across calls — it's static, large-ish, and gets
  // sent on every turn. Cache hits cut both latency and per-call cost.
  const response = await anthropic!.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 1024,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages,
  });

  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim() || null;
}

// ----- Main ----------------------------------------------------------------

async function main(): Promise<void> {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const storage = new NodeStorage(DATA_DIR);

  // Concurrency guard: if the bot is mid-reply to one user and another message
  // from the same user arrives, we still want them processed in order. The
  // SDK's per-recipient session mutex already handles ratchet correctness on
  // the send side; this in-flight tracking is just to avoid wasting LLM calls
  // on stale prompts.
  const inFlight = new Set<string>();

  const mw = await MeshWhisper.init({
    namespace: NAMESPACE,
    node: NODE,
    username: USERNAME,
    storage,

    // Keep all message history forever — customer-service tickets need the
    // full transcript on demand. For a chatty bot you might prefer an
    // ageMs cap (e.g. 30 days) to bound disk growth.
    messageRetention: 'unbounded',

    onConnectionStatus: (status) => {
      console.log(`[net] ${status}`);
    },

    onMessage: async (msg) => {
      let text: string;
      try {
        text = new TextDecoder().decode(new Uint8Array(msg.payload));
      } catch {
        return;
      }
      // Ignore the app-level control envelopes Prudence and similar apps
      // sometimes send (e.g. __prudence_ctrl contact-request announcements).
      // A real bot decides which app prefixes it cares about.
      if (text.startsWith('{"__') && text.includes('_ctrl')) return;

      const sender = msg.senderId;
      console.log(`[in ] ${sender.slice(0, 8)}: ${text.slice(0, 80)}`);

      if (inFlight.has(sender)) return;
      inFlight.add(sender);

      try {
        MeshWhisper.sendTyping(sender);
        const reply = await generateReply(sender, text);
        MeshWhisper.stopTyping(sender);
        if (reply) {
          await MeshWhisper.send(sender, new TextEncoder().encode(reply));
          console.log(`[out] ${sender.slice(0, 8)}: ${reply.slice(0, 80)}`);
        }
      } catch (err) {
        console.error(`[err] reply to ${sender.slice(0, 8)} failed:`, err);
      } finally {
        inFlight.delete(sender);
      }
    },

    // A public bot accepts every inbound contact. Real deployments often
    // gate on tenant ID, an allow-list, or a payment check here.
    onContactRequest: () => {
      // The SDK has already created the session by the time this fires.
      // Returning is enough; we just want to log it.
    },
  });

  // Print the peerId so first-time operators can copy it into their app's
  // "Add contact" UI. The username works too, once the directory entry has
  // propagated (a couple of seconds after first boot).
  console.log('--');
  console.log('Bot online.');
  console.log(`  mode:        ${MODE}`);
  console.log(`  namespace:   ${NAMESPACE}`);
  console.log(`  username:    @${USERNAME}`);
  console.log(`  peerId:      ${mw.getLocalPeerId()}`);
  console.log(`  data dir:    ${DATA_DIR}`);
  console.log('Users can add this bot by username or peerId.');

  // Graceful shutdown so sessions and seen-id state get persisted.
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[bye] ${signal}`);
    await mw.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
