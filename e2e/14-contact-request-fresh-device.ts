// Scenario: Bob registered on Device A and went offline. Alice sends
// him a contact request. Bob then signs in on a totally fresh Device B
// (different profile). Does Bob see the contact request?
//
// This tests whether contact requests survive the bob-never-comes-back-on-
// the-same-device case — does the archive carry it, or is it relay-queued
// only?

import {
  newUser, newPersistentUser, register, aliceAddContact,
  newDeviceSignedIn, snap, closeAll,
} from './lib.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

(async () => {
  const bobA = mkdtempSync(join(tmpdir(), 'p-bobA-'));
  const bobB = mkdtempSync(join(tmpdir(), 'p-bobB-'));

  const alice = await newUser('alice');
  let bob = await newPersistentUser('bob@A', bobA);

  await register(alice);
  await register(bob);
  console.log('alice =', alice.username);
  console.log('bob   =', bob.username);

  // Save bob's credentials before closing his Device A.
  const bobUsername = bob.username;
  const bobPassword = bob.password;

  console.log('--- bob closes Device A ---');
  await bob.context.close();
  await alice.page.waitForTimeout(2000);

  console.log('--- alice sends contact request to offline bob ---');
  await aliceAddContact(alice, bobUsername);
  await alice.page.waitForTimeout(4000);

  console.log('--- bob signs in on Device B (fresh profile) ---');
  const bobOnB = await newDeviceSignedIn('bob@B', bobB, bobUsername, bobPassword);
  await bobOnB.page.waitForTimeout(5000);
  await snap(bobOnB, '14-bobB-after-signin');

  let pass = true;
  try {
    await bobOnB.page.locator('text=/Contact requests/i').waitFor({ state: 'visible', timeout: 30_000 });
    console.log('  ✓ bob sees contact request on Device B');
  } catch {
    console.log('  ✗ bob does NOT see contact request on Device B');
    pass = false;
  }

  await closeAll(alice, bobOnB);
  process.exit(pass ? 0 : 1);
})().catch((err) => { console.error('FAIL:', err); process.exit(1); });
