// Minimal: alice sends one message, bob must receive it.
// The simplest possible delivery assertion. If this fails, nothing else
// in the harness matters until it's fixed.
//
// Usage: npx tsx e2e/run.ts e2e/00-minimal-delivery.ts

import {
  newUser, register, aliceAddContact, acceptIncomingRequest,
  openConversation, sendMessage, waitForMessage, snap, closeAll,
  readMessages,
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

  // Both open the conversation.
  await openConversation(alice, bob.username);
  await openConversation(bob, alice.username);

  console.log('--- alice sends "hello" ---');
  await sendMessage(alice, 'hello');

  console.log('--- bob waits for "hello" ---');
  try {
    await waitForMessage(bob, 'hello', 30_000);
    console.log('  ✓ bob received hello');
  } catch (e) {
    console.log('  ✗ bob NEVER received hello');
    await snap(alice, '00-alice-state');
    await snap(bob, '00-bob-state');
    console.log('  alice sees:', await readMessages(alice));
    console.log('  bob   sees:', await readMessages(bob));
    await closeAll(alice, bob);
    process.exit(1);
  }

  await closeAll(alice, bob);
  process.exit(0);
})().catch((err) => { console.error('FAIL:', err); process.exit(1); });
