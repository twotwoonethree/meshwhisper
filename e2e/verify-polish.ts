// Verifies first-run polish: empty-state guidance cards route to the right
// Add-contact tab, and a successful add auto-opens the conversation.
// Run: npx tsx e2e/run.ts e2e/verify-polish.ts

import { newUser, register, waitForReady, snap, closeAll } from './lib.js';

const results: Record<string, boolean> = {};

(async () => {
  const alice = await newUser('alice');
  const bob = await newUser('bob');
  await register(alice);
  await register(bob);
  await waitForReady(alice);
  await waitForReady(bob);
  await alice.context.grantPermissions(['clipboard-read', 'clipboard-write']);
  console.log(`alice=${alice.username}  bob=${bob.username}`);

  // --- empty-state guidance: three cards present ---
  const cards = await alice.page.locator('text=/Find by @username|Show your code|Scan a code/').count();
  results.emptyStateCards = cards >= 3;
  await snap(alice, 'polish-empty-state');
  console.log(`[polish] empty-state cards=${cards}`);

  // --- card routes to the right tab: "Show your code" → My code (QR visible) ---
  await alice.page.locator('button:has-text("Show your code")').click();
  await alice.page.locator('img[alt="Your contact code"]').waitFor({ state: 'visible', timeout: 8_000 });
  results.routeMyCode = (await alice.page.locator('img[alt="Your contact code"]').count()) >= 1;
  await alice.page.locator('button:has-text("Copy code")').click();
  const aliceCode = (await alice.page.evaluate(() => navigator.clipboard.readText())).trim();
  await alice.page.locator('div.absolute.inset-0').first().click({ force: true }).catch(() => {});
  console.log(`[polish] routeMyCode=${results.routeMyCode} codeLen=${aliceCode.length}`);

  // --- bob: "Scan a code" card → Scan tab → paste → Connect → auto-open ---
  await bob.page.locator('button:has-text("Scan a code")').click();
  const pasteBox = bob.page.locator('textarea[placeholder*="paste a contact code"]');
  await pasteBox.waitFor({ state: 'visible', timeout: 8_000 });
  results.routeScan = true;
  await pasteBox.fill(aliceCode);
  await bob.page.locator('button:has-text("Connect")').click();
  // Auto-open: the conversation should open straight into the thread composer.
  await bob.page.locator('textarea[placeholder="Message"]').waitFor({ state: 'visible', timeout: 20_000 });
  results.autoOpen = (await bob.page.locator('textarea[placeholder="Message"]').count()) >= 1;
  await snap(bob, 'polish-autoopen');
  console.log(`[polish] routeScan=${results.routeScan} autoOpen=${results.autoOpen}`);

  await closeAll(alice, bob);

  console.log('\n=== RESULTS ===');
  for (const [k, v] of Object.entries(results)) console.log(`  ${v ? 'PASS' : 'FAIL'}  ${k}`);
  const allPass = Object.values(results).every(Boolean);
  console.log(`\nOVERALL: ${allPass ? 'PASS' : 'FAIL'}`);
  process.exit(allPass ? 0 : 1);
})().catch((err) => { console.error('SCRIPT ERROR:', err); process.exit(1); });
