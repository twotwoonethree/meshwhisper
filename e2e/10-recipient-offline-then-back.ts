// Scenario: Bob's browser is fully closed. Alice sends three messages
// while Bob is gone. Bob reopens (same persistent profile, IDB intact)
// and should receive all of them.
//
// This is the "ordinary message reaches a user on wakeup" baseline.

import {
  newUser, newPersistentUser, register, aliceAddContact,
  acceptIncomingRequest, openConversation, sendMessage,
  waitForMessage, snap, closeAll, waitForReady,
} from './lib.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

(async () => {
  const bobDir = mkdtempSync(join(tmpdir(), 'p-bob-'));

  const alice = await newUser('alice');
  let bob = await newPersistentUser('bob', bobDir);

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
  try { await waitForMessage(bob, 'baseline', 15_000); console.log('  ✓ baseline received'); }
  catch { console.log('  ✗ baseline missed'); pass = false; }

  console.log('--- bob fully closes browser ---');
  await bob.context.close();

  console.log('--- alice sends 3 messages while bob is offline ---');
  await sendMessage(alice, 'while-offline-1');
  await sendMessage(alice, 'while-offline-2');
  await sendMessage(alice, 'while-offline-3');
  await alice.page.waitForTimeout(2000);

  console.log('--- bob reopens (same persistent profile) ---');
  bob = await newPersistentUser('bob', bobDir);
  await waitForReady(bob);
  await openConversation(bob, alice.username);

  for (const text of ['while-offline-1', 'while-offline-2', 'while-offline-3']) {
    try { await waitForMessage(bob, text, 30_000); console.log(`  ✓ ${text}`); }
    catch { console.log(`  ✗ MISSED: ${text}`); pass = false; }
  }

  await snap(bob, '10-bob-after-back');
  await closeAll(alice, bob);
  process.exit(pass ? 0 : 1);
})().catch((err) => { console.error('FAIL:', err); process.exit(1); });
