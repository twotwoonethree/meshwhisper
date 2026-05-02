// Scenario: Alice (originator) is mid-conversation with Bob. Alice
// signs out and back in. Then Bob sends a message — does Alice receive
// it? Then Alice sends from her resigned-in session — does Bob receive?

import {
  newUser, register, aliceAddContact, acceptIncomingRequest,
  openConversation, sendMessage, waitForMessage, signOut,
  signInOnSamePage, snap, closeAll, waitForReady,
} from './lib.js';

(async () => {
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

  await sendMessage(alice, 'before-signout');
  let pass = true;
  try { await waitForMessage(bob, 'before-signout', 15_000); console.log('  ✓ baseline received'); }
  catch { console.log('  ✗ baseline missed'); pass = false; }

  // Wait for archive push.
  await alice.page.waitForTimeout(8000);

  console.log('--- alice signs out and back in ---');
  await signOut(alice);
  await signInOnSamePage(alice, alice.username, alice.password);
  await waitForReady(alice);
  await openConversation(alice, bob.username);
  await snap(alice, '16-alice-after-resignin');

  console.log('--- bob sends to (now-resigned-in) alice ---');
  await sendMessage(bob, 'after-alice-resignin');
  try { await waitForMessage(alice, 'after-alice-resignin', 30_000); console.log('  ✓ alice received bob\'s message'); }
  catch { console.log('  ✗ alice did NOT receive bob\'s message'); pass = false; }

  console.log('--- alice (resigned in) sends to bob ---');
  await sendMessage(alice, 'from-resigned-alice');
  try { await waitForMessage(bob, 'from-resigned-alice', 15_000); console.log('  ✓ bob received alice\'s post-resignin message'); }
  catch { console.log('  ✗ bob did NOT receive alice\'s post-resignin message'); pass = false; }

  await closeAll(alice, bob);
  process.exit(pass ? 0 : 1);
})().catch((err) => { console.error('FAIL:', err); process.exit(1); });
