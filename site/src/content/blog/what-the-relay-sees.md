---
title: "What the relay sees (we built a button to show you)"
description: "The whole pitch is that the relay can't read your messages. That's a claim. So we added a button that puts your plaintext next to the exact encrypted blob the relay actually receives — same screen, no trust required. Tap a message, see the ciphertext."
pubDate: 2026-06-14T10:00:00Z
---

*New to MeshWhisper? [Start here](/blog/what-is-meshwhisper/) — the one-line version is "the relay is a postman who can't read." This post is about proving that sentence instead of just asserting it.*

Every encrypted messenger makes the same promise — *we can't read your messages* — and asks you to take it on faith. Faith in an architecture diagram, a whitepaper, an audit you didn't commission. The promise is usually true. It's just never *shown* to you, because showing it is awkward: the proof lives down in the bytes, and apps work hard to keep you away from the bytes.

We decided the bytes were the best demo we had.

## Tap a message, see what the relay got

There's now a button in [Prudence](https://prudence.meshwhisper.org). Tap one of your own messages and it shows you two things, side by side:

- on the left, the plaintext you typed;
- on the right, the actual encrypted payload the relay received — a hex blob, the literal bytes on the wire — under the line *"relay.meshwhisper.org stores and forwards this. It can't decrypt it, and even the address rotates every hour."*

That's it. No animation standing in for the real thing, no representative sample. The blob on the right is the *exact* payload that left your device for that message. The relay has that blob and nothing else. You're looking at its entire view of your conversation.

It is, frankly, an anticlimax to look at — a wall of hex that does nothing — and the anticlimax is the message. *This* is what the postman holds. He cannot read it. You can see that he cannot read it.

## Why this needed honest plumbing

Here's the part I'm a little proud of, because it's the part it would have been easy to fake.

The tempting shortcut is to show the *decrypted* message and label it "what the relay sees." It would look identical to a casual eye and it would be a lie — the relay never sees plaintext — and a lie in the one demo whose entire reason for existing is to prove we're not lying. So we didn't.

The encrypted bytes are formed deep inside the SDK's send path, the moment before a packet goes to the relay: the ratchet header and ciphertext concatenated, wrapped with a routing hash. The app, sitting on top, never normally sees them. To show them truthfully we added a small, deliberate hook to the SDK — `onCiphertext` — that fires once per sent message and hands the app *the real on-wire bytes*: the ciphertext, the rotating destination hash, and the plaintext's length. Nothing else. No keys, no plaintext beyond a byte count — the hook can only ever expose what the relay already has, which is the whole point. It's safe by construction: it reveals nothing you didn't already hold on your own device.

Prudence catches those bytes, remembers them against the message, and shows them when you tap. The design — and exactly why we rejected the easier, dishonest versions — is written down in [ADR-008](https://github.com/twotwoonethree/meshwhisper/blob/main/docs/adr/008-ciphertext-peek-transparency-hook.md) if you want the receipts.

## Transparency as a feature, not a footnote

Most security properties are invisible by design, and invisibility is corrosive to trust — you end up believing a brand instead of a fact. A claim you can inspect is a different kind of claim. We'd rather hand you the hex and let you check than ask you to trust the diagram.

There's also a self-imposed discipline in it. A team that ships a "here's exactly what the server sees" button can't quietly start sending the server more than it admits — the button would show it. The honest demo keeps *us* honest too.

So: the relay can't read your messages. Don't take our word for it. Tap a message.

And now that you've seen the relay is just a dumb pipe carrying opaque blobs — here's the thought that pipe led us to, the one that reorganized the whole project: [if the relay can't tell whose messages it's carrying, why are different apps walled off from each other at all?](/blog/messaging-like-email/)

[Prudence](https://prudence.meshwhisper.org) — try the peek yourself · [GitHub](https://github.com/twotwoonethree/meshwhisper) · [ADR-008](https://github.com/twotwoonethree/meshwhisper/blob/main/docs/adr/008-ciphertext-peek-transparency-hook.md)
