# ADR-004 — Opportunistic transport upgrade, not P2P-or-relay

- **Status**: Accepted
- **Date**: 2026-06-12
- **Relates to**: [ADR-001](001-adoption-driven-mesh.md), [ADR-002](002-relay-first-not-p2p-first.md); detailed in [docs/p2p-transport.md](../p2p-transport.md)

## Context

ADR-002 deferred direct peer-to-peer internet transport until "a concrete adoption blocker emerges" or "federation is shipped and direct client P2P becomes the obvious next layer." Federation shipped 2026-06-10, satisfying the second trigger — so the question "what would the P2P layer actually be?" needed an answer, even though no adopter is yet demanding the implementation.

Reviewing the codebase for that answer surfaced that more exists than ADR-002 implied: the bearer abstraction, `BearerNegotiator`, a working LAN transport (Node.js, UDP discovery + TCP), and the `PlatformP2PBridge` native interface are all implemented. What's missing is WebRTC, any native bridge implementation, and — most importantly — a stated model for how direct paths coexist with the relay.

Two design pressures shaped the decision:

1. **Reliability must not regress.** The relay path works everywhere; every direct transport works only somewhere (AP isolation kills LAN discovery, iOS kills background BLE, NATs kill ICE). Any model where the app must care which transport carried a message re-imports all of that platform pain into every adopter's code.
2. **Privacy must not silently regress.** Direct connections reveal things the relay hides — most notably your IP to your peer on internet paths. Proximity connections reveal essentially nothing new (the peer is physically present). These cases must not be lumped together.

## Decision

1. **Direct transports are an opportunistic upgrade with relay-equivalent semantics.** The relay path stays permanently eligible; direct paths short-circuit it when live and fail silently when not. Receivers deduplicate, so v1 senders simply dual-send. No new required API, no new failure modes visible to apps.

2. **Privacy tiering is fixed policy, not configuration soup:** proximity transports (LAN, BLE, Multipeer/Nearby) may connect with anyone — the peer is on your network or in radio range, so the marginal exposure is nil; internet-direct (WebRTC) only with established contacts and only when the app opts in (default off — first-hop IP exposure is real and some apps' threat models include the user's own contacts); strangers always via relay.

3. **Proximity transports are app-opt-in solely because of OS permission prompts.** The SDK never triggers a Local Network or Bluetooth dialog uninvited. The LAN bearer (Node.js), which needs no permissions, stays enabled by default.

4. **No stable identifier is ever beaconed.** Per-session random device IDs and receiver-side destHash matching for promiscuous bearers; rotating contact-recognizable beacons (`H(pairwise_secret, epoch)`) where a radio can't afford promiscuous packet-offering. No TURN servers — when traversal fails, the actual relay is the fallback.

5. **Implementation stays demand-gated, phase by phase** (spec §9): finish/verify the LAN bearer when a local-first use case appears; WebRTC on media-bandwidth or marketing pull; native bridges only for a real native-app adopter; multi-hop only at density. The specification exists now so adopters can see the shape of what they'd be joining — the same spec-before-implementation discipline as federation.

## Consequences

- "P2P" stops being a binary the project has or lacks. The honest description becomes: relay-guaranteed delivery with direct paths wherever the platform allows, expanding tier by tier with demand.
- The app-store risk identified in ADR-001 attaches only to Phase 3 (native proximity), and is deferred with it.
- Dual-send costs duplicate bytes until confirm-then-suppress ships; accepted for v1 simplicity.
- The site's "device layer — roadmap" framing stays truthful: the roadmap now has a spec, which is more than it had, and no implementation claim is made.
