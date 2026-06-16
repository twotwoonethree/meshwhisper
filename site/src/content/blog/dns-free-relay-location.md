---
title: "Relays that find each other without a phone book"
description: "MeshWhisper relays now locate and reach each other by cryptographic key — no DNS anywhere in the routing path. Through NAT, with onion-routed hops, even when both ends are firewalled. The last bit of centralization in the mesh, removed."
pubDate: 2026-06-16T13:00:00Z
---

*New to MeshWhisper? [Start here](/blog/what-is-meshwhisper/) — short version: E2EE messaging for any app, through a relay that can't read a word of it. This post is about how relays now find each other, and why DNS isn't invited.*

A federated network has a quiet dependency it rarely admits to: to forward a packet toward someone, a relay has to *find* the relay that homes them. Until now MeshWhisper did that the cheap way — it **flooded**. A packet with no local recipient went to every peer, hop-limited, until it either found a home or died of TTL. And to reach a peer at all, you needed its `wss://` URL. A URL is a domain. A domain is DNS.

DNS is the most boring single point of failure imaginable, and the most effective. Registrars get coerced, names get seized, a `.well-known` lookup is a tap waiting to happen. The [whole pitch](/blog/what-is-meshwhisper/) of MeshWhisper is that there's no central thing to lean on — and we'd left a central thing in the routing layer the entire time. This release takes it out.

## Route by who you're talking to, not by shouting

A contact's invite is already self-describing — it carries their key. Now it also carries their **home relay** (a federation public key). So the sender's relay forwards the packet *straight to that one relay* instead of broadcasting it to the whole mesh and hoping. Flooding survives only as a fallback for legacy invites.

This is a scaling win — per-packet fan-out collapses from "every edge in the mesh" to one hop — but mostly it's a privacy win. Under the flood, *every* relay in the federation saw your packet go by. Now exactly two relays touch it: yours, and theirs. We have a table in the [spec](https://github.com/twotwoonethree/meshwhisper/blob/main/docs/federation.md) showing who learns what; the short version is "fewer parties, on purpose."

## Finding a relay by key, not by name

Routing to a home relay only helps if you can *reach* it without looking up a domain. So relays now sign a tiny self-certifying record — `{pubkey, endpoint, timestamp, signature}` — and gossip it to their peers, who gossip the changed ones onward. It's last-writer-wins by timestamp (a relay that moves just signs a fresher record), and there's a periodic anti-entropy pass so the map converges even when a gossip message gets dropped. A relay can now dial a peer it knows *only by public key*. The endpoint inside the record is an IP — not a domain — and it's the key that's authoritative, not the address.

The thing being gossiped is public infrastructure: a relay's address isn't a secret. So this leaks nothing about who talks to whom — which is exactly why we *didn't* build the obvious thing, a global "who's homed where" directory. That would hand the social graph to whoever runs the directory. The map we gossip is relays-to-addresses, full stop.

## The annoying part: NAT, and then NAT on both ends

Public relays on a VPS are easy. The interesting case is a relay behind NAT — a box on a home connection, a clinic, a ship — that can't accept an inbound connection at all. You can't dial it. But it can dial *out*, and it does: it keeps a persistent link up to a public peer. So it advertises that peer as a **transit anchor**, and the sender routes through the anchor, which hands the packet down the link the NAT'd relay already holds open. A new frame type carries "deliver to relay X" and composes recursively — it bottoms out at an ordinary forward, so the relay on the far end needs no special case.

Then the genuinely hard one: the *sender's* relay is also locked down — egress-filtered to hold only its own uplink, unable to dial arbitrary peers — and the recipient's relay is NAT'd too. Neither can reach the other directly. The fix is the one every NAT-traversal story eventually arrives at: find a relay both sides can reach, and bridge through it. We find it with a bounded breadth-first search over the gossiped topology, then route over links that already exist. No hole-punching, no STUN server, no coordination call — just the mesh the relays already formed, read as a graph.

## Onion all the way down

Transit raises a fair objection: the relay in the middle now knows it's forwarding *to* the destination relay, and sees the packet go by. For a single hop, where the middle relay is the destination's own anchor, that's unavoidable — it's adjacent. But for anything longer, it shouldn't have to.

So transit can be onion-wrapped (opt-in). The packet is sealed in nested layers — an ephemeral X25519 key per hop, ECDH, HKDF, AES-256-GCM — one layer per relay on the path. Each relay peels exactly its own layer and learns precisely one thing: the next hop. Not the packet. Not the destination hash. Not who's at the end. And path selection deliberately inserts an extra relay or two from the gossip topology, so a non-adjacent hop can't even see the destination relay. It's Tor's idea, applied to the relay mesh instead of the open internet, and it's the per-hop onion routing the original federation spec listed as a non-goal and then quietly went and built.

## What's honest about it

Two limits we're not going to pretend away. At a *single* transit hop, the anchor is by definition next to the destination, so it learns which relay that is — intrinsic, not fixable by cleverness. And a true network partition, where no relay is reachable from both sides at all, isn't a routing problem; it needs someone to introduce a shared peer out of band — which the invite layer already does. Everything else — idle learned connections getting evicted, the gossip paginating so a big address book actually propagates — is handled.

All of it is opt-in and backward-compatible. A relay that sets none of the new knobs floods and dials URLs exactly like before. Turn them on and it locates peers by key, traverses NAT, and onion-routes transit. The design and its trade-offs live in [ADR-010](https://github.com/twotwoonethree/meshwhisper/blob/main/docs/adr/010-dns-free-relay-location.md); the operator knobs are in [self-hosting.md](https://github.com/twotwoonethree/meshwhisper/blob/main/docs/self-hosting.md).

The mesh still has [one node worth bragging about](/blog/meshwhisper-0-3/). But the routing layer underneath it no longer asks anyone's permission to find the second one.

[GitHub](https://github.com/twotwoonethree/meshwhisper) · [Federation spec](https://github.com/twotwoonethree/meshwhisper/blob/main/docs/federation.md) · Running a relay? The new knobs are all opt-in — [self-hosting.md](https://github.com/twotwoonethree/meshwhisper/blob/main/docs/self-hosting.md).
