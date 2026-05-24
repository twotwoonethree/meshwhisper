# supervised-chat

A reference for **compliance-readable customer support** on MeshWhisper. The classic enterprise messaging requirement — "supervisors must be able to audit conversations" — without breaking end-to-end encryption.

## The idea in one line

A supervised conversation is a **three-person MeshWhisper group**: customer + agent + supervisor. The supervisor is a silent member by convention. The protocol stays unchanged; the relay still sees only ciphertext; the supervisor reads because they are a cryptographic participant, not because there's a backdoor.

```
   customer  <-- E2E group sender-keys -->  agent
        \                                  /
         \-- E2E group sender-keys --> supervisor (silent)
```

## What's in this directory

| File | What it is |
|---|---|
| `src/shared.ts` | Common SDK init helper. Both actors run identically except for which callbacks they wire up. |
| `src/agent.ts` | The support agent. Auto-accepts group invites, replies with a canned acknowledgement on inbound group messages. Swap the canned reply for any logic (LLM, ticket creation, human queue handoff). |
| `src/supervisor.ts` | The compliance supervisor. Auto-accepts group invites, **never sends**, and appends every received message to a JSON-Lines audit log. |
| `.env.example` | Configuration: namespace, relay URL, usernames, data directories. |

## Quick start

```bash
cd examples/supervised-chat
cp .env.example .env
npm install

# Terminal 1
npm run agent

# Terminal 2
npm run supervisor
```

Both print their `@username` and peerId on boot.

Now, in **any MeshWhisper-based app on the same namespace** (Prudence works), simulate the customer side:

1. Add `@acme-support` as a contact.
2. Add `@acme-compliance` as a contact.
3. Create a new group, add **both** as members.
4. Send a message.

You'll see:
- **Agent terminal**: receives the message, replies with the canned ack.
- **Supervisor terminal**: receives the message, writes a JSON line to `data/supervisor/audit.jsonl`, never replies.

The customer's app shows three members in the group — the supervision is visible in the roster.

## How to wire this into your own portal

The customer side is just standard MeshWhisper group creation. In your portal's React (or any framework) code:

```ts
// At app start — look up the agent and supervisor identities once per session.
// Cache these; you don't need to resolve on every chat open.
const agentPeerId = await MeshWhisper.resolveUsername('@acme-support');
const supervisorPeerId = await MeshWhisper.resolveUsername('@acme-compliance');

// When the customer clicks "Contact Support":
const handle = MeshWhisper.createGroup({
  name: 'Acme Support',
  members: [agentPeerId, supervisorPeerId],
});

// The two bots receive group_invite control messages, auto-accept, and the
// conversation is ready. Send messages via handle.send() exactly like any
// other group.
```

That's it. About a dozen lines on the customer side. The cryptography, identity discovery, and audit logging are all handled by the SDK plus the two bots in this directory.

## Customer-facing transparency UI

Cryptographic transparency only matters if your UI surfaces it. The customer should be able to see that their conversation is supervised. A minimal pattern:

```tsx
// Pseudo-React. Adapt to your framework.
function ConversationHeader({ conversation }: { conversation: Conversation }) {
  const supervisors = conversation.members.filter((m) => m.role === 'supervisor');

  return (
    <header>
      <h2>{conversation.title}</h2>
      {supervisors.length > 0 && (
        <SupervisionBadge supervisors={supervisors} />
      )}
    </header>
  );
}

function SupervisionBadge({ supervisors }: { supervisors: Member[] }) {
  return (
    <button
      className="text-xs text-amber-400 flex items-center gap-1"
      onClick={() => openModal('SupervisionInfo', { supervisors })}
      title="This conversation is monitored for quality and compliance"
    >
      <ShieldIcon className="w-3.5 h-3.5" />
      Supervised by {supervisors.map((s) => `@${s.username}`).join(', ')}
    </button>
  );
}
```

The modal explains *who* can read, *why*, and links to your privacy policy. The customer can leave the group if they don't consent — same as any group.

How do you distinguish a "supervisor" member from a regular one? Conventions you can pick:

- **By username pattern**: usernames matching `*-compliance` or `*-audit` get the supervisor role. Easiest, no metadata needed.
- **By app-side mapping**: keep `supervisorPeerIds: Set<string>` in your tenant config. Member is a supervisor iff their peerId is in the set.
- **By a `__app_ctrl` announcement**: when the group is created, the creator sends an app-level control message naming who the supervisors are. Cryptographically signed by the creator's key. Works across organisations.

Pick whichever fits your tenancy model.

## What the audit log looks like

`data/supervisor/audit.jsonl` accumulates one JSON line per received message:

