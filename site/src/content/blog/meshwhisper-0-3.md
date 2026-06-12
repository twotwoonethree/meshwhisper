---
title: "MeshWhisper 0.3: E2EE messaging that survives losing its own infrastructure"
description: "Open relay federation, full multi-device, and peer-to-peer LAN delivery that keeps conversations alive when the relay — or the internet — is gone. Self-hostable, MIT-licensed, one Docker container."
pubDate: 2026-06-12
---

MeshWhisper is an MIT-licensed SDK and relay for adding end-to-end encrypted messaging to any app. The pitch has always been structural rather than promissory: the relay routes opaque blobs by unlinkable destination hashes, so the operator *cannot* read messages — not as a policy, by design. You self-host the relay (one Docker container, ~€4/month of VPS), or use the Foundation's public-good node while you're developing.

The last two releases turned that from a single-relay story into something more interesting. Three things shipped that we think are worth your attention.

## 1. Conversations that survive losing the relay

As of 0.3.0, two devices on the same network exchange messages **peer-to-peer**. The SDK's LAN bearer discovers peers on the subnet, connects them directly, and dual-sends every outbound message — offered to connected LAN peers *and* sent via the relay, deduplicated at the receiver. The consequence falls out of the design:

> Once two peers have established a session, their conversation no longer depends on any infrastructure. Kill the relay, unplug the router from the internet — messages keep flowing, end-to-end encrypted.

There is no offline mode and no mode switch. Application code just calls `send()`; degradation and recovery are silent. The [local-first example](https://github.com/twotwoonethree/meshwhisper/tree/main/examples/local-first) demonstrates it two ways: a human chat, and a sensor fleet emitting encrypted telemetry that keeps arriving at its monitor after the relay is killed mid-run.

This makes isolated networks a supported deployment, not a hack: factory floors, ships, clinics, air-gapped offices. Run a relay on a Raspberry Pi on the LAN for bootstrap and offline queueing — nothing ever touches the internet — and live conversations don't even depend on the Pi. The deployment guide is [docs/local-networks.md](https://github.com/twotwoonethree/meshwhisper/blob/main/docs/local-networks.md). Cloud messaging products structurally can't follow you here; they are clients for someone else's servers.

Privacy on the LAN keeps the same shape as everywhere else in the protocol: packets are offered promiscuously to every local peer, but only the addressee can recognize theirs (unlinkable destination hashes, ratchet-encrypted payloads), and discovery beacons are random per-session — a device on your network learns that MeshWhisper devices exist, not who is talking to whom.

## 2. Open relay federation

Relays now peer with each other and forward packets across operators. We initially specified allowlist-only peering — both operators exchange pubkeys before connecting — and discarded it almost immediately: bilateral ceremonies scale O(n²) and make the mesh a product of negotiation instead of a side effect of adoption.

So federation is **open by default posture**: any relay that completes the mutual Ed25519 handshake is admitted. The security boundary is per-peer rate limiting, hop caps, packet deduplication, and a reactive blocklist — not pre-approval. Peers have stable cryptographic identities; a misbehaving one gets blocklisted, and it never could read content in the first place.

Joining the mesh is one environment variable and one bootstrap entry:

```
FEDERATION_MODE: "open"
```

```json
{ "peers": [{ "pubkey": "34904664…ce23", "url": "wss://relay.meshwhisper.org" }] }
```

The Foundation relay runs open mode and accepts peers today. The wire protocol is specified in [docs/federation.md](https://github.com/twotwoonethree/meshwhisper/blob/main/docs/federation.md). And in the spirit of saying the quiet part: the *mechanism* is live, but the mesh currently has one node. The honest milestone we're working toward is a second independent operator. If you run one, you are it.

## 3. The boring-but-load-bearing rest

Since the last published release (April), the SDK and relay also gained:

- **Multi-device** — Signal-style linked devices: QR pairing, signed device announcements, message fan-out to all of an account's devices
- **Messenger-grade features** — reactions, quoted replies, forwarding, disappearing messages, group management (rename, add/kick members, admin transfer)
- **Post-quantum session establishment** — PQXDH with ML-KEM-768 alongside X3DH and the Double Ratchet
- **Relay hardening** — per-IP and per-federation-peer rate limiting, Prometheus `/metrics`, hot backups, a [security policy](https://github.com/twotwoonethree/meshwhisper/blob/main/SECURITY.md)
- **A real scaffold** — `npx @meshwhisper/cli init` writes a working SDK skeleton plus a complete node deployment (Compose, generated Web Push keys, federation bootstrap). The generated terminal chat exchanges an E2EE message through the live relay in under two minutes from an empty directory.

## What this is, and isn't

It's worth being precise, because "P2P E2EE messaging" is a phrase that overpromises by default.

The **E2EE is unconditional**: PQXDH + Double Ratchet, encryption on-device, no transport — relay, LAN peer, federation peer — is ever trusted with anything but ciphertext and timing. The **peer-to-peer part is tiered and honest**: LAN delivery is shipped; proximity radio (Multipeer/Nearby) and direct internet paths (WebRTC) are [specified](https://github.com/twotwoonethree/meshwhisper/blob/main/docs/p2p-transport.md) with the same opportunistic-upgrade semantics, and gated on demand rather than built speculatively. The relay remains the reliability floor everywhere — a direct path can make delivery faster or cheaper, never less reliable.

There is no token, no company between your users and their messages, and no hosted tier to upsell you to. The model is: you run a node, your node serves your app, and — if you choose — it forwards packets for everyone else's, the way the internet was supposed to work.

## Try it

```bash
mkdir my-app && cd my-app && npm init -y
npx @meshwhisper/cli init
```

[GitHub](https://github.com/twotwoonethree/meshwhisper) · [Getting started](https://github.com/twotwoonethree/meshwhisper/blob/main/docs/getting-started.md) · [Whitepaper](https://github.com/twotwoonethree/meshwhisper/blob/main/docs/whitepaper.md) · Live demo PWA: [prudence.meshwhisper.org](https://prudence.meshwhisper.org)

If you're evaluating MeshWhisper for production, [open an issue tagged `adoption`](https://github.com/twotwoonethree/meshwhisper/issues) — adoption reports directly shape what gets built next. No sales call follows; there is no sales team to call you.
