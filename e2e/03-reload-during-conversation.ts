// Scenario: Bob reloads Prudence mid-conversation. Alice's messages
// sent while Bob's tab was reloading should still arrive.
// This is the everyday "I closed the tab" case.
// Run: npx tsx e2e/03-reload-during-conversation.ts

import {
  newUser, register, aliceAddContact, acceptIncomingRequest,
  openConversation, sendMessage, readMessages, reload,
  closeAll, snap, waitForMessage,
} from './lib.js';

(async () => {
  const alice = await newUser('alice');
  const bob = await newUser('bob');

  console.log('--- setup ---');
  await register(alice);
  await register(bob);
  await aliceAddContact(alice, bob.username);
  await acceptIncomingRequest(bob);
  await openConversation(alice, bob.username);
  await openConversation(bob, alice.username);

  console.log('--- baseline message ---');
  await sendMessage(alice, 'pre-reload');
  await snap(alice, '03-alice-after-send-debug');
  await snap(bob, '03-bob-before-wait-debug');
  await waitForMessage(bob, 'pre-reload');

  console.log('--- bob reloads ---');
  await reload(bob);
  await openConversation(bob, alice.username);

  console.log('--- alice sends while bob is back ---');
  await sendMessage(alice, 'post-reload-1');
  await sendMessage(alice, 'post-reload-2');
  await sendMessage(alice, 'post-reload-3');

  console.log('--- bob waits for them ---');
  let pass = true;
  for (const text of ['post-reload-1', 'post-reload-2', 'post-reload-3']) {
    try {
      await waitForMessage(bob, text, 15_000);
      console.log(`  ✓ ${text}`);
    } catch {
      console.log(`  ✗ MISSED: ${text}`);
      pass = false;
    }
  }

  await snap(bob, '03-bob-final');
  console.log('bob sees:', await readMessages(bob));

  await closeAll(alice, bob);
  process.exit(pass ? 0 : 1);
})().catch((err) => { console.error('FAIL:', err); process.exit(1); });
