# Direction

A snapshot of where MeshWhisper is today and where it's going. Last updated: 2026-06-13.

This is not a roadmap with dates and it is not a manifesto. It is a record of the strategic decisions the project is operating under, with pointers to the artifacts that make those decisions concrete.

## What MeshWhisper is today

A self-hostable, end-to-end encrypted messaging SDK and relay. Concretely:

- **An SDK** (`@meshwhisper/sdk`) — TypeScript, runs in browsers, Node.js, and React Native. Encrypts messages on-device with X3DH + Double Ratchet + PQXDH (ML-KEM-768); the relay never holds a decryption key.
- **A relay node** (`meshwhisper-node`) — one Docker container that does packet relay, store-and-forward, push-notification forwarding, encrypted media storage, encrypted archive storage, and a username directory. Self-hosted on ~€4/month of VPS or co-located with whatever you already run. The Foundation operates one at `relay.meshwhisper.org` for development and small-scale production use.
- **Reference codebases** — [Prudence](../prudence/REFERENCE.md) (full PWA, Model-1 password-derived identity), [support-bot](../examples/support-bot/) (LLM agent), [supervised-chat](../examples/supervised-chat/) (compliance pattern), [ticket-lifecycle](../examples/ticket-lifecycle/) (full customer-service pattern with LLM triage and human handoff), [linked-devices](../examples/linked-devices/) (Model-3 multi-device pairing via QR / paste), [local-first](../examples/local-first/) (on-site human + machine-to-machine comms that survive losing the relay).
- **Documentation** — [API reference](api.md), [Identity patterns](identity-patterns.md), [Identifier patterns](identifier-patterns.md), [Multi-device](multi-device.md), [Federation](federation.md), [P2P transport](p2p-transport.md), [Local networks](local-networks.md), [Self-hosting](self-hosting.md), [Architecture decisions](adr/), [Codebase overview](codebase-overview.md), and the [Whitepaper](whitepaper.md).

What works today, in production, on the Foundation relay: encrypted direct messages and group messages, X3DH-with-PQXDH session establishment, multi-device archive sync, conversation history recovery from a peer, encrypted media, Web Push notifications, presence, typing indicators, read receipts, configurable message retention, per-namespace username-ownership policy (`signed-transfer` default with signed username handover, `last-writer-wins` opt-in), Model-3 linked-devices multi-device (account/device data model, signed `device_added`/`device_revoked` announcements, `sendMessage` fan-out, QR pairing), messenger-grade conversation features (reactions, quoted replies, forwarding, disappearing messages, group rename), and relay-to-relay federation with open admission — the Foundation relay accepts peers at `wss://relay.meshwhisper.org` (bootstrap pubkey published in [self-hosting.md](self-hosting.md)).

The relay itself is production-hardened: per-IP rate limiting on every endpoint, a Prometheus `/metrics` endpoint, hot database backups, a published [security policy](../SECURITY.md), and per-peer rate limiting plus a reactive blocklist on the federation plane.

## What MeshWhisper is not (yet)

- **Not a peer-to-peer mesh of phones.** The protocol allows it; the engineering doesn't fight it; but consumer mobile devices have structural limits (CGNAT, OS background restrictions, app-store policy risk) that make a phone-relay-for-phones substrate unlikely to materialise at scale. The mesh we are building is between **nodes**, not phones. See [ADR-001](adr/001-adoption-driven-mesh.md) for the full reasoning. The first device-to-device tier *has* shipped, though: the LAN bearer delivers messages peer-to-peer on a shared subnet, surviving relay outages entirely ([p2p-transport.md](p2p-transport.md), [local-networks.md](local-networks.md)) — opportunistic upgrade, not a substrate claim.
- **Not a SaaS.** The Foundation does not operate a hosted service for end users. Apps that integrate MeshWhisper deploy their own node. The Foundation relay exists for development and as bootstrap infrastructure.
- **Not a Signal or WhatsApp.** There is no MeshWhisper consumer app sold to end users. Prudence is a reference application that demonstrates how to build one; if you want a chat product, you build it on the SDK.
- **Not yet a federation *network*.** The federation protocol is specified ([federation.md](federation.md)), implemented (`node/src/federation.ts`, two-relay integration tested), and live: the Foundation relay runs in open mode, so joining the mesh is `FEDERATION_MODE=open` plus one bootstrap entry — no bilateral agreement required. What doesn't exist yet is the *network*: a second independent operator. The mechanism is ready and switched on; the mesh materialises with adoption.
- **Not yet a complete multi-device experience.** The linked-devices protocol (Model 3 in [multi-device.md](multi-device.md)) has shipped end-to-end in v1, but persistent LWW timestamps for device announcements, per-device signing certificates so secondaries can broadcast independently, and self-fan-out (a message I send from device A also showing up on my device B) are deferred. The current shape is fully usable for adopters that want to ship "scan a QR to link your laptop"; the deferred work tightens the edges.

## Where it's going

The strategic premise: **the mesh comes through adoption**. Every new app developer who integrates the SDK deploys a node. The accumulation of those nodes — each independently operated, namespace-isolated at the application layer, willing to forward opaque packets for each other at the transport layer — is the substrate for the federated mesh described in the original protocol design. See [ADR-001](adr/001-adoption-driven-mesh.md).

