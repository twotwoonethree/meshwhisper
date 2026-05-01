// Quick smoke test: load meshwhisper.org, read the hero, exit.
// Run: npx tsx e2e/smoke.ts
import { chromium } from '@playwright/test';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('https://meshwhisper.org', { waitUntil: 'domcontentloaded' });
  const heading = await page.locator('h1').first().textContent();
  console.log('hero:', heading?.trim());
  await browser.close();
})();
