// Scenario: Alice signs in on Device A and exchanges messages with Bob,
// then signs in on Device B (different profile) WHILE Device A is still
// open. Characterises the current hand-off semantics:
//
//   - Device B re-handshakes every contact on sign-in. Bob now has a
//     fresh session keyed for Device B. Bob's subsequent messages are
//     decryptable by B (which has the new session) but not by A (whose
//     session is now stale).
//   - Device A's outbound sends will use its now-stale session and
//     fail to decrypt at Bob. From the user's perspective, A is dead.
//   - Cross-device archive sync of own-sends is debounced (5s) and
//     only takes effect on the other device's next sign-in or pull.
//
// Last-device-signed-in wins. Linked-devices (Signal-style) is the
// proper fix for true simultaneous multi-device — this test exists
// to characterise the limit of the current model.

import {
  newUser, register, aliceAddContact, acceptIncomingRequest,
  openConversation, sendMessage, waitForMessage, newDeviceSignedIn,
  snap, closeAll, readMessages,
} from './lib.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

(async () => {
  const aliceB = mkdtempSync(join(tmpdir(), 'p-aliceB-'));

  const alice = await newUser('alice');
  const bob = await newUser('bob');

  await register(alice);
  await register(bob);
  console.log('alice =', alice.username);
  console.log('bob   =', bob.username);

  await aliceAddContact(alice, bob.username);
  await acceptIncomingRequest(bob);
  await openConversation(alice, bob.username);
  await openConversation(bob, alice.username);

  await sendMessage(alice, 'baseline');
  let pass = true;
  try { await waitForMessage(bob, 'baseline', 15_000); console.log('  ✓ baseline'); }
  catch { console.log('  ✗ baseline missed'); pass = false; }

  // Wait for archive push.
  await alice.page.waitForTimeout(8000);

  console.log('--- alice opens Device B (still signed in on A) ---');
  const aliceOnB = await newDeviceSignedIn('alice@B', aliceB, alice.username, alice.password);
  await aliceOnB.page.waitForTimeout(4000);
  await openConversation(aliceOnB, bob.username);
  await snap(aliceOnB, '17-aliceB-after-signin');

  // Send from Bob and check both devices.
  console.log('--- bob sends "to-both" ---');
  await sendMessage(bob, 'to-both');

  let onA = false, onB = false;
  try { await waitForMessage(alice, 'to-both', 10_000); onA = true; console.log('  ✓ device A received'); }
  catch { console.log('  – device A did NOT receive'); }
  try { await waitForMessage(aliceOnB, 'to-both', 10_000); onB = true; console.log('  ✓ device B received'); }
  catch { console.log('  – device B did NOT receive'); }

  if (!onA && !onB) { console.log('  ✗ NEITHER device received the message'); pass = false; }

  // Send from device A. Device A's session is now stale (B's
  // re-handshake replaced it), so this should NOT reach Bob.
  console.log('--- alice on A sends "from-A" (expected to be silently dropped — A is stale) ---');
  await sendMessage(alice, 'from-A');
  try {
    await waitForMessage(bob, 'from-A', 8_000);
    console.log('  – bob unexpectedly received from-A — old device A still works?');
  } catch {
    console.log('  ✓ bob did NOT receive from-A (expected: device A is stale after B re-handshaked)');
  }

  // Send from device B; should reach Bob normally.
  console.log('--- alice on B sends "from-B" ---');
  await sendMessage(aliceOnB, 'from-B');
  try { await waitForMessage(bob, 'from-B', 15_000); console.log('  ✓ bob received from-B'); }
  catch { console.log('  ✗ bob did NOT receive from-B'); pass = false; }

  console.log('alice@A sees:', await readMessages(alice));
  console.log('alice@B sees:', await readMessages(aliceOnB));
  console.log('bob    sees:', await readMessages(bob));

  await closeAll(alice, aliceOnB, bob);
  process.exit(pass ? 0 : 1);
})().catch((err) => { console.error('FAIL:', err); process.exit(1); });
