---
title: "MeshWhisper 0.3: messaging that survives losing its own infrastructure"
description: "Two devices on the same network now deliver messages peer-to-peer. Kill the relay, pull the internet — the conversation carries on, encrypted, like nothing happened. Plus open federation and the rest of a busy two months."
pubDate: 2026-06-12T13:00:00Z
---

*New to MeshWhisper? [Start here](/blog/what-is-meshwhisper/) — short version: E2EE messaging for any app, through a relay that can't read a word of it. This post is about what's new.*

The most satisfying test we've ever written does the following: starts a relay, lets two peers find each other and exchange a message, then **kills the relay with `SIGKILL`** — no shutdown, no goodbye — and sends another message. It arrives. The test suite is 368 tests deep at this point, and that one's our favourite child. We don't care that you're not supposed to have one.

## Conversations that outlive the infrastructure

As of 0.3.0, devices on the same network discover each other and deliver messages **peer-to-peer**. Every outbound message is dual-sent — offered to connected LAN peers *and* sent via the relay — and receivers deduplicate. The arithmetic falls out beautifully:

> Once two peers have a session, their conversation no longer depends on any infrastructure. Kill the relay, unplug the router — messages keep flowing, end-to-end encrypted.

There's no offline mode, because there's no mode. Application code calls `send()`; degradation and recovery are silent. The funny part of building this was discovering our LAN layer had been faithfully discovering peers, opening connections, and then carrying *nothing but cover traffic* for months — the plumbing was all there, hooked up to a tap nobody had turned. Turning it required exactly one genuinely subtle fix (deduplication must forgive a copy that arrives before the session is ready, or a fast LAN packet can murder its own relay twin — the test for that one earned its keep).

What this unlocks is bigger than a party trick: **isolated networks are now a supported deployment.** A node on a Raspberry Pi serves a factory floor, a ship, a clinic, an air-gapped office — nothing touches the internet, and live conversations don't even depend on the Pi. Works for machines too: the [local-first example](https://github.com/twotwoonethree/meshwhisper/tree/main/examples/local-first) has a sensor fleet whose encrypted telemetry keeps arriving after the relay dies mid-demo. Deployment guide: [docs/local-networks.md](https://github.com/twotwoonethree/meshwhisper/blob/main/docs/local-networks.md).

Privacy keeps its shape on the LAN: packets are offered to every local peer, but only the addressee can recognize theirs, and discovery beacons are random per-session. A device on your network learns that MeshWhisper devices exist — not who's talking to whom.

## Federation went from ceremony to switch

Relays now forward packets for each other. Our first draft of the peering protocol required both operators to exchange public keys before connecting — very dignified, very secure, and we binned it within forty-eight hours, because bilateral ceremonies scale O(n²) and produce a mesh by *negotiation* when the entire point of the protocol is a mesh by *adoption*. The relay can't read anything; what exactly were we gatekeeping?

So: `FEDERATION_MODE: "open"`. Any relay that completes the cryptographic handshake is in. Rate limits, hop caps, dedup, and a blocklist are the bouncer; pre-approval is not. One bootstrap entry pointed at `wss://relay.meshwhisper.org` joins the mesh — the Foundation relay runs open mode and accepts peers today.

And the quiet part, said loudly: the mechanism is live, the mesh has **one node**. A one-node mesh is called a server with notions. The milestone we actually care about is the second independent operator. If you run one, you're not joining the network — you briefly *are* the network, and we'd be delighted to meet you.

## The rest of a busy two months

Since the April-era packages: full **multi-device** (QR pairing, signed device announcements, fan-out), **reactions, replies, forwarding, disappearing messages**, group admin tools, **PQXDH with ML-KEM-768**, relay hardening (rate limits, `/metrics`, hot backups, [security policy](https://github.com/twotwoonethree/meshwhisper/blob/main/SECURITY.md)), and a CLI that takes you from empty directory to encrypted messages through the live relay in under ten minutes:

```bash
mkdir my-app && cd my-app && npm init -y
npx @meshwhisper/cli init
```

Full ledger in the [changelog](https://github.com/twotwoonethree/meshwhisper/blob/main/CHANGELOG.md). Honest labelling of what's production versus promised lives in [the capability tour](/blog/what-it-does/).

[GitHub](https://github.com/twotwoonethree/meshwhisper) · [Getting started](https://github.com/twotwoonethree/meshwhisper/blob/main/docs/getting-started.md) · Live demo: [prudence.meshwhisper.org](https://prudence.meshwhisper.org) · Evaluating for production? [Open an issue tagged `adoption`](https://github.com/twotwoonethree/meshwhisper/issues) — it steers the roadmap, and no sales call follows, there being nobody here to make one.
