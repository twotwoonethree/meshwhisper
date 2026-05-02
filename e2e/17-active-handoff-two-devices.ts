// Scenario: Alice signs in on Device A and exchanges messages with Bob,
// then signs in on Device B (different profile) WHILE Device A is still
// open. Where does Bob's next message land — A, B, or both? Where do
// messages alice sends from each device end up on the other?
//
// Tests our hand-off model. The current SDK is content-blind to which
// device is "active"; whichever happens to drain the relay queue first
// will get the message. Important to characterise the actual behaviour.

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

  // Send from device A; can device B see it? (Tests cross-device sync via archive.)
  console.log('--- alice on A sends "from-A" ---');
  await sendMessage(alice, 'from-A');
  try { await waitForMessage(bob, 'from-A', 15_000); console.log('  ✓ bob received from-A'); }
  catch { console.log('  ✗ bob did NOT receive from-A'); pass = false; }
  // Wait for archive push then check device B.
  await alice.page.waitForTimeout(8000);
  try { await waitForMessage(aliceOnB, 'from-A', 5_000); console.log('  ✓ device B saw "from-A" via archive sync'); }
  catch { console.log('  – device B did NOT see "from-A" — cross-device archive sync not working'); }

  // Send from device B; can device A see it?
  console.log('--- alice on B sends "from-B" ---');
  await sendMessage(aliceOnB, 'from-B');
  try { await waitForMessage(bob, 'from-B', 15_000); console.log('  ✓ bob received from-B'); }
  catch { console.log('  ✗ bob did NOT receive from-B'); pass = false; }
  await aliceOnB.page.waitForTimeout(8000);
  try { await waitForMessage(alice, 'from-B', 5_000); console.log('  ✓ device A saw "from-B" via archive sync'); }
  catch { console.log('  – device A did NOT see "from-B" — cross-device archive sync not working'); }

  console.log('alice@A sees:', await readMessages(alice));
  console.log('alice@B sees:', await readMessages(aliceOnB));
  console.log('bob    sees:', await readMessages(bob));

  await closeAll(alice, aliceOnB, bob);
  process.exit(pass ? 0 : 1);
})().catch((err) => { console.error('FAIL:', err); process.exit(1); });
