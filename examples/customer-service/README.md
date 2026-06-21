# customer-service

A reference customer-support stack on MeshWhisper. A guest customer reaches a
dispatcher, which routes them to an **available** human agent and opens a
**supervised** conversation — and the agent can see when the customer has
**read** their reply. Everything is end-to-end encrypted; the relay (which you
can self-host for a few dollars) cannot read a word.

It's a runnable version of `tests/customer-service.test.ts`, wired to the SDK
primitives customer service needs.

## The flow

```
            guest customer                          (no username — a generated
                  │  "my order never arrived"        guest identity, the way a
                  ▼                                   web visitor reaches you)
            ┌─────────────┐   getPresence()   ┌──────────────┐
            │  dispatcher  │ ────────────────▶ │  agent pool  │  agents heartbeat
            └─────────────┘  picks an online   └──────────────┘  availability via
                  │           agent                              announcePresence()
                  ▼ createGroup([customer, agent, supervisor])
            ┌──────────────────────────────────────────────┐
            │   Acme Support  (supervised group)            │
            │   customer ⇄ agent     supervisor (audits)    │
            │   agent sees ✓✓ when the customer reads        │
            └──────────────────────────────────────────────┘
```

## What it teaches

Three things, all leaning on primitives the SDK gained for this use case:

1. **Guest identity.** The customer (`customer.ts`) inits with *no* username — a
   generated identity. No sign-up, no account; it reaches support purely by the
   dispatcher's handle. This is the anonymous-visitor case.
2. **Presence-based routing, with a queue.** Agents call
   `announcePresence([dispatcher])` on a heartbeat; the dispatcher polls
   `getPresence(agentId)` and routes only to an agent that's actually online.
   Kill an agent and the dispatcher stops routing to it — that's availability,
   not a static list. When *no* agent is online the customer is **queued** (FIFO,
   told their position) and a drain loop connects them as agents come back —
   first-come, first-served.
3. **Group read receipts.** The escalated conversation is a *group*, so receipts
   are per-member: the agent's `onGroupReceipt` fires `✓✓` when the customer
   reads a reply, and both sides `markGroupRead()` what they've seen.

Supervisor oversight is by **group membership** — the supervisor is an encrypted
recipient, visible in the roster, not a hidden tap. The relay returns ciphertext
under subpoena.

### How it differs from its siblings

- `examples/ticket-lifecycle` — owns **LLM triage**: a bot decides *whether* to
  escalate. Compose it in front of this dispatcher for triage-then-route.
- `examples/supervised-chat` — owns the **audit dashboard**. This example's
  supervisor writes the same `audit.jsonl`, so that dashboard works here too.

This example owns **routing + receipts**.

## Files

| File | Role |
|---|---|
| `src/shared.ts` | `startActor()` init helper (guest or username) + `decodeText` |
| `src/dispatcher.ts` | front door; presence-based routing into a supervised group |
| `src/agent.ts` | human agent; presence heartbeat + read-receipt logging |
| `src/supervisor.ts` | silent group member; JSON-Lines audit log |
| `src/customer.ts` | the guest; interactive prompt |

## Quick start

```bash
npm install

# Four terminals. Start the staff first, then the customer.
npm run supervisor
npm run agent          # AGENT_USERNAME=acme-agent-2 npm run agent  for a second
npm run dispatcher
npm run customer -- "my order 1234 never arrived"
```

Defaults connect to the public relay (`wss://relay.meshwhisper.org`). To run
fully locally, start a node (`docker run -p 8080:8080 …` or the repo's
`node/`) and set `MESHWHISPER_NODE=ws://127.0.0.1:8080` for every process. See
`.env.example` for all settings.

Watch for: the dispatcher's `[route] … → acme-agent-1`, the agent's
`✓✓ read by …` once the customer's client marks the reply read, and the
supervisor's `audit.jsonl` filling up.

## What's NOT in this demo

Each is a small, well-bounded addition — deliberately cut so the pattern stays legible:

- **Capacity / concurrency.** The queue holds customers only while *no* agent is
  online; an online agent is treated as able to take work, so the backlog flushes
  to the first one back. Per-agent capacity ("one live chat at a time") needs
  ticket states (below) to know when an agent frees up.
- **Skill / language / tenant routing.** `pickAvailableAgent()` takes the first
  online agent; a real dispatcher scores on skill, language, load, on-call.
- **Persistent escalation state.** `placed` is an in-memory Set; persist to
  `NodeStorage` so a dispatcher restart doesn't re-route an in-progress chat.
- **Ticket states / transfer.** No `open → resolved → closed`, no agent→agent
  handoff. Both are small control-message additions.
- **A real agent UI.** `agent.ts` sends canned replies; a production agent reads
  from this same message flow into a portal where a human types.

## Going further

For triage before routing, put `ticket-lifecycle`'s tool-use bot in front of the
dispatcher. For the supervisor dashboard, point `supervised-chat/dashboard` at
this example's `audit.jsonl`. The messaging is all MeshWhisper owns — the
product (CRM, routing intelligence, UI) is your build.
