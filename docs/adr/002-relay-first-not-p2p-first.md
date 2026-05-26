# ADR-002 — Relay-based architecture, not P2P first

- **Status**: Accepted
- **Date**: 2026-05-24

## Context

The MeshWhisper protocol is transport-agnostic. The wire format does not care whether a packet travels over a WebSocket to a node, a WebRTC data channel between browsers, a Bluetooth LE link between phones, or a Wi-Fi multicast frame between laptops on the same LAN. The SDK's `Transport` abstraction in `src/transport/` reflects this: `WebSocketTransport`, `LocalTransport`, `PlatformP2PTransport`, and `NodeTransport` are sibling implementations that the `BearerNegotiator` chooses among.

For internet-WAN traffic today, the SDK uses the `NodeTransport` exclusively. Every packet between two clients that are not on the same LAN traverses a `meshwhisper-node` instance. The client-side mesh-relay code (`SocialGraphRouter`, `RelayLedger`, sybil checks in `maybeRelay`) is wired but explicitly gated: `src/sdk/index.ts:1959` returns early when the inbound bearer is `'internet'`, on the grounds that the node already handled forwarding server-side.

A pure peer-to-peer architecture — WebRTC for browser-to-browser, libp2p or QUIC for Node-to-Node, with STUN/TURN for NAT traversal — would remove the relay from the hot path entirely when both peers are online. This is a desirable property and the protocol supports it. The question is *when* to build it.

## Decision

Keep the relay-based architecture as the primary transport for internet-WAN traffic. Defer building WebRTC, libp2p, or any other direct peer-to-peer internet transport until either:

1. A concrete adoption blocker emerges that names "no P2P" as the cause, or
2. The federation roadmap reaches a state where node-to-node peering is shipped and direct client P2P becomes the obvious next layer.

Until then, the relay-based path is sufficient. The protocol and transport abstraction preserve the option; the SDK does not paint anyone into a corner.

## Alternatives considered

### 1. Build WebRTC for browser-to-browser P2P now

Two Prudence clients on the open internet would establish a data channel and exchange messages without the relay seeing them. Modest engineering scope (~1 month for a usable implementation, plus the perpetual NAT-traversal tax).

Rejected for now because:
- **No one is asking for it.** Current adopters (and the customer profiles we're targeting — customer-service deployments, AI agents, IoT) have no objection to traffic transiting a self-hosted relay. The privacy property they care about is "the relay cannot read content," not "the relay cannot see that we communicated."
- **NAT traversal is a real cost.** Building production-grade WebRTC requires running STUN, TURN, and ICE candidate exchange. The TURN server is itself a relay; for many client pairs it never improves over the existing relay-based topology.
- **Maintenance complexity.** WebRTC is famously fragile across browser versions, network conditions, and corporate proxies. Adding it before there's a forcing function multiplies the support surface for adopters.

### 2. Build full P2P with NAT traversal as the next protocol layer

WebRTC + libp2p + STUN + TURN + UPnP + IPv6 preference. Months of engineering, much of it on edge cases that only affect a fraction of the user base.

Rejected because the same engineering effort spent on the `meshwhisper init` CLI, federation protocol design, and additional reference examples will produce more new adopters than the P2P transport will produce delighted existing users.

### 3. Relay-only, drop the mesh aspiration

Abandon the "Relay promiscuously, connect selectively" framing entirely; position MeshWhisper as a self-hostable encrypted-messaging library that just happens to require a relay.

Rejected because it abandons the property that makes MeshWhisper architecturally distinct, and because the federation work outlined in [ADR-001](001-adoption-driven-mesh.md) and `docs/federation.md` is a real path to a real mesh — even if that mesh's nodes are servers rather than phones.

## Consequences

- **The relay is load-bearing.** Anything that makes self-hosting harder is amplified into a project-wide adoption tax. The CLI work, the Docker image, the documentation, the observability story — all of these matter more than they would for a P2P-first design.
- **WebRTC remains a "phase 2" item.** When it lands, it will be additive: the `Transport` abstraction already supports plugging in a new bearer without changing the protocol. The federation work in progress does not preclude it.
- **The latent client-side mesh code is not wasted.** It serves LAN-multicast and Bluetooth proximity today and will serve federated-node forwarding in the future. The same `SocialGraphRouter`, `RelayLedger`, and sybil-trust logic applies.
- **We can be honest with adopters about transport.** "Every packet transits a relay you (or your federation partner) operate" is a concrete and defensible property. "Sometimes a relay, sometimes P2P, depending on NAT topology and which browsers you're on" is much harder to explain. The current architecture is easier to reason about and easier to audit.