```json
{"ts":"2026-05-24T14:30:00.000Z","observedAt":"2026-05-24T14:30:00.103Z","groupId":"a1b2c3d4...","senderPeerId":"7e8f9a0b...","groupSenderId":"7e8f9a0b...","text":"Hi, I need help with my order"}
{"ts":"2026-05-24T14:30:02.000Z","observedAt":"2026-05-24T14:30:02.241Z","groupId":"a1b2c3d4...","senderPeerId":"4d5e6f70...","groupSenderId":"4d5e6f70...","text":"Thanks for reaching out — I'll take a look and get back to you."}
```

`ts` is the sender's claimed timestamp (from the message envelope); `observedAt` is when the supervisor processed it. The gap between the two is your delivery-latency metric and a guard against post-hoc clock manipulation.

This is the raw substrate for a supervisor portal — render it as a search index, an export for legal, an analytics dashboard, whatever you need. The SDK also persists every message to the supervisor's `messages/{groupId}` store, so `MeshWhisper.exportConversation(groupId, ...)` works on the supervisor's side too.

## Design decisions explicit

A few choices you might want to make differently — all of them are app-side, none of them require SDK changes.

### Who creates the group?

This demo lets the customer's app create the group. Alternatives:
- **Backend creates and invites everyone**, including the customer. Cleaner if you want to enforce "every customer chat MUST include the supervisor" — the customer's client never gets the choice.
- **Agent creates on first-contact**: customer DMs the agent, the agent's bot promotes the DM to a supervised group. More work, no real benefit unless you need the customer to be able to message the agent privately first.

### Soft silence vs hard silence

The supervisor in this demo is *softly* silent — they could technically send a message, the code just never does. Two reasons that's the right default:

1. Legitimate intervention: a supervisor might need to chime in ("Sarah, escalate this to legal please") and shouldn't be locked out.
2. Hard silence is misleading: nothing about the protocol prevents the supervisor from sending. If you want a UI affordance "can this member send?", it's an app-side flag, not a cryptographic guarantee.

If you really want hard silence (e.g. the supervisor is an automated process and you want to be sure no one can use its key to inject messages), just don't expose any send capability in their client. The protocol doesn't care.

### Supervisor off-boarding

When a supervisor leaves the company:

- **Remove them from active groups**: the group admin (agent or backend) kicks them. They stop receiving new messages immediately.
- **Their existing local data**: the SDK has no time-bound keys. Whatever messages they already had on their device, they still have. Real-world answer is the same as for any service: MDM remote wipe, plus access logging that proves whether they accessed anything post-termination.
- **For high-stakes deployments**: rotate group sender-keys on every supervisor change. The SDK supports group key rotation via the same admin path. Honest tradeoff: this re-encrypts the live key, not the history they already saw.

### Multi-tenant / per-team supervision

Different teams get different supervisor identities. `@bank-trading-compliance` vs `@bank-retail-compliance`. The customer's app picks the right one based on which department they're contacting. No SDK change needed — this is a config decision in your backend.

## Production considerations

Beyond what's in the demo, real deployments usually also want:

- **Run both bots under systemd / a container orchestrator** that restarts on crash.
- **Use a self-hosted relay**, not the Foundation one. See [`docs/self-hosting.md`](../../docs/self-hosting.md).
- **Encrypt the audit log at rest.** It's plaintext customer conversations on the supervisor's machine. Use OS-level disk encryption at minimum; for stricter compliance, write to an HSM-backed encrypted volume.
- **Tamper-evident audit log.** This demo writes JSON-Lines to a local file. A real deployment chains entries with a hash of the previous line (`prevHash`, `entryHash`) so a deleted or modified entry is detectable.
- **Auth + ACL on the supervisor portal**. The bot writes to a log; *who can read the log* is a separate access-control question your portal needs to answer.

## Limits this pattern doesn't address

Be honest about what it doesn't do:

- **It doesn't hide the supervisor from the customer.** That's a feature, not a bug — the alternative is a backdoor, which would break the relay's "can't read messages" claim.
- **It doesn't give "law enforcement read access" without notice.** If a court asks for chat history, the supervisor (a participating identity) can provide their copy. The relay still cannot — even under subpoena. This is generally a feature for the messaging service operator; it may not be enough for jurisdictions that require interception capabilities. Check with your legal team.
- **It doesn't address client-side compromise.** Malware on the customer's or agent's device can still leak the plaintext locally. Same as every E2EE messenger.

## Going further

- The full PWA reference: [`prudence/REFERENCE.md`](../../prudence/REFERENCE.md).
- AI agent pattern (single-peer instead of supervised group): [`examples/support-bot/`](../support-bot/).
- Identity derivation choices for the customer side: [`docs/identity-patterns.md`](../../docs/identity-patterns.md).
- The SDK API: [`docs/api.md`](../../docs/api.md).
