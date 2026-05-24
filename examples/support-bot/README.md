# support-bot

A customer-service agent running as a MeshWhisper peer. The same E2EE protocol that protects human-to-human conversations protects the user ↔ agent exchange — the relay sees only ciphertext, and the agent's process is the only place plaintext exists outside the user's device.

About 150 lines of code. Two modes:

- **echo** — replies with `echo: <your text>`. No API key, no external dependency. Use this to verify the wiring before plugging in a real model.
- **llm** — sends the conversation history to Claude (`claude-haiku-4-5` by default) and replies with the response. Uses `@anthropic-ai/sdk` with prompt caching on the system prompt so repeat turns are cheap.

## Quick start

```bash
cd examples/support-bot
cp .env.example .env
# Edit .env — for echo mode you're done; for llm mode add your ANTHROPIC_API_KEY
npm install
npm run dev
```

On first boot the bot prints its peerId and `@username`. Open Prudence (or any MeshWhisper-based app on the same namespace), add the bot via `Add by username` using `@support-bot`, and send a message. The bot replies. Identity persists in `./bot-data/` so restarting the bot keeps the same peerId.

To switch to LLM mode:

```bash
# In .env
BOT_MODE=llm
ANTHROPIC_API_KEY=sk-ant-...
```

Restart. Same conversations, different brain.

## How it works — the SDK pattern

The bot is a vanilla MeshWhisper peer. There is no "bot SDK" or special role; an agent is just code that has its own identity and reads/writes through the standard `MeshWhisper` API.

The integration pattern in one diagram:

```
  user app                relay                  bot process
  --------                -----                  -----------
  send(payload) -----> [ciphertext] ---------> onMessage(msg)
                                                      |
                                                      v
                                              generateReply(text)
                                                      |
                                                      v
  onMessage(reply) <-- [ciphertext] <---- send(reply)
```

What the example demonstrates, by section of `src/index.ts`:

| Lines | Pattern |
|---|---|
| `MeshWhisper.init({ ... })` | The standard SDK init. Note `username` — this publishes the bot to the relay's directory so users can do `addContactByKey('@support-bot')`. |
| `NodeStorage(DATA_DIR)` | The Node.js storage backend. Identity, sessions, and message history all persist here. Lose this directory → lose the bot's identity. |
| `messageRetention: 'unbounded'` | Keep every customer message forever. Customer-service tickets need full history on demand; `'unbounded'` is the right default for this use case. (For chattier bots, set `{ kind: 'ageMs', max: 30 * 86400 * 1000 }`.) |
| `onMessage` callback | The receive path. Decode the payload, call `generateReply`, send the answer. |
| `MeshWhisper.getMessages(senderId, ...)` | For LLM mode: retrieves the conversation transcript so far so we can include the recent turns in the Claude prompt. The SDK already saved the incoming message before firing `onMessage`, so it appears in the result. |
| `MeshWhisper.sendTyping` / `stopTyping` | Live typing indicator. Lets the user see "support-bot is typing…" while the LLM is generating — UX that's hard to fake in a SaaS messaging product. |
| `MeshWhisper.send(senderId, payload)` | The reply. Same API the user used to message the bot. |
| `inFlight` Set | Per-sender concurrency guard. Prevents the bot from making two parallel LLM calls for the same user if they send rapid follow-ups. |
| Shutdown hooks | `mw.shutdown()` on SIGINT/SIGTERM persists the seen-id deduplication state and flushes any pending session writes. Skip this and you risk a duplicate-message replay on restart. |

## What's NOT in this example

Deliberately omitted to keep the reference small. If you want any of these, they're all single-digit-line additions to the code:

- **Authentication / allow-list.** This bot accepts every contact. For a paid product you'd gate on tenant ID or a verification flow.
- **Rate limiting.** No per-user message rate cap. If a user sends 100 messages in 10 seconds, the bot will queue 100 LLM calls.
- **Long-reply streaming.** The example does non-streaming Anthropic calls and sends the full reply as one MeshWhisper message. For replies that should appear word-by-word in the user's UI, switch to `anthropic.messages.stream` and send each chunk via `MeshWhisper.send`. Cost: ~30 extra lines.
- **Error recovery messaging.** A failed LLM call is logged and silently dropped. A polished bot would reply with `Sorry, something went wrong — try again?` in this case.
- **Group support.** This bot only handles DMs. Adding group support means handling `onGroupInvite` (auto-accept or gate), routing group messages via `MeshWhisper.sendToGroup`, and deciding whether the bot speaks every turn or only when @mentioned.
- **Media handling.** Inbound images / files arrive as media-pointer messages; the bot ignores them. To process attachments, call `MeshWhisper.downloadMediaMessage(msg)` to fetch and decrypt the bytes, then run them through a vision model or attachment store.

## Production considerations

A real deployment usually also wants:

- **Process supervision.** Run under systemd, pm2, or a container orchestrator that restarts the bot on crash. The SDK reconnects to the relay automatically, but Node itself won't restart on a thrown exception.
- **A dedicated relay.** The Foundation relay is fine for development; for production you want your own MeshWhisper Node container so you're not sharing infrastructure with strangers. See [`docs/self-hosting.md`](../../docs/self-hosting.md).
- **A separate identity per environment.** Don't share the same `BOT_DATA_DIR` between staging and production. Easy to mix up.
- **Periodic archive backup.** The bot's IDB-equivalent (NodeStorage's data directory) is its only copy of conversation history. Back it up the same way you'd back up any stateful service.

## Cost intuition for the LLM mode

With `claude-haiku-4-5` and the system prompt cached, a typical 100-token user message + 100-token reply is roughly **$0.0001 per turn** at current rates. A bot handling 10,000 turns/month is in the single-digit-dollar range. Switch to `claude-sonnet-4-6` for harder problems at ~5–6× the price.

The MeshWhisper relay itself is unmetered if you self-host. So the only marginal cost of running a customer-service bot on MeshWhisper is the LLM provider, not the messaging infrastructure.

## Going further

- **The SDK reference**: [`docs/api.md`](../../docs/api.md).
- **A full PWA built on the same SDK**: [`prudence/REFERENCE.md`](../../prudence/REFERENCE.md).
- **Identity-derivation patterns** (this bot uses random-and-persist; other patterns are available): [`docs/identity-patterns.md`](../../docs/identity-patterns.md).
