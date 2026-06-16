# Federation

**Status:** v1 — **implemented** (2026-06-10, `node/src/federation.ts`). The reference implementation ships in `meshwhisper-node` and is verified by a two-relay integration suite (`tests/federation.test.ts`): mutual handshake, cross-relay packet delivery, loop prevention, unknown-peer rejection, open-mode dynamic admission, blocklist rejection, per-peer rate limiting. See [self-hosting.md](self-hosting.md#federation-peering-with-other-relay-operators) for the operator guide. This document remains the authoritative wire-format specification.

**v1.1 amendment — admission modes.** The original v1 draft specified allow-list-only admission. Implementation experience immediately surfaced the tension with the protocol's own "relay promiscuously" principle: bilateral pubkey ceremonies scale O(n²) and make the mesh a product of negotiation rather than adoption. v1.1 adds `FEDERATION_MODE`:

- **`open`** (recommended): any peer completing the handshake is admitted dynamically, up to a configurable cap. The handshake still proves key possession, so peers have stable identities — admission control just moves from *pre-approval* to *reactive blocklisting*. The security boundary becomes the protections that were already mandatory: per-peer rate limiting (now implemented, default 6000 frames/min/peer), hop-count TTL, packet-id dedup, and the home-relay-only storage rule. A malicious peer can burn its rate-limit budget and be blocklisted; it cannot read content, cannot flood storage, and cannot amplify beyond MAX_HOPS.
- **`allowlist`**: the original v1 posture, retained for operators who want explicit control.

The threat-model line "the security model assumes you peer with operators you have some reason to trust" applies to allowlist mode only. In open mode, peers are assumed untrusted and the protocol-level protections are load-bearing.

**v1.2 amendment — DNS-free relay location (2026-06-16, [ADR-010](adr/010-dns-free-relay-location.md)).** v1 routed unrecognized packets by **flooding** every peer (hop-limited), and located peers only by a statically-configured `wss://` URL — i.e. by DNS. Several items the v1 spec listed under [Future versions](#future-versions) are now implemented, turning flood-and-DNS into **targeted, key-addressed routing**. ADR-010 is the authoritative spec; in brief:

- **Route by home relay, not flood.** A contact's self-describing invite carries its *home relay* (federation pubkey); the sender's relay forwards straight to that one relay instead of fanning out to all peers. Flood remains only as a fallback. (`forwardToRelay`; metric `routed_forwards_sent_total`.)
- **Gossip address overlay → locate relays by key, no DNS.** Relays sign a self-certifying address record `{pubkey, endpoint, ts, sig}` and gossip it (with periodic anti-entropy so it converges under loss). A relay can then dial a peer it knows only by pubkey; `FEDERATION_ADVERTISE_URL` opts a relay into advertising itself. (`addr_records_known`, `discovered_dials_total`.)
- **NAT transit.** A NAT'd relay (no dialable endpoint) advertises `via` transit anchors — the public peers it holds an outbound link to. The sender reaches it through an anchor; `FRAME_PACKET_ROUTED` carries "deliver to relay X" and composes recursively, bottoming out at an ordinary forward over the anchor's link.
- **Onion-routed transit (closes the v1 non-goal).** With `FEDERATION_ONION_TRANSIT=1`, transit is wrapped in per-hop sealed boxes (X25519 → HKDF-SHA256 → AES-256-GCM); each hop peels only its own layer and learns just the next hop — never the packet or its destHash. Path selection (`FEDERATION_ONION_HOPS`) inserts intermediate hops so a non-adjacent relay never learns the destination. This is the per-hop onion routing v1 deferred.
- **Both-ends-NAT rendezvous.** A restricted-egress sender (`FEDERATION_TRANSIT_ONLY=1`, holds only its uplink) reaches a NAT'd recipient by bridge-routing over existing links through a common backbone relay, discovered by a bounded BFS over the gossip topology.
- **Self-maintaining.** Gossip-learned peers are evicted when idle (`learned_peers_evicted_total`); gossip paginates across frames so a large address book fully propagates.

All of the above is opt-in and backward-compatible: a node with none of the new env vars set behaves exactly as v1.1 (flood + configured URLs). Verified by `tests/federation-gossip.test.ts` and `tests/onion.test.ts`. The privacy table and threat model below describe the v1 flood path; under onion transit a transit relay sees neither the packet nor the destHash, and a non-adjacent intermediate does not learn the destination relay.

Federation is the node-to-node forwarding protocol that turns isolated `meshwhisper-node` deployments into a single mesh. Without it, every node is an island; every app that deploys a node operates a private silo, and the whitepaper's central claim — that privacy strengthens with adoption density because no single operator sees both ends of a conversation — is aspirational rather than operational. Federation is the piece that makes the claim true.

Read this alongside the [whitepaper](whitepaper.md) (overall trust model and adoption thesis), [ADR-001](adr/001-adoption-driven-mesh.md) (why the mesh is between nodes, not phones), and [ADR-002](adr/002-relay-first-not-p2p-first.md) (why we deferred client-side P2P in favour of this).

## Status and scope

This is a v1 specification — the minimum protocol needed for two or more operators to peer their nodes and forward packets. v1 is intentionally narrow:

- **In scope**: pairwise peering between explicitly configured nodes; forwarding of opaque encrypted packets; loop prevention; threat model; backwards compatibility with non-federated nodes.
- **Out of scope for v1** (with notes on each): automatic peer discovery, gossip topology, onion routing across hops, reciprocity enforcement, cross-node prekey directory, cross-node push wake, cross-node store-and-forward, sybil-resistant peer admission, media / archive federation.

The v1 spec exists so a second operator can implement against a stable target. Subsequent versions lift items from the deferred list as the network composition makes them necessary — see [Future versions](#future-versions).

## Goals

1. A packet sent from a device whose home relay is Node A and destined for a device whose home relay is Node B should be deliverable when those two nodes have a federation peering, with no SDK-side change.
2. Intermediate nodes in a chain (A → B → C) MAY learn their immediate neighbours but MUST NOT learn the originator (beyond their predecessor) or the ultimate recipient (beyond the destination hash, which is opaque).
3. Federation is opt-in per operator and per-peer. No node is federated by default; no node accepts federation from a peer it hasn't explicitly allow-listed.
4. The federation channel is independent of the existing client-relay channel. Existing SDK behaviour and existing HTTP endpoints (`/directory`, `/opks`, `/blob`, `/media`, `/archive`, `/push`) are unchanged.

## Non-goals

Things v1 deliberately does NOT do, with rationale:

- **Onion routing across multiple federation hops.** A packet routed A → B → C reveals to B both adjacent hops (A and C). True onion routing would require per-hop encryption and significantly complicates the protocol. v1 accepts the "honest-but-curious adjacent operator" threat model; users wanting stronger anonymity should use a VPN alongside the SDK, as today.
- **Reciprocity enforcement.** Substrate exists at `src/reciprocity/` (RelayLedger, 371 LOC) but v1 forwards openly without tit-for-tat accounting, mirroring Tor's middle-node model. Adaptive throttling becomes meaningful at higher mesh density.
- **Sybil-resistant peer admission.** Substrate exists at `src/sybil/` (EntropyChallenger, ZKRelayReputation, 660 LOC). v1 peering is by explicit operator-to-operator agreement — admit who you trust. Sybil resistance becomes relevant when peering needs to scale beyond pre-shared keys.
- **Cross-node prekey directory.** Each node's `/directory` endpoint stays local. Users in app A's namespace can't discover users in app B's namespace via federation. Cross-namespace user discovery would require a separate design that preserves namespace isolation, which is non-trivial.
- **Cross-node store-and-forward.** Only the recipient's home relay stores blobs for offline delivery. Intermediate nodes forward best-effort: if the next hop is offline at the moment of forwarding, the packet is dropped on that hop and the recipient relies on pulling the original from their home relay when they reconnect.
- **Cross-node push notification wake.** Push tokens are stored at the recipient's home relay. A forwarded packet that needs to wake a sleeping device wakes it via the home relay's push pipeline. Intermediate nodes have no push capability.
- **Cross-node media or archive storage.** `/media` and `/archive` endpoints stay per-node. Media URLs in messages reference the originating relay's host directly; a recipient on a different federated relay fetches over HTTPS, not over the federation channel.
- **Automatic peer discovery.** v1 peers are configured statically (config file or env var). Gossip-based discovery is a future direction once enough operators exist to seed it.

## Architecture

```
                  federation channel
                  (one persistent WebSocket per peer pair)

┌──────────────┐                                ┌──────────────┐
│   Node A     │ ◄────────────────────────────► │   Node B     │
│              │                                │              │
│ ┌──────────┐ │                                │ ┌──────────┐ │
│ │ Device 1 │ │   destHash for Device 3        │ │ Device 3 │ │
│ │ Device 2 │ │ ──packet──►─forward─►──deliver │ │ Device 4 │ │
│ └──────────┘ │                                │ └──────────┘ │
└──────────────┘                                └──────────────┘
```

Each node maintains zero or more **federation peers**. A federation peer is another `meshwhisper-node` instance that this operator has explicitly chosen to peer with. The peer relationship is symmetric (both operators allow-list each other) and persistent (a long-lived WebSocket; reconnect with backoff on disconnect).

When a packet arrives at a node:

1. If any **local device** has the destination hash registered → deliver via the existing client-relay path. (Unchanged from non-federated.)
2. Otherwise, if `forwardCount < MAX_HOPS` → forward to each federation peer that hasn't already seen this packet (per the packet-id cache). Increment `forwardCount` before transmit.
3. Otherwise, drop.

A packet that nobody recognizes eventually dies of TTL exhaustion. The cost is bounded multiplicative bandwidth (see [Threat model](#threat-model)).

## Peer handshake

Federation is over a WebSocket connection initiated by either side, using the WebSocket subprotocol identifier `meshwhisper-federation.v1`. Operators MAY serve federation on the same host:port as the existing client-relay WebSocket (subprotocol negotiation differentiates) or on a separate port. Implementations MUST support subprotocol negotiation; using a separate port is an operator's choice for clearer rate-limiting boundaries.

The handshake establishes mutual identity. Each node has a long-lived Ed25519 **federation keypair**, separate from any client identity and separate from the developer key.

Wire format (binary, length-prefixed; all `u32` are big-endian):

```
ClientHello (initiator → responder):
  version:        u8        # currently 0x01
  pubkey:         32 bytes  # Ed25519 of the initiator node
  nonce:          16 bytes  # random, fresh per handshake
  capabilities:   u32       # bitmap; v1 = 0x00000000

ServerHello (responder → initiator):
  version:        u8        # echo if accepted, 0x00 if rejected
  pubkey:         32 bytes  # Ed25519 of the responder node
  nonce:          16 bytes  # random, fresh per handshake
  capabilities:   u32

ClientSignature (initiator → responder):
  signature:      64 bytes  # see canonical message below

ServerSignature (responder → initiator):
  signature:      64 bytes  # see canonical message below
```

The **canonical message** that each side signs is the UTF-8 bytes of:

```
meshwhisper-federation.v1
{initiator-pubkey-hex}
{responder-pubkey-hex}
{initiator-nonce-hex}
{responder-nonce-hex}
```

…joined with `\n` separators (no trailing newline). Both sides sign exactly the same bytes; the order of pubkey/nonce fields is fixed regardless of which side initiated.

Both signatures MUST be verified. The connection is rejected (and the WebSocket closed) if:

- The version isn't recognized.
- Either pubkey isn't on the receiving node's allow-list.
- Either signature is invalid.

This is mutual authentication. Each side proves possession of the private key corresponding to the pubkey the other has on its allow-list. There's no certificate authority, no DNS-based identity. Operators pre-share pubkeys out-of-band — same model as SSH `authorized_keys`.

After the handshake completes, the connection enters the forwarding phase.

## Forwarding wire format

After the handshake, the WebSocket carries length-prefixed binary frames. Two frame types in v1:

```
FrameHeader:
  frameType:     u8        # 0x01 = PacketForward, 0x02 = Heartbeat
  length:        u32       # length of the frame body in bytes (big-endian)
  body:          [length] bytes

PacketForward body:
  packetId:      16 bytes  # random; used for loop detection
  forwardCount:  u8        # incremented at each hop; drop if ≥ MAX_HOPS
  packet:        var-length # the original Packet (binary, opaque)

Heartbeat body:
  timestamp:     i64       # ms-precision unix, sender's clock
```

`packet` is the existing client-relay Packet binary format, **unmodified**. The federation layer treats it as opaque bytes — destHash extraction for routing reads only the leading bytes of the Packet header.

**Constants:**

- `MAX_HOPS = 3` (recommended default; operators MAY tune).
- Packet-id LRU cache size: `1024` recent entries (recommended).
- Packet-id cache TTL: `60` seconds (recommended).
- Heartbeat interval: `30` seconds.
- Heartbeat timeout (no frame received): `90` seconds → close + reconnect.
- Reconnect backoff: exponential `1s, 2s, 4s, 8s, 16s, 32s, 60s` (cap at 60s).
- Maximum frame body size: `8192` bytes (8 KiB; matches client-relay packet cap).

A node receiving a `PacketForward`:

1. Read the body. Reject (close connection) if any field is malformed or `length` exceeds the maximum.
2. Look up `packetId` in the recent-packets LRU. If present, drop silently — loop or duplicate.
3. Insert `packetId` into the cache.
4. If `forwardCount ≥ MAX_HOPS`, drop.
5. Extract destHash from the packet header.
6. If a local device has registered this destHash, deliver via the standard client-relay path. Stop here.
7. Otherwise, increment `forwardCount` and send `PacketForward` to every peer EXCEPT the peer this frame came in on.

A node receiving a `Heartbeat` resets the read-timeout timer and discards the body. Optionally logs the timestamp delta for clock-skew observation.

A node SHOULD send a Heartbeat every 30s if no other frame has been transmitted on this connection in that window.

## Privacy properties

What each party learns:

| Party | Sender device | Recipient device | destHash | Time | Size | App namespace | Content |
|---|---|---|---|---|---|---|---|
| **Sender's home relay** (A) | yes | no | yes | yes | yes | no¹ | no |
| **Intermediate node** (B in A→B→C) | no | no | yes | yes | yes | no¹ | no |
| **Recipient's home relay** (C) | no | yes (it's the device that pulls the blob) | yes | yes | yes | no¹ | no |
| **Eavesdropper on the federation channel** | no | no | encrypted in TLS | no | encrypted in TLS | no | no |

¹ destHash incorporates `namespace_id` via `BLAKE3(namespace_id || peer_key || epoch_hour)` but the input isn't recoverable from the hash.

What no party learns:

- **The full path** (no single node sees all hops; this is the value federation adds).
- **The conversation pair** (no node correlates senderDevice with receiverDevice unless it operates both endpoints' home relays).
- **The application** (destHash doesn't reveal namespace_id).
- **The content** (E2EE between devices; every relay sees only ciphertext).

The "honest-but-curious adjacent operator" model is identical in shape to a Tor middle node. The forwarding node sees its two immediate neighbours but cannot identify the full path, and sees no plaintext.

## Threat model

What the protocol defends against:

- **Honest-but-curious operators.** Forwarding nodes can log metadata but can't read content. destHash rotates hourly (the `epoch_hour` input), limiting how long a destHash can be correlated.
- **Active drop or re-ordering by intermediate nodes.** Receiver's Double Ratchet handles out-of-order arrival; sender retries or recipient pulls from the home relay's persistent storage.
- **Replay across the federation channel.** The packet-id LRU cache makes replays within the 60s window ineffective. Beyond that, the ratchet state on the receiving device rejects already-decrypted messages.
- **TTL exhaustion as amplification.** `MAX_HOPS = 3` bounds multiplicative blowup. With N peers, worst-case unrecognized-packet propagation is `N × (N-1) × (N-2)` copies — bounded and small for realistic N.
- **Connection-level injection.** Mutual signature in the handshake prevents impersonation; TLS (operator-provisioned for the WebSocket port) prevents on-path tampering.

What it does NOT defend against:

- **Two colluding home relays.** If A's operator and C's operator collude, they see both ends of conversations between devices on A and C. This is the same risk as both users sharing a single relay, and v1 doesn't introduce mixing or onion routing to defeat it.
- **Global passive observer.** An adversary with packet-level visibility across all operators can correlate by traffic timing. Existing chaff partially obscures this but doesn't eliminate it.
- **A peer that turns malicious after admission.** v1 peering is by explicit allow-list; the model assumes you peer with operators you have some reason to trust. If a peer turns adversarial, remove from your allow-list and the connection disconnects.
- **Per-peer denial of service via packet flood.** Implementations SHOULD rate-limit per-peer (recommendation: 100 frames/sec; operators tune). v1 wire format doesn't specify a rate-limit signal; this is operator policy.
- **Compromise of a peer's federation private key.** Same shape as SSH host key compromise. Operators should rotate keys periodically (manual operation in v1; no protocol mechanism).

## Operational model

A node operator opts into federation by:

1. **Generating a federation keypair.** Either via a startup auto-generate (stored as `data/federation-key.json`, similar to how the client identity is stored) or via an explicit CLI command (`meshwhisper-node federation keygen`).
2. **Sharing the federation pubkey hex with another operator** out-of-band. Treat it like an SSH public key — share over any authenticated channel.
3. **Adding the other operator's pubkey to the local allow-list.** Format: a JSON file at the path given by `FEDERATION_PEERS_FILE` env var (default `data/federation-peers.json`):

   ```json
   {
     "peers": [
       { "pubkey": "<hex>", "url": "wss://node-b.example.org/federation" },
       { "pubkey": "<hex>" }
     ]
   }
   ```

   If `url` is present, this node will initiate outbound connections to that peer. If absent, this node only accepts inbound connections from that pubkey. Either side may initiate; the handshake is symmetric.

4. **Restarting the node** (or sending `SIGHUP` if hot-reload is implemented).

A peer relationship is bidirectional once both sides have allow-listed each other AND at least one side has a `url` to dial.

Operators MAY peer with as many other operators as they choose. There is no protocol cap. Sensible adoption-stage defaults: small pools of trusted operators initially; topology densifies as the network grows. See [direction.md](direction.md) for the strategic context.

## Backwards compatibility

A node that doesn't speak federation is unaffected. Existing client-relay traffic is unchanged on the same WebSocket port (subprotocol negotiation differentiates federation from client). The federation code path is purely additive.

A device whose home relay is non-federated remains reachable only by devices whose path eventually terminates on that relay. To benefit from federation, the recipient's home relay MUST opt in.

There is no mechanism to "join the federation" without an existing peer admitting you. The bootstrap problem is solved by the Foundation relay's willingness to peer with new adopters — see [direction.md](direction.md)'s "Make adoption cheap" section.

## Versioning

The wire-format version is a `u8` in the handshake. v1 is `0x01`. Future versions:

- Add to the **capability bitmap** for backward-compatible features (e.g. `0x01 = supports reciprocity throttle hints`).
- **Bump the version byte** for breaking changes.

Servers MUST reject handshakes with unknown versions (respond with `version = 0x00` in `ServerHello` and close). There is no fall-through to older versions; operators upgrading the protocol must coordinate with their peers.

## Implementation work items

Concrete engineering to ship v1 (not part of the spec, but listed here for project planning):

1. **`node/src/federation.ts`** (new module). WebSocket client + server. Handshake. Frame parser. Packet-id LRU. Per-peer connection lifecycle.
2. **Forwarding hook** in the existing client-relay packet path (`node/src/index.ts`). Check: local recipient? If not, hand to federation module for forwarding.
3. **Federation keypair generation + persistence.** Reuse existing Ed25519 primitives.
4. **Configuration loader** for `FEDERATION_PEERS_FILE`. Reload on `SIGHUP` (optional).
5. **Operator documentation** added to [`docs/self-hosting.md`](self-hosting.md).
6. **Tests** in `tests/federation.test.ts`: handshake success / wrong-pubkey rejection / version rejection / signature rejection; basic A→B forwarding; A→B→C forwarding; loop prevention via packet-id cache; TTL exhaustion drop; reconnect with backoff; frame-size enforcement.
7. **Optional CLI subcommand** `meshwhisper-node federation` with `keygen`, `add-peer`, `remove-peer`, `list-peers` subcommands.

Estimated effort: 1–2 weeks of focused work, given the existing relay codebase, the existing Ed25519 primitives, and the bounded scope.

## Open items for v1.x

Items deliberately left underspecified in v1 — implementations may differ until a follow-up spec tightens them:

- **Rate limiting per-peer.** SHOULD be implemented; exact API and defaults aren't specified.
- **Packet-id cache eviction policy.** LRU with 1024 entries and 60s TTL are recommended; the right values depend on observed network conditions.
- **Heartbeat tuning.** 30s/90s are reasonable; not load-bearing for correctness.
- **Logging surface.** Whether to log peer connect/disconnect, forwarded-packet counts, etc. is operator policy.
- **Federation observability.** No `/metrics` endpoint specified. Implementations MAY expose per-peer counters; format unspecified in v1.

These get tightened in v1.0.1 or v1.1 once one implementation has informed the defaults.

## Future versions

Non-exhaustive list of what's deferred to v2+:

- **Gossip-based peer discovery.** Operators advertise pubkey + URL via existing federation channels; new operators learn of peers from peers.
- **Onion routing per hop.** Per-hop encryption so intermediate nodes don't see both neighbours simultaneously.
- **Reciprocity-aware throttling.** Lift the existing `src/reciprocity/` substrate into the node binary. Peers that send much more than they receive are rate-capped.
- **Sybil-resistant admission.** Lift `src/sybil/` substrate. Some form of proof-of-physical-device or staked reputation allows opting out of manual allow-listing.
- **Cross-node prekey directory.** Federated lookup of usernames across nodes (with explicit per-namespace opt-in to avoid breaking namespace isolation).
- **Cross-node store-and-forward.** Intermediate nodes hold packets for short periods if the next hop is offline.
- **Cross-node media / archive replication.** Both endpoints stay per-node in v1; replication would require a separate design.

These are options, not commitments. The protocol can grow into them if and when the network composition makes them necessary, per [direction.md](direction.md)'s principle of resisting infrastructure built for an audience that doesn't yet exist.

## Acknowledgments

The packet-forwarding model draws from Reticulum and Tor. The operator-allow-list peering model from SSH and Pleroma. The opaque-destHash routing primitive is MeshWhisper's own, from the original client-relay protocol — federation reuses it unchanged, which is most of the point.

## Revision log

- **2026-06-08** — v1 draft. First version of this document.
