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

// Find a flush point inside `buffer` — the index at which to split the
// streamed output into a separate MeshWhisper message. Strategy:
//   - below 60 chars: don't flush yet (avoid one-word bubbles)
//   - between 60 and 280: flush at the last sentence-ending punctuation
//   - 280+ with no sentence boundary: split at 280
// Returns -1 when no flush should happen yet.
function findFlushPoint(buffer: string, atStreamEnd: boolean): number {
  if (atStreamEnd) return buffer.length;
  if (buffer.length < 60) return -1;
  const SOFT_CAP = 280;

  // Last index where a sentence ends (punctuation + whitespace).
  const re = /[.!?]\s+/g;
  let lastEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buffer)) !== null) {
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd >= 60) return lastEnd;

  if (buffer.length >= SOFT_CAP) return SOFT_CAP;
  return -1;
}

// Send the reply, chunked. For echo mode this is a single message; for LLM
// mode the bot streams Claude's response and ships each natural-breakpoint
// chunk as its own MeshWhisper message. The receiver sees the answer
// appear in pieces, which (a) feels faster to a user waiting on a slow LLM
// and (b) demonstrates that the ratchet handles back-to-back sends to the
// same peer without the integrator having to think about it — the SDK's
// per-recipient session mutex serialises ratchet RMW automatically.
async function streamReply(senderId: string, text: string): Promise<void> {
  if (!text.trim()) return;

  if (MODE === 'echo') {
    await MeshWhisper.send(senderId, new TextEncoder().encode(`echo: ${text}`));
    return;
  }

  // LLM mode. The SDK already persisted the inbound message before firing
  // onMessage, so getMessages includes it as the most recent entry.
  const history = await MeshWhisper.getMessages(senderId, { limit: LLM_HISTORY_TURNS });
  const messages = history
    .map((m) => ({
      role: (m.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: new TextDecoder().decode(new Uint8Array(m.payload)),
    }))
    .filter((m) => m.content.trim().length > 0);

  // Cache the system prompt across calls — it's static, large-ish, and goes
  // out on every turn. Cache hits cut both latency and per-call cost.
  const stream = anthropic!.messages.stream({
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

  let buffer = '';
  const flush = async (atEnd: boolean): Promise<void> => {
    for (;;) {
      const idx = findFlushPoint(buffer, atEnd);
      if (idx < 0) return;
      const chunk = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx);
      if (!chunk) {
        if (atEnd && !buffer.trim()) return;
        continue;
      }
      await MeshWhisper.send(senderId, new TextEncoder().encode(chunk));
      if (atEnd && !buffer.trim()) return;
    }
  };

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      buffer += event.delta.text;
      await flush(false);
    }
  }
  await flush(true);
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
        // streamReply does the encryption-and-send itself, possibly as
        // multiple chunks for LLM streaming — see findFlushPoint for the
        // chunking strategy.
        await streamReply(sender, text);
        MeshWhisper.stopTyping(sender);
        console.log(`[out] ${sender.slice(0, 8)}: (reply complete)`);
      } catch (err) {
        MeshWhisper.stopTyping(sender);
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
