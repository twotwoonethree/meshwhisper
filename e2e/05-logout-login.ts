// Scenario: Alice logs out and logs back in. Her conversations and
// message history should restore from the relay archive.
// Run: npx tsx e2e/05-logout-login.ts

import {
  newPersistentUser, newUser, register, aliceAddContact,
  acceptIncomingRequest, openConversation, sendMessage,
  readMessages, snap, closeAll, waitForReady, waitForMessage,
  PRUDENCE_URL,
} from './lib.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

(async () => {
  const aliceDir = mkdtempSync(join(tmpdir(), 'prudence-alice-'));

  let alice = await newPersistentUser('alice', aliceDir);
  const bob = await newUser('bob');

  console.log('--- setup ---');
  await register(alice);
  await register(bob);
  await aliceAddContact(alice, bob.username);
  await acceptIncomingRequest(bob);
  await openConversation(alice, bob.username);
  await openConversation(bob, alice.username);

  console.log('--- exchange a few messages ---');
  await sendMessage(alice, 'msg-from-alice-1');
  await waitForMessage(bob, 'msg-from-alice-1');
  await sendMessage(bob, 'msg-from-bob-1');
  await waitForMessage(alice, 'msg-from-bob-1');
  await sendMessage(alice, 'msg-from-alice-2');
  await waitForMessage(bob, 'msg-from-alice-2');

  // Give the archive a chance to push (5s debounce + buffer).
  console.log('--- waiting for archive push ---');
  await alice.page.waitForTimeout(8000);

  console.log('--- alice logs out (clears IDB and reloads) ---');
  // Wipe IDB the same way "log out + clear data" would.
  await alice.page.evaluate(async () => {
    const dbs = await indexedDB.databases?.() ?? [];
    for (const db of dbs) {
      if (db.name) indexedDB.deleteDatabase(db.name);
    }
    localStorage.clear();
    sessionStorage.clear();
  });

  // Reopen and log in with the same credentials.
  await alice.context.close();
  alice = await newPersistentUser('alice', aliceDir);

  console.log('--- alice logs back in ---');
  await alice.page.goto(PRUDENCE_URL, { waitUntil: 'networkidle' });
  // Onboarding flow again — but we use the same username + password,
  // so identity will be derived to the same key, and the relay archive
  // will be fetched.
  await alice.page.locator('input[autocomplete="username"]').fill(alice.username);
  await alice.page.locator('input[autocomplete="new-password"]').first().fill(alice.password);
  await alice.page.locator('input[autocomplete="new-password"]').nth(1).fill(alice.password);
  await alice.page.locator('button[type="submit"]').click();
  await waitForReady(alice);
  // Wait a few seconds for archive pull.
  await alice.page.waitForTimeout(5000);
  await snap(alice, '05-alice-after-relogin');

  console.log('--- check the conversation came back ---');
  let pass = true;
  try {
    await openConversation(alice, bob.username);
    console.log('  ✓ conversation with bob exists');
  } catch {
    console.log('  ✗ MISSED: conversation with bob');
    pass = false;
  }

  for (const text of ['msg-from-alice-1', 'msg-from-bob-1', 'msg-from-alice-2']) {
    try {
      await waitForMessage(alice, text, 5_000);
      console.log(`  ✓ history: ${text}`);
    } catch {
      console.log(`  ✗ MISSING from history: ${text}`);
      pass = false;
    }
  }

  console.log('alice now sees:', await readMessages(alice));

  await closeAll(alice, bob);
  process.exit(pass ? 0 : 1);
})().catch((err) => { console.error('FAIL:', err); process.exit(1); });
