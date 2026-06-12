---
title: "What is MeshWhisper? (or: the postman who can't read)"
description: "The whole idea in one sitting: end-to-end encrypted messaging for any app, through infrastructure that couldn't read your messages if it wanted to. Which it doesn't. It's a pipe."
pubDate: 2026-06-12T09:00:00Z
---

Every app eventually needs messaging. The fitness app wants athletes talking to coaches, the marketplace wants buyers haggling with sellers, and the developer building either of them wants to lie down in a dark room, because the options are all bad.

You can **build it yourself** — WebSocket servers, offline queues, push notifications, media handling. Each of those is a project. Together they're a career. You can **pay for it** — Sendbird starts at $349 a month and scales in the direction of "ring us for pricing", which is never a phrase that precedes good news. Or you can **bolt it onto Firebase**, where it's free right up until it isn't, and every message your users send passes through Google's infrastructure in readable form, which your privacy policy will describe using very careful sentences.

All three options share one assumption: that a server must *understand* a message in order to deliver it. It must know who you are, who you're talking to, and — in readable-form land — what you said.

MeshWhisper is what you get when you refuse the assumption.

## The postman who can't read

If a message is encrypted before it leaves the sender's device, then the thing in the middle is just a pipe. It receives an opaque blob, looks at a routing hash, and passes the blob along. It cannot read the content. It doesn't need to. That's not a feature we added — it's the whole architecture. The relay is a post box, not a postman. Actually it's worse than that for anyone hoping to snoop: it's a postman who can't read, doesn't know your name, and forgets your house the moment he's left it.

Concretely, MeshWhisper is two pieces:

- **An SDK** (`@meshwhisper/sdk`) you embed in your app. It does the cryptography on the device — PQXDH key exchange, Double Ratchet, the same family of mathematics Signal uses, plus a post-quantum layer because some of us would like our messages to stay private after the physicists are done showing off.
- **A node** (`@meshwhisper/node`) you run yourself. One Docker container. It relays packets, queues messages for offline devices, fires content-free push notifications, stores encrypted media it can't open, and runs a username directory. About €4 a month of VPS does it.

Your node serves your app. You operate it, you set its rules, nobody between your users and their messages but you — and *you* can't read them either. When the subpoena arrives, you hand over ciphertext and an apologetic shrug. This isn't a compliance posture. It's arithmetic.

## Relay promiscuously, connect selectively

Here's the bit we're actually proud of. Because the relay can't read anything, the relay for one app is *identical* — in every technical respect — to the relay for any other app. A node forwarding encrypted packets for a fitness app is indistinguishable from one forwarding for a marketplace. So why shouldn't they forward for each other?

That's the protocol's one commandment: **relay promiscuously, connect selectively**. At the transport layer, every node forwards encrypted packets regardless of whose they are. At the session layer, your app only ever decrypts messages belonging to its own namespace — which is derived cryptographically, so a relay can't even tell which app a packet belongs to, never mind read it.

Nodes [federate openly](https://github.com/twotwoonethree/meshwhisper/blob/main/docs/federation.md): any relay that completes a cryptographic handshake can join the mesh and start forwarding. And as of recently, devices on the same network skip the relay entirely and deliver to each other directly — which means your conversations [keep working when the relay is down, or the internet is gone altogether](/blog/meshwhisper-0-3/).

## What it costs

Self-hosting is free, forever — the whole thing is MIT-licensed. The running cost is your VPS. There's no hosted tier, no usage meter, no token, and no growth team planning your pricing cliff. We're aware this is a terrible business model. It's a deliberate one: the project's bet is that messaging should be infrastructure, like the road outside your house, and you don't pay Sendbird for the road.

## Where to go next

- [The story of how this started](/blog/the-story/) — late-night texts and a prototype that existed before the conversation ended, more or less
- [What it actually does](/blog/what-it-does/) — the capability tour
- [Who it's for](/blog/who-its-for/) — doctors, ships, robots, and the justifiably paranoid
- Or skip the reading: `npx @meshwhisper/cli init` and you'll have encrypted messages flowing inside ten minutes. The [getting-started guide](https://github.com/twotwoonethree/meshwhisper/blob/main/docs/getting-started.md) has the long version.
