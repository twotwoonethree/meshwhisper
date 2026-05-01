// Scenario: Bob disconnects (browser closed), Alice sends several
// messages while he's offline, Bob comes back online and should
// receive all of them. This is the destHash-listen-window case
// that we just fixed (1h → 72h).
// Run: npx tsx e2e/04-offline-then-back.ts

import {
  newPersistentUser, newUser, register, aliceAddContact,
  acceptIncomingRequest, openConversation, sendMessage,
  waitForMessage, readMessages, snap, closeAll, waitForReady,
} from './lib.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

(async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'prudence-bob-'));

  const alice = await newUser('alice');
  let bob = await newPersistentUser('bob', profileDir);

  console.log('--- setup: register both, alice adds bob ---');
  await register(alice);
  await register(bob);
  await aliceAddContact(alice, bob.username);
  await acceptIncomingRequest(bob);
  await openConversation(alice, bob.username);
  await openConversation(bob, alice.username);

  await sendMessage(alice, 'baseline');
  await waitForMessage(bob, 'baseline');

  console.log('--- bob goes offline (closes browser) ---');
  await bob.context.close();

  console.log('--- alice sends 3 messages while bob is offline ---');
  await sendMessage(alice, 'offline-1');
  await sendMessage(alice, 'offline-2');
  await sendMessage(alice, 'offline-3');

  // Give the relay a moment to queue them.
  await alice.page.waitForTimeout(2000);

  console.log('--- bob comes back ---');
  bob = await newPersistentUser('bob', profileDir);
  await waitForReady(bob);
  await openConversation(bob, alice.username);

  let pass = true;
  for (const text of ['offline-1', 'offline-2', 'offline-3']) {
    try {
      await waitForMessage(bob, text, 30_000);
      console.log(`  ✓ ${text}`);
    } catch {
      console.log(`  ✗ MISSED: ${text}`);
      pass = false;
    }
  }

  await snap(bob, '04-bob-after-online');
  console.log('bob sees:', await readMessages(bob));

  await closeAll(alice, bob);
  process.exit(pass ? 0 : 1);
})().catch((err) => { console.error('FAIL:', err); process.exit(1); });
