// Scenario: Alice and Bob are mid-conversation. Bob signs out. Alice
// keeps sending. Bob signs back in (same browser, same credentials).
// Bob should receive the messages Alice sent while he was signed out.

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

  console.log('--- bob signs out (same browser) ---');
  await signOut(bob);

  console.log('--- alice sends 2 messages while bob is signed out ---');
  await sendMessage(alice, 'while-out-1');
  await sendMessage(alice, 'while-out-2');
  await alice.page.waitForTimeout(2000);

  console.log('--- bob signs back in ---');
  await signInOnSamePage(bob, bob.username, bob.password);
  await waitForReady(bob);
  await openConversation(bob, alice.username);

  for (const text of ['while-out-1', 'while-out-2']) {
    try { await waitForMessage(bob, text, 30_000); console.log(`  ✓ ${text}`); }
    catch { console.log(`  ✗ MISSED: ${text}`); pass = false; }
  }

  await snap(bob, '15-bob-after-resignin');
  await closeAll(alice, bob);
  process.exit(pass ? 0 : 1);
})().catch((err) => { console.error('FAIL:', err); process.exit(1); });
