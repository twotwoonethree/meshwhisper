# Agent Portal — Customer Service on MeshWhisper

This document sketches how a multi-agent customer-service product could be built on top of the
MeshWhisper SDK and relay, what already exists, and what would need to be added. It is an
exploratory architecture note, not a committed roadmap item.

The premise: most of what makes a support tool (Intercom, Zendesk, Chatwoot) expensive or
opaque is _not_ the messaging — it's the agent console, dashboards, routing, integrations, and
the per-seat SaaS pricing. MeshWhisper provides the messaging layer cheaply (one Docker
container with SQLite, PWA client, no per-seat fees) and adds a property no incumbent can
credibly claim: **the messaging infrastructure literally cannot read the conversation**.

---

## Architecture

```
Customer (embed widget, PWA)  ←session→  Agent (Prudence-for-business)
       │                                      │
       │  encrypted blobs                     │  mirrors decrypted
       ▼                                      ▼
   relay (opaque)                       business backend
                                         (dashboard, KB, CRM)
                                              ▲
                                              │
                                         Supervisor reads

Side-channel HTTP service ("dispatcher"):
  - agents heartbeat availability + skills
  - customer pings → gets assigned agent's peerId
  - sees only metadata, never message content
```

Three principles:

1. **The relay stays opaque.** It only ever sees encrypted blobs and routing destination
   hashes. The relay does not know who is an agent, who is a customer, what conversations
   are open, or what was said.
2. **The agent device is the trust boundary.** Decrypted content lives there. From there it
   may be mirrored to a business backend (over a normal authenticated channel) for dashboards,
   search, KB, CRM, supervisor review. The privacy claim is "your conversation is private from
   our messaging vendor — only authorised agents at the company you chose to talk to can read
   it." Standard for regulated industries.
3. **The dispatcher is a separate small service.** It tracks which agent peerIds are online
   and routes new conversations. It never decrypts anything; it only sees metadata
   (`{kind: 'customer'|'guest', skills: [...], trustSignals: {...}}`).

---

## Identity model — two paths at widget bootstrap

Customer service has a fundamental split that personal messaging does not: some customers
are already authenticated to the business; others are anonymous visitors. The widget must
detect which up front and choose the identity derivation accordingly.

### Logged-in customer — deterministic identity

The site server mints a short-lived signed token. The SDK derives a deterministic identity
from it:

```
identityKey = HKDF(server_secret, customer_id)
```

Properties:

- Same customer = same peerId across devices and sessions, without ever prompting for a
  password.
- The agent's dashboard pre-loads account, plan, order history before the customer types.
- Trust signals ride alongside the conversation request to the dispatcher (paying customer,
  plan tier, has open ticket).
- If the customer signs out of the site, the identity stays in IDB but is no longer minted
  fresh; on re-sign-in the same identity is rederived.

### Anonymous visitor — ephemeral identity

The SDK generates a random identity, stored in IDB. No password, no server token.

Properties:

- Lower trust. Routed to AI bot first, or a queue with rate limits / captcha gates.
- Conversation is ephemeral by default — lives in the visitor's browser only until they
  identify themselves (sign in, submit email, register).
- If they identify later, the conversation can be re-bound or stored alongside the now-known
  customer record on the business backend.
- Spam/abuse defense lives in the dispatcher and the widget host page, not in the messaging
  layer.

### SDK change

`init()` today takes `{username, password}`. Extend to also accept:

- `{identityToken: string, tokenPublicKey: string}` — logged-in path. SDK verifies the token
  signature against the host page's known public key, unwraps the embedded identity bytes,
  uses them.
- `{kind: 'guest'}` — generates ephemeral identity if none in IDB, reuses if present.

Estimated SDK work: 1–2 days. Pure additive change to `init()`.

---

## Routing to an agent pool

There is no "support team" peerId. Each agent has their own peerId. The dispatcher routes
individual customers to individual agents.

### Dispatcher service

A new small Node service, deployed alongside the relay but architecturally distinct.

Endpoints:

| Verb | Path | Purpose |
|---|---|---|
| `POST` | `/agents/heartbeat` | Agent reports `{peerId, status: 'available'\|'busy'\|'offline', load, skills}` |
| `POST` | `/conversations/request` | Customer sends `{kind, trustSignals, skill?}`, gets back `{agentPeerId, agentEdKey}` |
| `GET`  | `/agents/status` | Admin dashboard view of agent availability |
| `POST` | `/conversations/handoff` | Agent A asks for a specialist, dispatcher returns Agent B |

The dispatcher does not see message content. It sees only:

- Which peerIds are agents (and which are online)
- That a customer asked for help (and what skill / kind)
- Which agent was assigned

Agents publish their prekey bundles to the existing relay directory. The dispatcher only
tracks _availability_ metadata on top of that. If the dispatcher goes down, the existing
agent–customer sessions keep working — the dispatcher is only on the path for _new_
conversations.

Estimated work: 3–5 days for a credible v1.

### Why this works under E2EE

The customer's conversation is established directly with the assigned agent's peerId via
the standard X3DH handshake. The dispatcher only tells the customer _which_ agent to
handshake with; it never sees the keys or the messages.

---

## Conversation transfer

Agent A wants to pass to specialist B.

Cleanest flow:

1. Agent A asks the dispatcher for a specialist; dispatcher returns Agent B's peerId.
2. Agent A sends customer a control message:
   `{type: 'agent_handoff', newAgentPeerId, newAgentEdKey, reason}`.
3. Customer's app silently establishes a fresh X3DH session with Agent B and continues there.
4. Agent A forwards transcript context to Agent B via the business backend (not via
   MeshWhisper — agents trust the backend, no need to round-trip ciphertext).
