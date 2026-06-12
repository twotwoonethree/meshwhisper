---
title: "What it actually does: a tour of the box"
description: "The capabilities, honestly labelled: what's production, what's shipped-but-young, and what's a designed promise. No roadmap items wearing a trenchcoat pretending to be features."
pubDate: 2026-06-12T11:00:00Z
---

A recurring sin of infrastructure projects is the capability list where half the entries are aspirations in a trenchcoat. So here's the tour of MeshWhisper with everything labelled honestly: what you can build on today, what's shipped but young, and what's a written-down promise. (New here? [Start with what MeshWhisper is](/blog/what-is-meshwhisper/).)

## The cryptographic core — production

Sessions are established with **PQXDH** — the X3DH handshake plus **ML-KEM-768**, so a recording of today's traffic doesn't become readable when quantum computers stop being a fundraising slide. Messages then flow through the **Double Ratchet**: every message gets a fresh key, compromise of one reveals nothing before it and heals after it. Encryption happens on the device; the relay sees ciphertext, routing hashes, and nothing else. **Safety numbers** let users verify each other out-of-band, same as Signal.

This is the part where we don't do jokes. The crypto is built on the @noble libraries, the design choices are documented, and the honest caveat is stated where you'd want it stated: it has not yet had an external audit. It's on the list, and the list is public.

## The messaging feature set — production

Everything you'd expect from a messenger, because your users expect it and your app shouldn't have to build it:

- Direct messages and **group messaging** (invites, add/kick members, admin transfer, admin-less groups, renames)
- **Reactions, quoted replies, forwarding, disappearing messages**
- Delivery and read receipts, typing indicators, presence
- **Encrypted media** — files encrypt on-device; the node stores a blob it cannot open, and the key travels inside the message channel
- **Push notifications** that preserve E2EE: the node fires a content-free wake signal via APNs/FCM/Web Push, the device wakes, fetches, and decrypts locally. Apple and Google deliver an empty doorbell ring
- **Offline delivery** — the node queues encrypted blobs for thirty days, so a fortnight's holiday doesn't eat your inbox
- **Usernames** with a per-app ownership policy: yours-until-you-cryptographically-sign-it-away by default, looser if your app prefers

## Multi-device and recovery — shipped, edges still being filed

Link a laptop to a phone by scanning a QR code; messages fan out to all of an account's devices, and devices announce and revoke each other with signed announcements. An **encrypted archive** (which the relay stores and cannot read) brings contacts and history to a fresh device, and peers can replay conversation history to each other — with consent — when someone's device meets a swimming pool. Known gap, stated plainly: a message you send from one of your devices doesn't yet appear on your others. It's on the public backlog.

## The network layer — shipped, awaiting company

- **Open federation**: relays peer over a mutual cryptographic handshake and forward packets for each other. One env var and one bootstrap entry joins the mesh. Mechanism: live. Mesh: currently one node, which is a lonely sort of mesh, and we [say so](/blog/meshwhisper-0-3/)
- **LAN peer-to-peer**: devices on the same network deliver directly — conversations survive the relay dying, the internet vanishing, or both. This makes [air-gapped deployments a supported configuration](https://github.com/twotwoonethree/meshwhisper/blob/main/docs/local-networks.md), including machine-to-machine
- Proximity radio (Bluetooth/Multipeer/Nearby) and direct internet paths: **specified, not built** — [the spec](https://github.com/twotwoonethree/meshwhisper/blob/main/docs/p2p-transport.md) exists so you know what you'd be joining; the build waits for someone to actually need it

## The operational stuff nobody tweets about

A node is one Docker container with per-IP rate limiting on every endpoint, Prometheus metrics, hot SQLite backups, a health endpoint, and a [security policy](https://github.com/twotwoonethree/meshwhisper/blob/main/SECURITY.md). `npx @meshwhisper/cli init` scaffolds the entire deployment — compose file, generated push keys, federation bootstrap — plus a working SDK skeleton for your app. There's a `doctor` command for when you're sure it's broken and it's actually DNS.

## Seven reference codebases

Because documentation lies and code doesn't: a complete PWA messenger ([Prudence](https://prudence.meshwhisper.org) — try it now), an LLM support bot, a compliance/supervision pattern, a customer-service ticket flow, multi-device pairing, phone/email verification, and [local-first on-site comms](https://github.com/twotwoonethree/meshwhisper/tree/main/examples/local-first) where a sensor fleet keeps reporting after you kill the relay. Each one is a living reference an adopter can crib from wholesale.

The full API surface is in the [reference](https://github.com/twotwoonethree/meshwhisper/blob/main/docs/api.md). Or just scaffold it and poke around — it's faster than reading me describe it.
