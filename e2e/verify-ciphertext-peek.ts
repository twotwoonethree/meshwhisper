// Verifies the Ciphertext Peek: after sending a message, "What the relay sees"
// shows the actual encrypted bytes — non-empty hex that does NOT contain the
// plaintext, plus a rotating destHash. Run: npx tsx e2e/run.ts e2e/verify-ciphertext-peek.ts

import { newUser, register, waitForReady, snap, closeAll } from './lib.js';

const PLAINTEXT = 'top secret rendezvous at noon';
const results: Record<string, boolean> = {};

(async () => {
  const alice = await newUser('alice');
  const bob = await newUser('bob');
  await register(alice);
  await register(bob);
  await waitForReady(alice);
  await waitForReady(bob);
  await alice.context.grantPermissions(['clipboard-read', 'clipboard-write']);

  // Pair via QR (bob auto-opens into the thread).
  await alice.page.locator('button:has-text("Show your code")').click();
  await alice.page.locator('img[alt="Your contact code"]').waitFor({ state: 'visible', timeout: 8_000 });
  await alice.page.locator('button:has-text("Copy code")').click();
  const code = (await alice.page.evaluate(() => navigator.clipboard.readText())).trim();
  await alice.page.keyboard.press('Escape');
  await bob.page.locator('button:has-text("Scan a code")').click();
  await bob.page.locator('textarea[placeholder*="paste a contact code"]').fill(code);
  await bob.page.locator('button:has-text("Connect")').click();
  await bob.page.locator('textarea[placeholder="Message"]').waitFor({ state: 'visible', timeout: 20_000 });

  // bob sends a secret message.
  await bob.page.locator('textarea[placeholder="Message"]').fill(PLAINTEXT);
  await bob.page.keyboard.press('Enter');
  await bob.page.locator('div[class*="rounded-2xl"]', { hasText: PLAINTEXT }).first().waitFor({ state: 'visible', timeout: 10_000 });
  await bob.page.waitForTimeout(1500); // let onCiphertext populate the cache

  // Open the actions menu on bob's own message → "What the relay sees".
  await bob.page.locator('button[title="Message actions"]').first().click({ force: true });
  await bob.page.locator('button:has-text("What the relay sees")').click();
  await bob.page.locator('h2:has-text("What the relay sees")').waitFor({ state: 'visible', timeout: 5_000 });
  await snap(bob, 'peek-modal');

  const monoBlocks = bob.page.locator('div.font-mono');
  const ciphertextHex = (await monoBlocks.nth(0).innerText()).trim();
  const destHashHex = (await monoBlocks.nth(1).innerText()).trim();

  results.plaintextShown = (await bob.page.locator(`text=${PLAINTEXT}`).count()) >= 1;
  results.ciphertextIsHex = /^[0-9a-f\s]+$/i.test(ciphertextHex) && ciphertextHex.replace(/\s/g, '').length > 40;
  results.ciphertextIsEncrypted = !ciphertextHex.toLowerCase().includes('secret') && !ciphertextHex.includes(PLAINTEXT);
  results.destHashShown = /^[0-9a-f]+$/i.test(destHashHex) && destHashHex.length >= 16;

  console.log(`[peek] ciphertext bytes(hex len)=${ciphertextHex.replace(/\s/g, '').length} destHashLen=${destHashHex.length}`);
  console.log(`[peek] hex=${results.ciphertextIsHex} encrypted=${results.ciphertextIsEncrypted} plaintextShown=${results.plaintextShown} destHash=${results.destHashShown}`);

  await closeAll(alice, bob);

  console.log('\n=== RESULTS ===');
  for (const [k, v] of Object.entries(results)) console.log(`  ${v ? 'PASS' : 'FAIL'}  ${k}`);
  const allPass = Object.values(results).every(Boolean);
  console.log(`\nOVERALL: ${allPass ? 'PASS' : 'FAIL'}`);
  process.exit(allPass ? 0 : 1);
})().catch((err) => { console.error('SCRIPT ERROR:', err); process.exit(1); });
