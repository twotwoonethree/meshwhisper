---
title: "The flaky test was telling the truth"
description: "A delete-and-re-add test failed about one run in eight under load. The tempting fix was a bigger timeout. The real fix was a bug: a single stray packet could make the SDK re-handshake — and silently destroy — a perfectly healthy session."
pubDate: 2026-06-16T15:00:00Z
---

*New to MeshWhisper? [Start here](/blog/what-is-meshwhisper/). This one's an engineering post — a bug hunt with a moral.*

There's a particular kind of test failure that everyone has learned to ignore: the one that passes nineteen times and fails the twentieth, always under load, always at a timeout. The reflex is to bump the timeout and move on. Most of the time that's correct, because most of the time the test is just impatient.

We had one of these. A reconnect test models the canonical bad day: Alice adds Bob, deletes him, re-adds him, and they keep chatting. It failed roughly one run in eight — but only when the machine was busy — always on the last line: *"Alice never received Bob's reply."* The honest thing was to find out whether the test was impatient or right before silencing it. It was right.

## Reproduce it on purpose

In isolation the test passed every time. So the first job was to make it fail *reliably*, which meant making the machine miserable: a background loop spinning up relay processes continuously while the reconnect test ran in a tight loop on top of it. Under that, it failed about a third of the time — reliable enough to study.

The symptom in the logs was a decryption failure: *"no session matched."* Alice received Bob's reply and couldn't decrypt it. But Bob had clearly succeeded in decrypting Alice's message a moment earlier — he replied to it — which meant the key agreement had worked. The two of them had agreed on keys and then *disagreed* about them, after the fact. That's a strange thing for a ratchet to do.

## Don't theorize. Print.

It's tempting, with a crypto race, to reason your way to the answer. Don't; the state space is too big and the intuitions are too confident. We added one gated debug line that logged every write to a session's ratchet state — the sending message number, whether the sending chain existed — and ran the torture loop until it caught one.

The capture was unambiguous. On healthy runs, Alice's session for Bob advanced normally: send number 1, 2, 3. On the failing run it went 1, 2, 3 — and then **reset to a fresh zero.** Her perfectly good, mid-conversation session had been wiped and replaced with a brand-new handshake. Bob's reply was encrypted against the session that *used* to exist. Of course it didn't match: Alice had thrown it away.

The next question answered itself. What resets a session to zero? A re-handshake. And what triggers a re-handshake? A failed decryption. MeshWhisper, like any sensible ratchet implementation, tries to self-heal: if a packet won't decrypt, maybe the session is broken, so re-establish it. Reasonable. Except in a churny moment — a delete, a re-add, packets draining out of order from the relay — a relay receives the occasional packet it genuinely can't place: a duplicate, something from an old ratchet step, a leftover from a session that was deleted. Each one looked, to the recovery logic, like "this session is broken, fix it." So it "fixed" a session that was working perfectly, and in doing so, broke it. The cure was the disease.

## The fix is a refusal

The recovery instinct wasn't wrong; its trigger was. A single packet you can't decrypt is the *weakest possible* evidence that a particular session is broken — it might not even be from that session. So the rule is now a refusal: **a stray decryption failure may not tear down a session that can still send.** If a session has a live sending chain, it's working; an unplaceable packet doesn't get to nuke it.

That sounds like it would defeat the point of recovery, and it would, if it were the only signal. It isn't. Sessions that are *genuinely* broken get caught by the session-health ping — a deliberate round-trip that times out when the other side really can't talk back. That path is authoritative, and it still re-handshakes with full force. We kept the strong signal and ignored the noisy one.

Twenty out of twenty under the same torture load that used to fail one in eight. Full suite green.

## The moral, which is older than this bug

This started as "harden a flaky test" and ended as a one-line guard on a real correctness bug — one that, in the wild, would have shown up as the worst possible symptom for a messenger: *a message that simply never arrives*, no error, no retry prompt, on a delete-and-re-add path that real people actually hit. It had been sitting behind a test we were one impatient afternoon away from silencing with a bigger timeout.

So: reproduce it on purpose, print the state instead of guessing at it, and verify the fix under the exact conditions that exposed the problem. And give the flaky test the benefit of the doubt for one afternoon. Sometimes it's impatient. Sometimes it's the only thing in the building telling you the truth.

[GitHub](https://github.com/twotwoonethree/meshwhisper) · the fix is a [seventeen-line guard](https://github.com/twotwoonethree/meshwhisper/blob/main/src/sdk/session-manager.ts); the test that caught it lives in `tests/reconnect.test.ts`.
