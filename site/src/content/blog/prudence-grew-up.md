---
title: "The week Prudence stopped being a demo"
description: "Prudence could already send end-to-end encrypted messages. That's not the same as being an app you'd leave open all day. This is the unglamorous week of drafts, search, delete, export-your-data, and adding a friend by pointing your camera at their phone — the work that turns a proof into a product."
pubDate: 2026-06-13T10:00:00Z
---

*New to MeshWhisper? [Start here](/blog/what-is-meshwhisper/) — short version: end-to-end encrypted messaging for any app, through a relay that can't read a word of it. [Prudence](https://prudence.meshwhisper.org) is the reference app built on it, and the one this post is about.*

There's a gap nobody warns you about, between "it sends encrypted messages" and "it's a messenger." The first is a cryptography result. The second is two hundred small mercies — the draft that's still there when you come back, the search box that finds the thing you said on Tuesday, the message you can take back ten seconds after sending it to the wrong person. None of them are hard. All of them are the difference between a demo you clap at and an app you forget you're using, which is the highest compliment software can earn.

Prudence had the first thing for a while. This was the week it went after the second.

## The boring features, which are the whole game

Here is the unglamorous list, and I want it to be boring, because boring is the point:

- **Drafts that survive.** Half-typed a message, switched conversations, came back — it's still there. Per-conversation, persisted locally. A non-event when it works, a small betrayal when it doesn't.
- **Search.** In a thread, and across the conversation list. "Where did Kevin send me that address" is the single most common thing anyone does in a chat app, and until this week the answer was "scroll."
- **Delete a message.** Wrong window, wrong words, wrong everything — pick it, it's gone.
- **An unread badge in the tab title.** So the browser tab earns its `(1)` and you stop missing replies because Prudence was in a background tab pretending nothing happened.
- **Delivery ticks that actually advance.** Outbound messages now tick past *sent* — they correlate to their real status instead of freezing on the optimistic one. (This one was a quiet bug as much as a feature; the SDK was generating one message id while the app tracked another, and the two never met. Now they share an id. The tick moves.)
- **First-run that doesn't dump you in an empty room.** Empty states that tell you what to do, the right pane auto-opening, the niggles — Esc closes things, Enter sends, Shift-Enter doesn't — filed down.

None of these will headline a release. Together they're the reason you'd keep the tab open.

## Two that matter more than they look

A couple of things this week aren't ergonomics — they're posture.

**Export my data.** A Settings button that hands you everything Prudence holds about you, encrypted with a passphrase you choose, in a file you keep. No "request your data and we'll email it in 30 days." It's your machine; it was always your data; now there's a button that admits it. (It covers your identity and contacts today; full message-history export is the next notch, and it's [on the record as such](https://github.com/twotwoonethree/meshwhisper/blob/main/docs/adr/007-e2ee-message-backup.md).)

**Verifying a contact, in the app.** Safety numbers — the out-of-band "are you really you" check, the same idea Signal uses — are now wired into Prudence itself, not just a capability in the SDK underneath it. You can compare numbers with someone and mark them verified. Trust you can check beats trust you're asked to assume.

## The one that's a seed

And then there's adding a contact by **QR code** — point your camera at someone's phone, and you're paired. No username to type, no directory to look anyone up in, no central anything in the loop. The invite on their screen already carries everything your device needs: their key, their coordinates, the lot.

It reads like a convenience feature. It's quietly something larger. Notice what *didn't* happen when you added that contact: you didn't ask a server who they were. There was no lookup, because there was no directory to look in. The two of you exchanged cryptographic coordinates directly, out of band, the way you'd hand someone a business card.

Hold onto that, because it's the thread the [next couple of posts](/blog/what-the-relay-sees/) pull on. Once adding someone needs no central directory, a question starts to itch: if there's no directory deciding who you can reach — why should it matter which *app* they're using at all?

We'll get there. First, [let's prove the relay really can't read any of this](/blog/what-the-relay-sees/).

[Prudence](https://prudence.meshwhisper.org) · [GitHub](https://github.com/twotwoonethree/meshwhisper) · Prudence is MIT-licensed and is the living reference an adopter cribs from — [it's in the repo](https://github.com/twotwoonethree/meshwhisper/tree/main/prudence).
