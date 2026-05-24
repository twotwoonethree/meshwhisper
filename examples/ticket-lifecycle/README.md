# ticket-lifecycle

A reference for the **end-to-end customer-support pattern** built from the two preceding examples: an LLM front-line that triages every inbound message, and an audited human handoff when triage decides to escalate.

This is the closest thing in the examples folder to a "real" customer-service product running on MeshWhisper. It composes the same SDK primitives that Prudence uses; the difference is the deployment shape.

## The lifecycle in one diagram

```
                       ┌──────────────────────────────────────────┐
                       │              Customer (Prudence)         │
                       └──────────────┬───────────────────────────┘
                                      │
                            ① add @acme-triage as contact
                            ② DM "I want to cancel my subscription"
                                      │
                                      ▼
              ┌─────────────────────────────────────────┐
              │ triage-bot  (Claude with tool-use)      │
              │  ─ replies directly when it can handle  │
              │  ─ calls escalate_to_human(reason) when │
              │    Claude decides escalation is needed  │
              └────────────────┬────────────────────────┘
                               │
                ③ tool-use → escalate()
                               │
                               ▼
              creates supervised group { customer, human-agent, supervisor }
                               │
       ┌───────────────────────┼───────────────────────┐
       ▼                       ▼                       ▼
  ┌──────────────┐    ┌──────────────┐         ┌──────────────┐
  │  customer    │    │ human-agent  │         │  supervisor  │
  │ (Prudence,   │    │ (real agent  │         │  (silent     │
  │  group view) │    │  portal or   │         │   audit log) │
  │              │    │  this demo)  │         │              │
  └──────────────┘    └──────────────┘         └──────────────┘

        every message in the group is encrypted to all three
        the supervisor's peerId is visible in the group roster
                  (cryptographic transparency)
```

## What's in each file

| File | What it is |
|---|---|
| `src/shared.ts` | Common `startBot` helper — NodeStorage, identity persistence, `messageRetention: 'unbounded'`, signal-handler shutdown. |
| `src/triage-bot.ts` | The interesting one. Calls Claude with a single `escalate_to_human` tool; when Claude invokes the tool, this bot does the group-handoff. |
| `src/human-agent.ts` | Auto-accepts group invites, sends a greeting on the triage-handoff message, acknowledges follow-ups. Swap for your CRM / portal integration. |
| `src/supervisor.ts` | Silent group member, appends every group message to a JSON-Lines audit log. Same code as `examples/supervised-chat/src/supervisor.ts` — re-shipped here so the example is self-contained. |

## Quick start

```bash
cd examples/ticket-lifecycle
cp .env.example .env
# Edit .env — required: ANTHROPIC_API_KEY for the triage bot
npm install

# Three terminals
npm run supervisor          # T1
npm run agent               # T2
npm run triage              # T3 (needs the API key)
```

Each terminal prints its `@username` and peerId on boot. The triage bot may briefly fail to escalate on the very first run while the directory entries for `@acme-human-agent` and `@acme-compliance` propagate — wait ~10 seconds.

In Prudence (or any MeshWhisper app on the same namespace):

1. Add `@acme-triage` as a contact.
2. Send "I want to cancel my subscription" (or any message that should trigger human escalation).
3. The triage bot replies with `Connecting you to a human agent now…` and creates a group.
4. Accept the incoming group invite.
5. You're now in `Acme Support (escalated)` — chat with the human agent. The supervisor is silent in the roster.

Try a non-escalation message too ("What are your hours?"). Triage should reply directly without creating a group.

## Why tool-use for escalation

The triage bot doesn't decide whether to escalate via keyword matching. It exposes a single tool to Claude:

```ts
tools: [{
  name: 'escalate_to_human',
  description: 'Escalate the conversation to a human agent…',
  input_schema: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: '…' },
    },
    required: ['reason'],
  },
}],
```

Claude decides per turn whether to call it, based on the conversation context and the system prompt's "use this when…" guidance. Pros over keyword heuristics:

- Picks up implicit cues (frustration, language signaling a real human need).
- Avoids false escalations on cooperative-but-tricky questions.
- The bot author edits the system prompt to change policy — no regex tuning.

When Claude calls the tool, the response has both a `tool_use` block and (optionally) a `text` block. The bot ignores the text and runs `escalate()`. When Claude doesn't call the tool, the bot replies with the text block normally.