This determines what we work on, in this order:

### 1. Make adoption cheap

The single biggest lever on whether the mesh materialises is the friction of bringing a new node online. Concretely:

- ~~A `meshwhisper init` CLI that takes a developer from `npm install` to "I have a running node and an SDK skeleton" in under 30 minutes~~ — shipped: `npx @meshwhisper/cli init` scaffolds the node deployment (compose + standalone Dockerfiles + VAPID keys + federation bootstrap) and a working SDK skeleton; `doctor` and `vapid` round it out
- A self-hosting story (Docker image, environment variables, observability, TLS, push setup) that a competent backend developer can run without a DevOps team
- A library of reference codebases (a few exist; more shapes worth covering)
- Documentation that explains what's in the box and what isn't, with no surprises

### 2. Federation: shipped, switched on, waiting for its second operator

The federation protocol — how two `meshwhisper-node` instances peer with each other for transport-layer packet forwarding — is the difference between "self-hostable messaging library" and "the mesh we said this would be." It is now specified ([federation.md](federation.md)), implemented (`node/src/federation.ts`), integration-tested across two relays, and running on the Foundation relay.

One design decision is worth recording here because it followed directly from the strategic premise. The v1 draft required bilateral allow-listing: both operators exchange pubkeys before a connection establishes. That ceremony scales O(n²) and makes the mesh a product of negotiation rather than a side effect of adoption — the exact failure mode the whitepaper's "relay promiscuously" principle warns against. v1.1 added `FEDERATION_MODE=open`: any node that completes the cryptographic handshake is admitted, with per-peer rate limiting, hop caps, packet deduplication, and a reactive blocklist as the abuse boundary. Open is the documented recommended posture; allowlist remains for operators who want explicit control.

The next milestone is not code. It is a second independent operator running a node in open mode. Everything from here is adoption work.

### 3. Treat protocol-level limitations honestly

A handful of known protocol limitations exist today and would warrant a v2 wire format eventually. They are not deal-breakers and not urgent, but they are real. The most notable:

- The packet `flags` byte is plaintext at the wire (at offset 1). Inside the TLS tunnel between client and relay, the relay operator can distinguish chaff from real packets. That partially undermines chaff's cover-traffic property against a compromised or compelled relay. Documented as a known limitation pending a v2 protocol revision that would move the flag into the encrypted payload.

These get tracked as ADRs ([ADR-005 on protocol limitations](adr/005-known-protocol-limitations.md) when written) and surface in the API documentation where they bite.

### 4. Resist the urge to ship the wrong thing

The temptation, every time the network feels small, is to build infrastructure that anticipates an audience that doesn't yet exist. Decentralised discovery protocols, marketplace-based relay incentives, application-layer governance models — all interesting; all premature. We will build them when adoption pressure produces a concrete demand for them, not before.

## What we are not building (and why)

A short list, intended to set expectations rather than close doors:

- **A consumer-facing MeshWhisper app.** Prudence is a reference, not a product. If a consumer chat product gets built, it will be by an adopter, not by the Foundation.
- **Real-time voice or video calls** as a first-party feature. The protocol could carry the signalling; the media plane is enough additional engineering that it makes sense as an extension, not a core deliverable.
- **A native iOS / Android SDK** (Swift, Kotlin). The React Native binding exists; full native ports would be a serious investment that we haven't seen a forcing function for.
- **A managed cloud service** for adopters who don't want to self-host. The whole project's positioning rests on adopters running their own infrastructure; offering a managed alternative undermines the substrate the mesh depends on. (A regional Foundation-operated relay for development purposes is not the same thing.)
- **Federation discovery / "find any relay in the mesh" mechanisms** before there are enough operators to discover. Peering itself is live; gossip-based peer discovery becomes worth designing when the bootstrap-list approach actually strains.

## Governance, contribution, and the open-source posture

MeshWhisper is open source under the MIT license. The project is currently maintained as a single-maintainer effort; contributions are welcome, and decisions about what to merge ultimately route through that maintainer.

As the contributor base grows, the governance model will likely formalise — but we will not pretend to be governed by a committee we don't have. Honest single-maintainer governance is better than performative committee governance.

If you are considering contributing, please:

- Open an issue first for anything beyond a bug fix or a typo, so we can discuss design before code review
- Read the closest ADR or example to understand the conventions
- Submit small, focused PRs over large refactors
- Expect that protocol-touching changes will go through a longer review cycle than application-layer changes

If you are considering adopting MeshWhisper in production, please open an issue tagged `adoption` describing your use case. We track these because they shape priorities (and because the project's strategic premise is that adoption is the goal). No commitment required and no sales call follows.

## How this document changes

Updated when a strategic decision changes the picture meaningfully. Small adjustments (a new example, a feature shipped, a doc moved) do not require a `direction.md` update. The ADRs in `docs/adr/` are the authoritative record of decisions; this document is the synthesis.

If you read this six months from now and the world has moved on, treat it as a point-in-time snapshot and check the ADR directory for what's changed.
