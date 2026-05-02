// Scenario: Bob registered, has never been contacted, closes browser.
// Alice (already signed in) sends Bob a contact request. Bob reopens
// (same persistent profile). Bob should see the contact request.

import {
  newUser, newPersistentUser, register, snap, closeAll, waitForReady,
  aliceAddContact,
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

  console.log('--- bob fully closes browser ---');
  await bob.context.close();
  await alice.page.waitForTimeout(2000);

  console.log('--- alice sends a contact request to offline bob ---');
  await aliceAddContact(alice, bob.username);
  // Give the relay time to queue.
  await alice.page.waitForTimeout(3000);

  console.log('--- bob reopens (same profile) ---');
  bob = await newPersistentUser('bob', bobDir);
  await waitForReady(bob);
  await bob.page.waitForTimeout(4000);
  await snap(bob, '13-bob-after-reopen');

  let pass = true;
  // Bob should see a contact request.
  try {
    await bob.page.locator('text=/Contact requests/i').waitFor({ state: 'visible', timeout: 30_000 });
    console.log('  ✓ bob sees the contact request after reopening');
  } catch {
    console.log('  ✗ bob does NOT see the contact request after reopening');
    pass = false;
  }

  await closeAll(alice, bob);
  process.exit(pass ? 0 : 1);
})().catch((err) => { console.error('FAIL:', err); process.exit(1); });
