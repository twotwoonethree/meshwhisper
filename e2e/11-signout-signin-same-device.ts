// Scenario: Alice signs out and signs back in using the same browser,
// same credentials. After re-login, she should still see Bob in her
// conversation list and her message history. New messages from Bob
// should arrive.

import {
  newUser, register, aliceAddContact, acceptIncomingRequest,
  openConversation, sendMessage, waitForMessage, signOut,
  signInOnSamePage, snap, closeAll, waitForReady, readMessages,
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

  console.log('--- exchange a few messages ---');
  await sendMessage(alice, 'hi-1');
  await waitForMessage(bob, 'hi-1');
  await sendMessage(bob, 'hi-back-1');
  await waitForMessage(alice, 'hi-back-1');
  await sendMessage(alice, 'hi-2');
  await waitForMessage(bob, 'hi-2');

  // Wait for archive push debounce.
  await alice.page.waitForTimeout(8000);

  let pass = true;

  console.log('--- alice signs out (same browser, IDB preserved) ---');
  await signOut(alice);

  console.log('--- alice signs back in with same credentials ---');
  await signInOnSamePage(alice, alice.username, alice.password);
  await waitForReady(alice);
  await snap(alice, '11-alice-after-resignin');

  // Conversation should still be there.
  try {
    await openConversation(alice, bob.username);
    console.log('  ✓ conversation with bob restored');
  } catch {
    console.log('  ✗ conversation with bob NOT restored');
    pass = false;
  }

  // Message history should still be there.
  for (const text of ['hi-1', 'hi-back-1', 'hi-2']) {
    try { await waitForMessage(alice, text, 5_000); console.log(`  ✓ history: ${text}`); }
    catch { console.log(`  ✗ MISSING from history: ${text}`); pass = false; }
  }

  // New message from bob should arrive.
  console.log('--- bob sends another message after alice re-signed in ---');
  await sendMessage(bob, 'after-resignin');
  try { await waitForMessage(alice, 'after-resignin', 30_000); console.log('  ✓ alice received post-resignin message'); }
  catch { console.log('  ✗ alice did NOT receive post-resignin message'); pass = false; }

  console.log('alice currently sees:', await readMessages(alice));
  await closeAll(alice, bob);
  process.exit(pass ? 0 : 1);
})().catch((err) => { console.error('FAIL:', err); process.exit(1); });
