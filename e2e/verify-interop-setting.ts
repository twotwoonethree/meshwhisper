// Verifies the Prudence interop setting: toggling "Cross-app messaging" in
// Settings persists and actually re-inits the SDK with interop — observable
// because the contact QR switches from the v0 format (base64 starts "AA…",
// version byte 0x00) to the v1 interop format ("AQ…", version byte 0x01).
// Run: npx tsx e2e/run.ts e2e/verify-interop-setting.ts

import { newUser, register, waitForReady, snap, closeAll } from './lib.js';
import type { TestUser } from './lib.js';

const results: Record<string, boolean> = {};

async function getMyContactCode(user: TestUser): Promise<string> {
  await user.page.locator('button[title="Add contact"]').click();
  await user.page.locator('button:has-text("My code")').click();
  await user.page.locator('img[alt="Your contact code"]').waitFor({ state: 'visible', timeout: 8_000 });
  await user.page.locator('button:has-text("Copy code")').click();
  const code = (await user.page.evaluate(() => navigator.clipboard.readText())).trim();
  await user.page.keyboard.press('Escape'); // close Add contact
  await user.page.waitForTimeout(300);
  return code;
}

(async () => {
  const alice = await newUser('alice');
  await register(alice);
  await waitForReady(alice);
  await alice.context.grantPermissions(['clipboard-read', 'clipboard-write']);

  // Default (interop off): the QR is the v0 format.
  const codeOff = await getMyContactCode(alice);
  results.defaultOff = codeOff.length > 0 && !codeOff.startsWith('AQ');
  console.log(`[interop] default code prefix=${codeOff.slice(0, 4)} off=${results.defaultOff}`);

  // Open Settings and flip the toggle — the app reloads.
  await alice.page.locator('button[title="Settings"]').click();
  await alice.page.locator('h3:has-text("Cross-app messaging")').waitFor({ state: 'visible', timeout: 5_000 });
  await snap(alice, 'interop-settings');
  await alice.page.locator('button[title="Toggle cross-app messaging (restarts the app)"]').click();
  await alice.page.waitForTimeout(3000); // reload + SDK re-init
  await waitForReady(alice);

  // After opt-in: the QR is the v1 interop format.
  const codeOn = await getMyContactCode(alice);
  results.onAfterToggle = codeOn.startsWith('AQ');
  console.log(`[interop] after-toggle code prefix=${codeOn.slice(0, 4)} on=${results.onAfterToggle}`);

  // And the toggle reflects the persisted state.
  await alice.page.locator('button[title="Settings"]').click();
  await alice.page.locator('h3:has-text("Cross-app messaging")').waitFor({ state: 'visible', timeout: 5_000 });
  const checked = await alice.page.locator('button[role="switch"]').getAttribute('aria-checked');
  results.togglePersisted = checked === 'true';
  console.log(`[interop] toggle aria-checked=${checked}`);

  await closeAll(alice);

  console.log('\n=== RESULTS ===');
  for (const [k, v] of Object.entries(results)) console.log(`  ${v ? 'PASS' : 'FAIL'}  ${k}`);
  const allPass = Object.values(results).every(Boolean);
  console.log(`\nOVERALL: ${allPass ? 'PASS' : 'FAIL'}`);
  process.exit(allPass ? 0 : 1);
})().catch((err) => { console.error('SCRIPT ERROR:', err); process.exit(1); });
