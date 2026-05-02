// Scenario: Alice signs in on Device A and exchanges messages with Bob.
// Then she opens a fresh browser context (Device B) and signs in with
// the same username + password. Archive should restore her conversation
// list and message history. New messages from Bob should arrive on
// Device B.

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

  console.log('--- exchange a few messages on device A ---');
  await sendMessage(alice, 'A-1');
  await waitForMessage(bob, 'A-1');
  await sendMessage(bob, 'B-1');
  await waitForMessage(alice, 'B-1');
  await sendMessage(alice, 'A-2');
  await waitForMessage(bob, 'A-2');

  // Wait for archive push.
  console.log('--- waiting for archive push ---');
  await alice.page.waitForTimeout(8000);

  let pass = true;

  console.log('--- alice opens a fresh browser (Device B) and signs in ---');
  const aliceOnB = await newDeviceSignedIn('alice@B', aliceB, alice.username, alice.password);
  await snap(aliceOnB, '12-aliceB-after-signin');

  // Device B should have the conversation.
  try {
    await openConversation(aliceOnB, bob.username);
    console.log('  ✓ conversation with bob present on device B');
  } catch {
    console.log('  ✗ conversation with bob NOT present on device B');
    pass = false;
  }

  // Message history.
  for (const text of ['A-1', 'B-1', 'A-2']) {
    try { await waitForMessage(aliceOnB, text, 8_000); console.log(`  ✓ history: ${text}`); }
    catch { console.log(`  ✗ MISSING from history on B: ${text}`); pass = false; }
  }

  // New message from bob: where does it land?
  console.log('--- bob sends "after-B-signin" ---');
  await sendMessage(bob, 'after-B-signin');

  console.log('  checking device A...');
  let onA = false;
  try { await waitForMessage(alice, 'after-B-signin', 10_000); onA = true; console.log('    ✓ device A received it'); }
  catch { console.log('    – device A did NOT receive (may be expected under hand-off)'); }

  console.log('  checking device B...');
  let onB = false;
  try { await waitForMessage(aliceOnB, 'after-B-signin', 10_000); onB = true; console.log('    ✓ device B received it'); }
  catch { console.log('    – device B did NOT receive'); }

  if (!onA && !onB) { console.log('  ✗ NEITHER device received the message'); pass = false; }
  else { console.log(`  ✓ message reached ${onA && onB ? 'both' : (onA ? 'A only' : 'B only')}`); }

  // Send from Device B and see if Bob receives.
  console.log('--- alice (on B) sends "from-B" ---');
  await sendMessage(aliceOnB, 'from-B');
  try { await waitForMessage(bob, 'from-B', 15_000); console.log('  ✓ bob received from-B'); }
  catch { console.log('  ✗ bob did NOT receive from-B'); pass = false; }

  console.log('aliceB currently sees:', await readMessages(aliceOnB));
  await closeAll(alice, aliceOnB, bob);
  process.exit(pass ? 0 : 1);
})().catch((err) => { console.error('FAIL:', err); process.exit(1); });
