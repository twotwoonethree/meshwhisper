# ADR-010 — DNS-free relay location: route by home relay, resolve relays by key

- **Status**: Proposed
- **Date**: 2026-06-15

## Context

[ADR-009](009-decentralized-addressing.md) committed to the "email model" — any
MeshWhisper app/operator able to message any other, E2EE — and proved it end to
end (stages 1, 1b, 2): cross-namespace, opt-in, cross-operator messaging all
work. ADR-009 named the **one residual hard part it did not solve: locating a
relay without DNS.** This ADR designs that out.

Two facts about the code today set the problem precisely:

1. **Forwarding is a flood.** `Federation.fanOut` (`node/src/federation.ts`)
   sends every forwarded packet to **every** established peer, hop-limited
   (`MAX_HOPS`) and deduplicated by a packet-id cache. It works for a handful of
   relays, but it does not scale (traffic is O(edges) per packet, distant relays
   beyond the hop limit are simply unreachable), and — worse for a privacy
   project — **every relay in the federation sees every packet's ciphertext +
   `destHash`.** More relays = more parties touching your traffic.

2. **Relay reachability is static DNS config.** A relay dials peers that have a
   configured `url` (`wss://…` → DNS); open mode only admits *inbound* peers, so
   to route *outward* a relay must already hold a DNS URL for the target. There
   is no address discovery and no key→endpoint resolution at all.

The design must replace the flood with **targeted routing to the one relay that
homes the recipient**, locate that relay **by key, not by name**, and do both
without weakening two load-bearing privacy properties:

- the **`destHash` rotates hourly and is unlinkable** ([the addressing
  scheme](../codebase-overview.md)); and
- **relays cannot reconstruct the social graph** — a relay sees opaque packets,
  not who-talks-to-whom over time.

The naive answer — a global DHT mapping `destHash → home relay` — fails both: it
churns every hour (every relay re-publishes every user's homing each epoch), and
publishing "this recipient is homed at relay R" hands the homing to arbitrary
DHT nodes, leaking exactly the social-graph metadata the project protects. We
reject it (see Alternatives) and design around it.

## Decision (proposed)

**Decompose "locate a relay" into two independent resolutions, and solve each at
the layer where the data is already cheap and non-secret.**

### 1. Recipient → home relay: carried in the self-describing address, not discovered

A recipient's **home relay** (the relay that homes their account — where they
connect, or where they registered for push so it can store-and-forward while
offline; see `classifyLocal` in `node/src/index.ts`) is **stable** — it is tied
to the account, not to the hourly-rotating `destHash`. So it does not need a
global, live, churning map. It needs to travel **with the contact**, the way
ADR-009 already made invites self-describing.

Extend the contact QR/invite (already versioned — `0x00` legacy, `0x01` interop)
to carry, alongside the namespace key, the recipient's **home-relay federation
public key** plus an optional **bootstrap endpoint hint**. When Alice adds Bob,
Bob's home relay travels in the invite, out-of-band. No global lookup; the
mapping lives **only in the contacts of people Bob has actually invited** — not
in any shared index. This is rotation-immune: the home relay is stable, while
`destHash` is still what the home relay matches on for final local delivery.

This is the crucial move: it **reduces "discovery" to the small, public problem
below**, and keeps the private part (who homes whom) out of any shared store.

### 2. Home relay → endpoint: a small, *public* relay-address overlay, keyed by relay key

Resolving a **relay** key → its current network endpoint is a fundamentally
different problem from resolving a *user*, because **relays are public
infrastructure — their addresses are not secret.** So this layer can use a
shared overlay without leaking anything private:

- **Bootstrap + federation gossip (the near-term mechanism).** A relay joins via
  a known bootstrap peer (the Foundation relay is already the published
  bootstrap, and relays already hold federation keys). Peered relays **gossip a
  small `{relayPubkey → endpoint}` table** — O(relays), not O(users) — refreshed
  on join and on address change (rare). This is enough to dial any relay in a
  federation of thousands by key, with no DNS.
