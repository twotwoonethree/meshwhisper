// Verifies the polish niggles: Esc closes modals, and multi-line messages
// render with preserved line breaks. Run: npx tsx e2e/run.ts e2e/verify-niggles.ts

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

  // --- ESC closes a modal ---
  await alice.page.locator('button[title="Add contact"]').click();
  await alice.page.locator('h2:has-text("Add contact")').waitFor({ state: 'visible', timeout: 5_000 });
  await alice.page.keyboard.press('Escape');
  await alice.page.waitForTimeout(400);
  results.escClosesModal = (await alice.page.locator('h2:has-text("Add contact")').count()) === 0;
  console.log(`[niggle] escClosesModal=${results.escClosesModal}`);

  // --- pair so we have a conversation (bob auto-opens into the thread) ---
  await alice.page.locator('button:has-text("Show your code")').click();
  await alice.page.locator('img[alt="Your contact code"]').waitFor({ state: 'visible', timeout: 8_000 });
  await alice.page.locator('button:has-text("Copy code")').click();
  const aliceCode = (await alice.page.evaluate(() => navigator.clipboard.readText())).trim();
  await alice.page.keyboard.press('Escape');
  await bob.page.locator('button:has-text("Scan a code")').click();
  await bob.page.locator('textarea[placeholder*="paste a contact code"]').fill(aliceCode);
  await bob.page.locator('button:has-text("Connect")').click();
  await bob.page.locator('textarea[placeholder="Message"]').waitFor({ state: 'visible', timeout: 20_000 });

  // --- multi-line message renders with line breaks preserved ---
  await bob.page.locator('textarea[placeholder="Message"]').fill('line one\nline two');
  await bob.page.keyboard.press('Enter');
  await bob.page.waitForTimeout(1500);
  const probe = await bob.page.evaluate(() => {
    const bubbles = Array.from(document.querySelectorAll('div[class*="rounded-2xl"]'));
    const b = bubbles.find((el) => (el.textContent ?? '').includes('line one'));
    if (!b) return { found: false, whiteSpace: '', text: '' };
    return { found: true, whiteSpace: getComputedStyle(b).whiteSpace, text: b.textContent ?? '' };
  });
  results.multilineRenders = probe.found && probe.whiteSpace === 'pre-wrap' && probe.text.includes('line two');
  console.log(`[niggle] multiline found=${probe.found} whiteSpace=${probe.whiteSpace} hasBothLines=${probe.text.includes('line two')}`);
  await snap(bob, 'niggle-multiline');

  await closeAll(alice, bob);

  console.log('\n=== RESULTS ===');
  for (const [k, v] of Object.entries(results)) console.log(`  ${v ? 'PASS' : 'FAIL'}  ${k}`);
  const allPass = Object.values(results).every(Boolean);
  console.log(`\nOVERALL: ${allPass ? 'PASS' : 'FAIL'}`);
  process.exit(allPass ? 0 : 1);
})().catch((err) => { console.error('SCRIPT ERROR:', err); process.exit(1); });
