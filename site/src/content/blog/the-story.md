---
title: "It started, as these things do, with a text at midnight"
description: "The origin story: two lads, one late-night conversation, two PRDs written simultaneously by accident, and a working prototype before anyone had the sense to go to bed."
pubDate: 2026-06-12T10:00:00Z
---

There's a category of project that begins with a business plan, a market analysis, and a slide deck. This is not one of those. MeshWhisper began as a late-night text conversation between myself (Anton) and Kevin Collins, in which I proposed an end-to-end encrypted peer-to-peer messaging protocol, wrote up a PRD, and sent it over — only to discover Kevin had been drafting his own PRD *from the same conversation, at the same time, without either of us mentioning it*. Which tells you everything about the kind of people involved. He merged the two documents and roughly thirty minutes later a prototype existed. Not a *good* prototype — a long way from usable — but running code, at an hour when sensible people are asleep.

The first commit landed at **00:18 on the 10th of April 2026**. Twenty-seven files, 11,693 lines, the entire protocol sketched end-to-end in one go: X3DH, Double Ratchet, packet framing, transports, routing, relay logic, namespace isolation. If that sounds impressive, it was — as a sketch. As a product it was unusable. No persistence (restart the app, lose everything), no relay server you could actually deploy, no browser support, no push notifications, no post-quantum layer, and a single solitary test file sitting there like a participation medal.

Nobody did a feasibility study. There was a weird idea — *what if the infrastructure couldn't read the messages, and therefore any infrastructure could carry any app's messages* — and the only honest way to find out if it worked was to build it and see. For the craic, initially. The craic escalated.

## The unglamorous middle

What followed is the part that never makes it into origin stories, because it's months of turning an impressive sketch into something that survives contact with real devices. Real devices restart. Real networks drop. Real browsers refuse to do things the spec assumed they would. A partial list of the distance travelled:

- **Persistence**, so an identity survives a page reload — table stakes, and the prototype didn't have it
- A **standalone relay node** with SQLite durability, instead of "the relay is a function somewhere in the SDK"
- **PQXDH and ML-KEM-768**, because "post-quantum" was in the pitch and ought to be in the code
- A **push pipeline** that wakes a phone without telling Apple or Google anything (the wake signal is content-free; the device fetches and decrypts locally)
- **Tests that caught what code review missed** — including an OPK derivation mismatch and, to our lasting embarrassment, a `Math.random` where a cryptographic RNG was required. The test count went from one file to several hundred tests, and every single one earned its place by failing at some point
- **Multi-device**, **group messaging**, **encrypted media**, **an encrypted archive** the relay stores but cannot open
- And the discipline of **deferring the speculative bits** — sybil resistance, social-graph routing — that were designed in night one's enthusiasm but hadn't yet earned the right to be load-bearing

The original repository is preserved in git history, partly for honesty and partly because it's funny.

## The idea grew up; the principle didn't change

Along the way the project had to make peace with reality in a few places, and we've tried to do it in public. Phones turn out to be terrible mesh relays (operating systems kill background radios; app stores have opinions), so the mesh became a [mesh of *nodes*](https://github.com/twotwoonethree/meshwhisper/blob/main/docs/adr/001-adoption-driven-mesh.md) — every developer who adopts the SDK deploys one, and the nodes [federate openly](https://github.com/twotwoonethree/meshwhisper/blob/main/docs/federation.md). "Serverless" became the more honest "serverless *for you, the developer*" — somebody runs a node; it's a €4 process, and it still can't read anything. And the peer-to-peer dream came back around in a form that actually ships: devices on the same network now [deliver to each other directly](/blog/meshwhisper-0-3/), and conversations survive the relay dying entirely.

The principle that survived from that first midnight conversation, fully intact: **the thing in the middle should not need to be trusted, because the thing in the middle cannot read anything**. Everything else — federation, multi-device, the LAN mesh, the relay's whole feature set — is that one idea, applied repeatedly, by people who probably should have been asleep.

If you want the formal version of all this, the [whitepaper](https://github.com/twotwoonethree/meshwhisper/blob/main/docs/whitepaper.md) has it with the jokes removed. Mostly removed.