- **DHT / mesh rendezvous (the scale ceiling).** If the federation outgrows
  gossip, publish `{relayPubkey → endpoint}` over a Kademlia-style overlay (the
  Tor/IPFS pattern). Note this DHT stores **only public relay addresses**, never
  user homings — so it carries none of the privacy risk that sank the
  per-recipient DHT.

Endpoints are IP:port (or multiaddr), keyed and signed by the relay's federation
key — **DNS-free**. A `wss://…domain` URL remains supported as one endpoint form
for operators who *want* a domain, but it is no longer *required* to route.

### 3. Routing: a home-relay hint, then a direct forward — flood only as fallback

When the SDK submits a packet to **its own** relay (RA) over the existing
client↔relay TLS channel, it includes the recipient's **home-relay key as a
routing hint** (known from the self-describing contact). RA resolves that key to
an endpoint (overlay above), and **forwards the packet directly to the home
relay (RB)** — peered link if one exists, else dial the resolved endpoint. RB
delivers locally (connected client) or stores it (push-registered, offline).
The hop-limited `fanOut` flood is **kept only as the fallback** for packets with
no home-relay hint (legacy invites, or a hint that won't resolve).

Because the hint rides the client→RA TLS channel and is consumed by RA, and RA
then dials RB directly, **no third-party relay sees the hint** — there is no
public "destined-for-RB" header on the wire for transit relays to read.

## Stage-1 — landed & proven (2026-06-15)

The first stage — **home relay in the invite + a submit hint + a direct routed
forward, with flood as fallback** — is implemented and verified end to end
(`tests/cross-operator.test.ts`, the routed test). What shipped:

- **Invite carries the home relay.** A new `homeRelay` config field (federation
  pubkey hex). When set *and* interop is on, the contact QR gains a `0x02`
  version (namespace id + home-relay pubkey); it falls back to `0x01`
  (namespace only) or `0x00` (legacy) so older invites are unaffected. The
  handshake envelope also carries `senderHomeRelay` (mirroring
  `senderNamespace`), so routing is learned **bidirectionally** — the scanner
  from the QR, the scannee from the handshake.
- **Submit hint.** The SDK tags the outbound `Packet` with the recipient's
  home relay (from `peerHomeRelays`); the relay transport sends a tiny
  `{type:'route', destHash, homeRelay}` control message on the same ordered
  channel just before the binary packet — so the hint always arrives first, no
  race, and no third party sees it.
- **Direct routed forward.** The relay records the per-connection hint and, when
  a packet has no local client and no push registration, calls the new
  `FederationManager.forwardToRelay(targetPubkey, packet)` — sending the
  `PacketForward` frame to **only** the home relay instead of `fanOut`-ing to
  every peer. If the target isn't a connected peer, it falls back to the flood,
  so delivery never regresses. The receiving relay handles the frame
  identically to a flooded one — **zero peer-side change**.
- **Observable.** A new `meshwhisper_federation_routed_forwards_sent_total`
  counter; the test asserts it increments (relay A routed straight to relay B)
  while the message is delivered + decrypted across both the namespace and the
  operator boundary.

Strictly opt-in and backward-compatible: with no `homeRelay` configured the
QR/handshake bytes and the wire protocol are unchanged, and the relay floods
exactly as before — verified by the existing (non-`homeRelay`) cross-operator,
cross-namespace, federation, and integration tests all staying green.

Known follow-ups left for later stages: the SDK re-sends the route hint per
packet (could be deduped per destHash); the home-relay pubkey is provided via
config (a relay advertising its own federation key to clients is the automatic
end-state); and stages 2–3 (gossip overlay, DHT/transit/onion) are unstarted.

## Stage-2 — landed & proven (2026-06-15)

The second stage — the **`relayKey → endpoint` gossip overlay** that lets a relay
route to a peer it knows only by key, dialing it on demand — is implemented and
verified (`tests/federation-gossip.test.ts`). What shipped, all inside
`FederationManager`:

- **Self-certifying address records.** `AddrRecord { pubkey, endpoint, ts, sig }`
  — a relay signs `(proto, pubkey, endpoint, ts)` with its federation key. A new
  `FEDERATION_ADVERTISE_URL` seeds the relay's own signed record at startup. The
  signature makes the record un-forgeable for any other relay; the `ts` gives
  last-writer-wins so a moved relay's newer record supersedes the old.
- **Gossip.** On every established federation link, a relay pushes its current
  address book (a new `FRAME_ADDR_GOSSIP` frame, JSON, frame-bounded). Received
  records are signature-verified, freshness-checked, LWW-merged, and — only when
  genuinely new/newer — **re-gossiped to other peers** (excluding the sender), so
  endpoints propagate transitively while converging (unchanged records aren't
  re-sent, so there's no loop). The book is bounded (`MAX_ADDR_BOOK`).
- **On-demand dial.** `forwardToRelay` now: if the target is connected, send; else
  if its endpoint is in the address book, **dial it on demand**, queue the packet
  (bounded), and flush once the link establishes; else return false → flood. So a
  relay reaches a peer it has *no static configuration for*, located purely by key.
- **Observable.** `meshwhisper_federation_addr_records_known` (gauge),
  `…_addr_records_learned_total`, and `…_discovered_dials_total`.

The test proves it with a 3-relay topology — A and B each know only a bootstrap
C, no A↔B config — where B's signed record gossips B→C→A, then A dials B from the
learned endpoint and a packet reaches a client on B (exact bytes), with A's
`discovered_dials_total` incremented. Records carry only public relay
infrastructure (never user data or homings), so gossiping them leaks nothing —
the privacy analysis below is unchanged.

Strictly additive and backward-compatible: with no `FEDERATION_ADVERTISE_URL` the
address book stays empty, `forwardToRelay` behaves exactly as in stage-1 (routes
to a configured connected peer or falls back to flood), and the existing
two-relay federation, cross-operator, cross-namespace, and integration tests stay
green.

Known follow-ups for stage-3: on-demand-dialed peers currently persist (no
eviction of idle learned relays); gossip is full-table-push + delta with a
single-frame cap (~dozens of records — needs chunking/pagination for large
federations); and NAT'd/dynamic-IP home relays (transit/TURN) plus multi-hop
transit privacy (onion) remain the genuinely hard, unstarted parts.

## Privacy analysis (why this is strictly better than both alternatives)

Count who touches a packet under each model:

| Model | Parties touching the packet | Who learns a homing |
|---|---|---|
| **Flood (today)** | *every* relay in the federation | every relay sees `destHash` + ciphertext |
| **Per-recipient DHT** | sender's relay, home relay | **arbitrary DHT nodes** learn `destHash → home relay` |
| **This ADR** | sender's relay (RA), home relay (RB) | **nobody new** — RA already serves the sender; RB already homes the recipient |

Under this design the only parties that touch a packet are **RA — which already
knows the sender's traffic because it *is* the sender's relay — and RB, which
already homes the recipient.** The relay-address overlay exposes only public
`relayPubkey → IP`. The rotating, unlinkable `destHash` is untouched and is
still the final-delivery match key at RB. No new party learns who-talks-to-whom.

## Alternatives considered

1. **Keep the flood (do nothing).** Simple, already shipped. **Rejected:**
   O(edges)/packet doesn't scale, the hop limit makes distant relays
   unreachable, and it maximizes the number of relays that see every packet —
   the opposite of the project's privacy posture.
2. **Per-recipient `destHash → relay` DHT.** The "obvious" global directory.
   **Rejected:** hourly `destHash` rotation churns the whole map every epoch, and
   publishing homings to arbitrary DHT nodes leaks the social-graph metadata
   MeshWhisper exists to protect. This is the trap the ADR is built to avoid.
3. **Rendezvous / consistent-hash homing** — assign each user to the relay their
   key hashes to over the known relay set; sender computes the same hash.
   **Rejected:** it forces users onto a hash-assigned relay rather than the
   relay their app/operator runs (breaking "every app runs its own relay" and
   ADR-001's adoption model), reshuffles assignments on relay-set churn, and
   still leaks `userKey → relay` to whoever holds the relay set.
4. **DNS / `.well-known` (`user@domain`).** Trivial discovery. **Rejected** in
   ADR-009 — DNS is a central, seizable choke point; this whole ADR exists to
   remove it.
5. **Relay-address DHT instead of gossip, from day one.** **Deferred, not
   rejected:** a DHT is the right tool at scale, but gossip among federated
   peers is simpler and sufficient for the foreseeable federation size, and the
   DHT can slot in behind the same `resolve(relayKey) → endpoint` interface
   later. Build the interface now, the DHT when the size demands it.

## Consequences

- **Replaces flood with targeted routing** for every invited contact (the ~all
  case), collapsing per-packet fan-out from O(edges) to a single hop and
  shrinking the set of relays that touch a packet to two — a scaling *and* a
  privacy win at once.
- **Builds on existing primitives**: the versioned self-describing QR (ADR-009),
  federation keys + the published bootstrap peer, the client↔relay channel, and
  `classifyLocal`'s deliver/store/onward logic (which becomes the *fallback*
  path, not the primary one).
- **New protocol surface to design carefully**: (a) the QR/invite gains a
  home-relay key + endpoint hint (versioned, backward-compatible — legacy
  `0x00`/`0x01` invites simply fall back to flood); (b) the client→relay submit
  carries an optional routing hint; (c) federation gains a `resolve(relayKey) →
  endpoint` overlay and a *routed* forward frame distinct from `fanOut`.
- **Honest hard parts that remain:**
  - **NAT'd / dynamic-IP home relays.** Direct dial assumes RB is publicly
    reachable. Public-IP VPS relays (the Foundation relay, most operators) are
    fine for v1; home-run relays behind NAT need a TURN-like transit relay — the
    same hole-punching problem [ADR-002](002-relay-first-not-p2p-first.md) chose
    relays to sidestep, now reappearing one layer up.
  - **Recipient migration.** If Bob moves to a new home relay, every contact's
    cached home-relay key is stale. Needs a forwarding/redirect record (the
    email MX-change analogy) or a re-share — to design.
  - **Transit privacy.** When RA *cannot* reach RB directly and the packet must
    traverse intermediates, those hops would see a routing header; that path
    wants onion-style layering before it ships. v1 assumes direct dial and keeps
    flood (no header) as the only multi-hop fallback.
  - **Trust.** Routing to the recipient's *chosen* home relay means trusting the
    relay the recipient picked — reasonable (it's theirs), and it can still drop
    or log metadata, never read content. Open-federation abuse rides the
    existing boundary: rate limiting, blocklists, sybil resistance.
- **Staged rollout:**
  1. **Home relay in the invite + submit hint + direct routed forward** (flood
     becomes fallback). Kills the flood for every invited contact with no new
     infrastructure beyond the routed-forward frame. *This is the next spike.*
  2. **Relay-address gossip overlay** (`resolve(relayKey) → endpoint`,
     bootstrap + peer gossip). DNS-free dialing; survives relay address changes.
  3. **DHT / transit / onion** for federation scale, NAT'd relays, and
     multi-hop privacy hardening.

See also: [ADR-001](001-adoption-driven-mesh.md) (transport-only mesh this
extends), [ADR-002](002-relay-first-not-p2p-first.md) (the NAT problem that
recurs here), [ADR-009](009-decentralized-addressing.md) (the addressing model
this completes), and `docs/federation.md`.
