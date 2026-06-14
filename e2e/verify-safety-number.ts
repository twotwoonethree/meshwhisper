// Verifies safety-number verification: the number is identical on both peers,
// the "check theirs" flow matches and marks verified, and the header shows the
// verified badge. Run: npx tsx e2e/run.ts e2e/verify-safety-number.ts

import {
  newUser, register, waitForReady, aliceAddContact, acceptIncomingRequest,
  openConversation, sendMessage, snap, closeAll,
} from './lib.js';

async function readSafetyNumber(user: { page: import('@playwright/test').Page }): Promise<string> {
  await user.page.locator('button[title="Contact info & verification"]').click();
  await user.page.locator('div.font-mono').first().waitFor({ state: 'visible', timeout: 8_000 });
  return (await user.page.locator('div.font-mono').first().innerText()).trim();
}

(async () => {
  const alice = await newUser('alice');
  const bob = await newUser('bob');
  await register(alice);
  await register(bob);
  await waitForReady(alice);
  await waitForReady(bob);
  console.log(`alice=${alice.username}  bob=${bob.username}`);

  await aliceAddContact(alice, bob.username);
  await acceptIncomingRequest(bob);
  await openConversation(alice, bob.username);
  await sendMessage(alice, 'hi bob');
  await openConversation(bob, alice.username);
  await sendMessage(bob, 'hi alice');
  await alice.page.waitForTimeout(3000);

  // Both peers' safety numbers should be identical (symmetric fingerprint).
  const aliceNum = await readSafetyNumber(alice);
  await alice.page.locator('button[title="Close"]').first().click().catch(() => {});
  const bobNum = await readSafetyNumber(bob);
  await bob.page.locator('button[title="Close"]').first().click().catch(() => {});
  const symmetric = aliceNum.length > 0 && aliceNum === bobNum;
  console.log(`[verify] aliceNum=${aliceNum.slice(0, 20)}…  bobNum=${bobNum.slice(0, 20)}…  symmetric=${symmetric}`);

  // alice checks bob's number → should match + mark verified.
  await alice.page.locator('button[title="Contact info & verification"]').click();
  await alice.page.locator('input[placeholder="Paste their safety number"]').fill(bobNum);
  await alice.page.locator('button:has-text("Check")').click();
  await alice.page.waitForTimeout(800);
  const matchShown = await alice.page.locator('text=/marked as verified/i').count();
  await snap(alice, 'sn-match');
  await alice.page.locator('button[title="Close"]').first().click().catch(() => {});
  await alice.page.waitForTimeout(500);
  const verifiedBadge = await alice.page.locator('svg[aria-label="Verified"]').count();
  await snap(alice, 'sn-verified-header');

  // Negative probe: a wrong number must NOT verify.
  const fresh = await newUser('carol');
  await register(fresh);
  await waitForReady(fresh);
  // Reuse alice: open contact info, type garbage, expect "No match".
  await alice.page.locator('button[title="Contact info & verification"]').click();
  await alice.page.locator('input[placeholder="Paste their safety number"]').fill('00000 11111 22222 33333');
  await alice.page.locator('button:has-text("Check")').click();
  await alice.page.waitForTimeout(500);
  const mismatchShown = await alice.page.locator('text=/No match/i').count();
  console.log(`[verify] matchShown=${matchShown} verifiedBadge=${verifiedBadge} mismatchOnWrong=${mismatchShown}`);

  await closeAll(alice, bob, fresh);

  const pass = symmetric && matchShown >= 1 && verifiedBadge >= 1 && mismatchShown >= 1;
  console.log(`\nOVERALL: ${pass ? 'PASS' : 'FAIL'}`);
  process.exit(pass ? 0 : 1);
})().catch((err) => { console.error('SCRIPT ERROR:', err); process.exit(1); });
