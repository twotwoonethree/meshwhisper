# ADR-001 — Adoption-driven mesh

- **Status**: Accepted
- **Date**: 2026-05-24

## Context

The original protocol design (`docs/whitepaper.md`) describes MeshWhisper as a peer-to-peer mesh where the substrate is the union of all participants' devices — phones, laptops, home servers — each relaying opaque packets for each other. Foundation-run relay nodes were framed as temporary bootstrap infrastructure, present only until organic device density rendered them unnecessary.

Several years of working through the architecture made it clear that the phone-and-laptop consumer mesh has structural problems we cannot engineer around:

- **CGNAT.** Most residential broadband sits behind carrier-grade NAT. Devices on those connections cannot be reached from the open internet without dedicated infrastructure (TURN, hole-punching) that itself looks a lot like a relay.
- **iOS / Android background networking.** Phones cannot be reliable relays. Both platforms aggressively suspend or kill background network activity. A mesh that depends on phones relaying for each other will see most "online" devices actually unreachable.
- **App Store policy risk.** Apple's review guidelines could rule that promiscuous packet forwarding violates App Store terms. We cannot engineer around this; the platform owner can shut the property off unilaterally.
- **No funding path.** Foundation-run nodes were always meant to be temporary, but a phone-to-phone mesh that bootstraps from foundation infrastructure has no obvious replacement for that infrastructure if it isn't already operating at scale.

At the same time, the *software* substrate of the original design — namespace-blind packet routing, end-to-end encryption that requires no operator trust, the proximity-table + reciprocity + sybil-resistance modules — works correctly. What's missing is the participant density that would make the mesh useful.

## Decision

The path to the mesh runs through SDK adoption. The unit of growth is not a phone but a self-hosted MeshWhisper Node deployed by an app developer who has integrated `@meshwhisper/sdk` into their product.

Concretely: every app that ships on MeshWhisper deploys its own `meshwhisper-node` container (≈ €4/month on commodity VPS). Apps stay namespace-isolated at the user and conversation layer. Nodes share opaque-packet-forwarding capacity at the transport layer once federation is wired (see [ADR-002](002-relay-first-not-p2p-first.md) and the federation design in `docs/federation.md`).

The mesh property is therefore **transport-layer**, not identity-layer. App A's users do not message App B's users; App A's *node* forwards App B's traffic when capacity allows, and vice versa.

## Alternatives considered

### 1. Phone-and-laptop consumer mesh first (original PRD vision)

Rejected for the structural reasons listed above. The original vision will likely never be achievable at scale on consumer mobile devices, even if every other engineering problem were solved.

### 2. Pure SaaS-replacement positioning (no mesh aspiration)

Drop the mesh language entirely; position MeshWhisper as a self-hostable encrypted messaging SDK that competes with Sendbird, Pubnub, Stream Chat. Rejected because it abandons the differentiating property that makes the project distinct from existing OSS messaging stacks (Matrix, XMPP). The mesh-via-federation path keeps the differentiation while staying achievable.

### 3. Build federation infrastructure before adoption

Implement node-to-node peering, federation discovery, inter-node reciprocity *before* a customer base exists. Rejected because federation without participants is theatre — and the same engineering effort spent on integrator-facing tooling (CLI, examples, docs) yields measurable adoption today.

## Consequences

- **SDK adoption is the primary metric.** Not user count, not message volume — number of apps that have integrated and deployed a node.
- **`meshwhisper init` CLI becomes top-priority work.** Every new adopter must be able to go from `npm install` to "running node + working SDK code" in under 30 minutes. Adoption friction here multiplies into the network-growth rate.
- **Federation protocol must be specified before it is implemented.** Adopters need to know what they are joining. `docs/federation.md` describes the design; implementation lands when there is a second relay operator who wants it.
- **The Foundation relay remains as bootstrap infrastructure** but stops being the only relay. As adopter nodes proliferate it becomes one node among many. Long-term, the Foundation may operate zero relays and the network is purely federated.
- **The primary public framing is "self-hosted infrastructure that federates,"** not "phone mesh." The PRD's "Relay promiscuously, connect selectively" still applies, but at the node layer, not the device layer.
- **The latent code in `src/routing/`, `src/reciprocity/`, `src/sybil/`** retains its design role — it is the substrate for federation between nodes, not (primarily) between client devices. Already partly wired client-side for LAN/Bluetooth mesh; node-side wiring is the federation work.
