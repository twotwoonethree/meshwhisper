// Verifies QR contact pairing without the directory: alice generates her
// contact code, bob pairs from it (the paste path — same code a camera scan
// would yield), and both ends reconcile (bob gets the conversation, alice gets
// a request showing bob's @name). Run: npx tsx e2e/run.ts e2e/verify-qr-pairing.ts

import { newUser, register, waitForReady, snap, closeAll } from './lib.js';

(async () => {
  const alice = await newUser('alice');
  const bob = await newUser('bob');
  await register(alice);
  await register(bob);
  await waitForReady(alice);
  await waitForReady(bob);
  await alice.context.grantPermissions(['clipboard-read', 'clipboard-write']);
  console.log(`alice=${alice.username}  bob=${bob.username}`);

  // --- alice: open Add contact → My code, confirm QR renders, grab the code ---
  await alice.page.locator('button[title="Add contact"]').click();
  await alice.page.locator('button:has-text("My code")').click();
  await alice.page.locator('img[alt="Your contact code"]').waitFor({ state: 'visible', timeout: 8_000 });
  const qrRendered = await alice.page.locator('img[alt="Your contact code"]').count();
  await alice.page.locator('button:has-text("Copy code")').click();
  const aliceCode = (await alice.page.evaluate(() => navigator.clipboard.readText())).trim();
  console.log(`[qr] qrRendered=${qrRendered} codeLen=${aliceCode.length}`);
  await snap(alice, 'qr-mycode');
  // Close alice's modal so it doesn't overlap the incoming-request UI.
  await alice.page.locator('div.absolute.inset-0').first().click({ force: true }).catch(() => {});
  await alice.page.waitForTimeout(500);

  // --- bob: Scan tab → paste alice's code → Connect ---
  await bob.page.locator('button[title="Add contact"]').click();
  await bob.page.getByRole('button', { name: 'Scan', exact: true }).click();
  await bob.page.locator('textarea[placeholder*="paste a contact code"]').fill(aliceCode);
  await bob.page.locator('button:has-text("Connect")').click();
  // On a successful pair the app adds the conversation and auto-opens it, so bob
  // lands straight in the thread (the composer is the reliable signal — on the
  // mobile viewport the list is hidden while a conversation is open).
  await bob.page.locator('textarea[placeholder="Message"]').waitFor({ state: 'visible', timeout: 20_000 });
  await snap(bob, 'qr-bob-paired');
  const bobHasAlice = await bob.page.locator('textarea[placeholder="Message"]').count();

  // alice should receive bob's contact_request (carrying bob's @name).
  await alice.page.waitForTimeout(4000);
  const aliceSeesBob = await alice.page.locator(`text=@${bob.username}`).count();
  await snap(alice, 'qr-alice-request');

  console.log(`[qr] bobHasAlice=${bobHasAlice} aliceSeesBob=${aliceSeesBob}`);

  await closeAll(alice, bob);

  const pass = qrRendered >= 1 && aliceCode.length > 40 && bobHasAlice >= 1 && aliceSeesBob >= 1;
  console.log(`\nOVERALL: ${pass ? 'PASS' : 'FAIL'}`);
  process.exit(pass ? 0 : 1);
})().catch((err) => { console.error('SCRIPT ERROR:', err); process.exit(1); });