5. Customer's UI shows "Transferred to @AgentB."

New control message type. ~1 day SDK work + UX in the widget and agent console.

---

## Internal notes / tags / status

Agents need a per-conversation private channel that the customer cannot see — internal
notes, tags ("VIP", "billing dispute"), status ("snoozed until tomorrow"), supervisor
mentions.

Two implementation options:

**Option A — sender-key group keyed off the customer conversation.**
Reuse the existing group sender-key machinery. Group ID = `internal:${customerPeerId}`. All
agents who have touched this conversation are members. Customer is not. ~2 days.

**Option B — business backend only.**
Agents write notes to the business backend; backend serves them to other agents over a
normal authenticated API. Simpler, but loses the "everything supervisor sees was end-to-end
encrypted in transit" property. Probably fine for most products.

Pick A if the privacy story matters; B if shipping speed matters.

---

## Supervisor visibility

Supervisor reads from the business backend, not from MeshWhisper directly. The agent's app
mirrors decrypted message content + metadata to the backend at the moment of decryption.

This is what most companies actually want — full internal audit, search, QA review, training
data — and is consistent with the "agent device is the trust boundary" principle. No
protocol change needed.

---

## Real delivery + read receipts

Currently Prudence shows "delivered" as a hardcoded status on inbound messages. There is no
actual delivery ack from the recipient back to the sender.

For support, agents genuinely need to know whether the customer received and read the
response. Add a small ack control message echoed back automatically on receive (delivered)
and on render (read). The sender's UI flips the indicator on receipt.

~1 day SDK work. Useful well beyond customer service.

---

## What the agent portal app actually is

A separate PWA (`prudence-business` or similar — _not_ Prudence). Different UX:

- Multi-conversation tabbed inbox
- Customer profile sidebar pulled from business backend (account, plan, history, prior
  tickets)
- Internal notes column
- Canned responses / KB search
- Tag, snooze, close, transfer, escalate
- Supervisor view: read-only across all agents

This is a real frontend project, months of work to be production-quality. The MeshWhisper
SDK does the messaging; everything else is your build.

The customer-facing widget is also its own app — a small embeddable iframe with a
postMessage API for the parent page to inject customer attributes, open/close, route to a
specific queue. Different UX from Prudence, much simpler than the agent portal.

---

## Tier 1 — must have to ship a credible MVP

1. **Guest / delegated identity in the SDK.** Both anonymous and logged-in paths.
2. **Embed mode + iframe widget.** postMessage API, drop-onto-any-website friendly.
3. **Dispatcher service.** Agent presence + customer-to-agent routing. Doesn't touch the
   relay.
4. **Basic agent inbox PWA.** Assigned conversations, reply, mark closed. Skip handoff,
   internal notes, supervisor view, KB.

Two weeks for a demo: a single-agent indie SaaS replaces $74/mo Intercom with a $5/mo VPS,
and the customer's data is genuinely opaque to the messaging layer.

## Tier 2 — needed for a credible product

5. Conversation transfer protocol (`agent_handoff` control message).
6. Internal notes side-channel (sender-key group, customer not a member).
7. Real delivery + read receipts.
8. Customer-side rebinding when an anonymous visitor identifies themselves later.

## Tier 3 — nice to have

9. AI first-line bot as a regular peer; escalates via the handoff mechanism.
10. Canned responses, KB, tags, conversation status, customer profile sidebar — all pure
    app/backend work.
11. Native mobile for agents. PWA covers most of v1.

---

## Tradeoffs and honest limits

- **No server-side analytics on message content.** The relay is opaque and stays that way.
  Sentiment scoring, AI routing on raw content, ML training on transcripts — all of this
  has to happen client-side per-agent, or via the business backend after agents mirror
  decrypted content. This is the genuine cost of the architecture, and it's the same cost
  E2EE imposes anywhere.

- **Agent identity custody.** Each agent's peerId is held by their device. If an agent
  leaves the company, you revoke their access at the dispatcher (stop honouring their
  heartbeats, don't route new conversations to them). Existing sessions with customers
  survive in the customer's archive but the agent can no longer be reached via the
  dispatcher. There is no protocol-level "kick agent" — that's a dispatcher concern.

- **The dispatcher is a small SPOF.** If it goes down, no _new_ conversations route, but
  existing ones keep working. Standard service-availability problem; not a privacy
  problem.

- **Most of "being Intercom" isn't the messaging.** The substrate is the cheap part. The
  product (widget UX, agent console, routing rules, canned responses, KB, analytics, CRM
  integrations) is the real work. Anyone considering this should be honest about that
  scope.

- **The cost wedge depends on scale.** A small SaaS paying Intercom $3–5k/year for a few
  agents could plausibly run the whole stack on a $5/mo VPS. At a hundred agents and a
  million conversations, the maths changes — relay scaling, archive storage, dispatcher
  capacity all matter, and the operational simplicity advantage erodes.

---

## What this looks like as a product

**Prudence-for-business**: a separate PWA built on the same SDK, talking to the same relay,
but with the agent-inbox UX. Customer-facing **MeshWhisper Chat Widget**: an iframe
embeddable on any website, ~50 KB, no SaaS dependencies. **Dispatcher**: a 200-line Node
service deployed alongside the relay.

The pitch is roughly: "Self-hosted, end-to-end-encrypted customer support. Your customer's
data never touches our servers. Pay for a VPS, not per agent." The market that cares about
that is real but specific — regulated industries (legal, mental health, security
disclosure, financial advice), privacy-conscious indie SaaS, and businesses that have been
burned by SaaS support tools leaking customer data.

It is not a general-purpose Intercom replacement. It is a credible niche tool with a
genuine differentiator.
