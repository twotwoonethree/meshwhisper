---
title: "Messaging should work like email"
description: "Every messenger is a walled garden: WhatsApp users can't message Signal users, and that's by design, not accident. But MeshWhisper's relay can't even tell which app a packet belongs to — so the walls were never load-bearing. We tore one down. Any app, any operator, anyone-to-anyone, end-to-end encrypted. Like email, except private."
pubDate: 2026-06-15T10:00:00Z
---

*New to MeshWhisper? [Start here](/blog/what-is-meshwhisper/). This is the post where the project changed shape, so it's worth the detour first.*

Email has one quietly radical property that we've all stopped noticing because it's been true our whole lives: **anyone can email anyone.** A Gmail user emails a Fastmail user emails someone running their own mail server in a cupboard, and none of them had to be on the same service, sign up for the same app, or ask permission. The address is the protocol. The providers are interchangeable. Nobody owns the network.

Now look at messaging, which arrived twenty years later and somehow went *backwards*. WhatsApp users cannot message Signal users. Signal users cannot message Telegram users. Every messenger is an island, and the moats aren't accidental — they're the asset. The whole point of locking your friends inside an app is that they can't leave without leaving each other. That's not a technical limitation. It's a business model wearing a technical limitation's clothes.

MeshWhisper started life on the wrong side of that line too — and then we noticed we'd accidentally built the cure and labelled it a safety feature.

## The wall that wasn't holding anything up

From [day one](/blog/what-is-meshwhisper/), MeshWhisper kept apps **isolated**: App A's users couldn't message App B's, even though both ran on the same protocol, even through the same relay. We had good reasons. Isolation keeps each app a clean island, sidesteps the global-spam-and-identity governance swamp, and lets an adopter reason about their own users without the whole internet showing up.

But here's the thing we kept telling everyone — the thing the [last post](/blog/what-the-relay-sees/) let you *see* — and somehow didn't apply to ourselves: **the relay can't read anything, and it can't even tell which app a packet belongs to.** It forwards opaque blobs by a routing hash that's cryptographically derived. A packet for a fitness app and a packet for a marketplace are, on the wire, indistinguishable noise.

So what, exactly, was the wall made of?

It wasn't in the relay — the relay was already app-blind. It wasn't in the cryptography — the identity keys were already global, not scoped to an app. The isolation lived in *one place*: the sending side, choosing not to address a message into another app's namespace. The wall wasn't a wall. It was a *decision not to walk through a door that had no lock.*

That was the eureka, and it arrived with the slightly deflating quality the best ones have — not "we can build this" but "we appear to have already built this and then carefully not used it." If the relay doesn't care which app you're in, then app A, app B, operator X, and operator Y are all just the same pipe. The gardens were walled by convention. And conventions you can change in an afternoon.

## So we walked through the door

We made interoperability a real, opt-in capability — one flag, `interop`, off by default. Flip it on, and two things happen automatically, in both directions:

- when you pair with someone, your apps exchange their namespace identities as part of the normal handshake — no manual wiring;
- from then on, each side addresses the other into the right namespace, and the messages just... arrive. End-to-end encrypted the entire way, same as ever.

Then we pushed it as far as it goes. Two people, in **different apps**, homed on **different operators' relays**, federated together — a real encrypted message crossing *both* boundaries at once. Different app, different operator, delivered and decrypted.

The punchline on the engineering: crossing the operator boundary needed **zero new code.** Federation already forwarded opaque packets between relays. Interop already addressed into the other person's namespace. The two just *composed* — because both were built on the same honest foundation of "the relay handles blobs it can't read." We didn't build the email model so much as discover we'd been holding all the pieces.

(One thing genuinely needed to work: the X3DH key-exchange handshake had to be addressed across the boundary too, not just the messages. Address the data but not the handshake and the recipient never forms a session — the message arrives and silently refuses to decrypt. Found it, fixed it, wrote it down. The crypto itself didn't change; it never cared about app boundaries to begin with.)

## Why this is the most important thing we've done

Every messenger fights the same cold-start war: your app is worthless until your friends are on it, and your friends won't come until it's worth it. The walls *cause* the problem they pretend to solve.

Interop inverts it. Adopt MeshWhisper and your users can reach the *entire federated network* from day one — not just the people who downloaded your particular app. The way a new email provider's customers can email the whole world on signup, not just other customers of the same provider. The network effect stops being a moat someone else owns and starts being a tailwind everyone shares.

It's also the truest version of what this project is *for*. An open protocol that nobody owns can't be bought, enshittified, or quietly turned against its users — there's no "it" to acquire. Walled gardens are acquirable by definition; that's what the wall is *for*. Tear it down and there's nothing left to buy. (The regulators are circling the same conclusion from the other direction — the EU's DMA is busy *mandating* messaging interop. We'd just rather arrive on principle than on summons.)

## The honest trade, and the one hard part left

This isn't magic, and we're not going to pretend it is.

**We gave something up to get here.** You can message anyone you've *exchanged an invite or introduction with* — scanned their code, followed their link, been introduced through someone you both trust. What you can't do is type a stranger's global handle and cold-message them out of nowhere. That capability requires a central directory mapping names to people — DNS, or a blockchain, or a company — and a central directory is exactly the seizable choke point this whole project exists to refuse. So we made the trade on purpose: **un-seizable, registrar-free identity, in exchange for stranger-by-handle discovery.** Email's `@domain` buys you stranger discovery by renting your identity from DNS. We don't want to rent. (The full reasoning, including a detour through [Zooko's Triangle](https://en.wikipedia.org/wiki/Zooko%27s_triangle), is in [ADR-009](https://github.com/twotwoonethree/meshwhisper/blob/main/docs/adr/009-decentralized-addressing.md).)

And there was **one hard part left over**, which is the best kind of cliffhanger because it's real. To deliver a message across the federation, a relay still has to *find* the relay that homes the person you're reaching. And the way it found it was... a domain name. A `wss://` URL. DNS — the one central, seizable thing we'd spent the entire project removing from everywhere *else*, sitting smugly in the routing layer the whole time.

We'd built the email model. And then we'd left in the exact piece of email we'd spent years swearing never to copy.

[That's the next post.](/blog/dns-free-relay-location/)

[GitHub](https://github.com/twotwoonethree/meshwhisper) · [ADR-009 — the email model](https://github.com/twotwoonethree/meshwhisper/blob/main/docs/adr/009-decentralized-addressing.md) · [Federation spec](https://github.com/twotwoonethree/meshwhisper/blob/main/docs/federation.md)