## What `escalate()` does

Four steps, in order:

1. **Tell the customer.** Send a short message in the DM: `Connecting you to a human agent now. Reason: …`. Customer sees this before the group appears, so the handoff is obvious.
2. **Create the supervised group.** `MeshWhisper.createGroup({ name, members: [customer, agent, supervisor] })`. Customer's app gets a `group_invite` control message.
3. **Drop the handoff context into the group.** First message is a `[Triage handoff]` summary including the reason and the recent 10 conversation turns. The human agent isn't starting from zero.
4. **Mark the customer as escalated.** The triage bot stops replying to their DM. The conversation continues in the group, where the supervisor is auditing.

The triage bot stays in the DM thread as a contact — the customer can come back later with a new question and triage will pick up again (as a fresh DM, not the escalated group).

## Compatible with the audit dashboard

The audit log this example writes (`./data/supervisor/audit.jsonl`) is the same JSON-Lines shape as `examples/supervised-chat/`'s. So the dashboard from that example works against this one:

```bash
cd ../supervised-chat/dashboard
npm install
AUDIT_LOG_PATH=$(realpath ../../ticket-lifecycle/data/supervisor/audit.jsonl) \
  npm run dev
# open http://localhost:5174
```

Every customer ticket that gets escalated produces a stream of entries in the audit log; the dashboard groups them per ticket, searchable by content.

## What's NOT in this demo

Intentionally cut for clarity. Each is a small addition:

- **Multi-tenant routing**: this demo has one agent identity. A real product picks the agent based on tenant, skill, language, on-call rotation. Adding that means a routing decision in `triage-bot.ts:escalate()` before `resolveUsername`.
- **Persistent escalation state**: `escalated` is an in-memory Set, lost on triage-bot restart. Persist to `NodeStorage` keyed by peerId.
- **Agent availability checking**: triage escalates unconditionally if the agent username resolves. A real flow would also check that an agent is online (via `MeshWhisper.getPresence`), with a queue + estimated-wait fallback.
- **Streaming triage replies**: this demo uses non-streaming `anthropic.messages.create`. For long replies, copy the streaming + chunking pattern from `examples/support-bot/src/index.ts` (`findFlushPoint` + `streamReply`).
- **Agent UI**: `human-agent.ts` sends canned replies. A real product has a portal where actual humans type, with this bot logic embedded as the "incoming message → notify agent" wiring. The bot persistence layer is exactly what that portal would read from.
- **Auto-close / ticket states**: this demo doesn't transition tickets (`open → in-progress → resolved → closed`). The audit log has timestamps; a small `ticket_state` event in the group, persisted in the supervisor's store, gets you there in ~30 lines.

## Why this composition matters for adoption

The pattern this example demonstrates — bot triage → audited human handoff → compliance retention — is the **dominant shape of business messaging**. Intercom, Zendesk, Crisp, and every internal customer-service stack you've seen runs some version of it.

What's different here:

- **Same protocol everywhere.** Triage, agent, supervisor, customer — all four are MeshWhisper peers. No special "agent SDK" vs "customer SDK." The escalation handoff is just `createGroup`.
- **Cryptographic compliance.** The supervisor reads via group membership, not because the platform has plaintext. The relay can be self-hosted, multi-tenant, or even foundation-run, and *cannot* read the conversation. Adversarial subpoena returns ciphertext.
- **Open extension points.** Want to add a second-line agent? Add their peerId to the group. Want a hand-off to a different supervisor for VIP tickets? Resolve a different username. The pattern composes; you're not buying into a vendor's escalation model.

If you can deploy these three bots plus your own portal UI, you have a credible answer to "can MeshWhisper replace our enterprise messaging vendor" — at least for the workflows where compliance + privacy is the deciding factor.

## Going further

- **Other examples**: [`support-bot`](../support-bot/) (pure LLM bot, single peer), [`supervised-chat`](../supervised-chat/) (manual handoff with audit log).
- **The PWA reference**: [`prudence/`](../../prudence/).
- **API reference**: [`docs/api.md`](../../docs/api.md).
- **Identity patterns** for the customer side: [`docs/identity-patterns.md`](../../docs/identity-patterns.md).
