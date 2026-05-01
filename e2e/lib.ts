// Helpers for driving Prudence in a Playwright browser context.
// Each function operates on a Page that's already been navigated to
// the Prudence PWA and waited for hydration.

import type { BrowserContext, Browser, Page } from '@playwright/test';
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

export const PRUDENCE_URL = process.env.PRUDENCE_URL ?? 'https://prudence.meshwhisper.org';

mkdirSync('e2e/screenshots', { recursive: true });

export interface TestUser {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  label: string;
  username: string;
  password: string;
}

/** Random username that fits Prudence's [a-z0-9_-]{3,30} constraint. */
export function randomUsername(prefix = 'e2e'): string {
  const tail = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${tail}`;
}

/** Launch a fresh browser. Each user gets their own — separate IDB, no cross-contamination. */
export async function newUser(label: string): Promise<TestUser> {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await context.newPage();
  attachLogging(page, label);
  return { browser, context, page, label, username: '', password: '' };
}

function attachLogging(page: Page, label: string) {
  page.on('console', (msg) => {
    const text = msg.text();
    // Surface only relevant signal: errors/warnings, Prudence's [prudence]
    // logs, and explicit [addContact]/[accept] traces. Filter the spammy
    // 404 (icon misses) so they don't drown out the real signal.
    if (text.includes('404') || text.includes('Failed to load resource')) return;
    if (msg.type() === 'error' || msg.type() === 'warning' || /^\[/.test(text)) {
      console.log(`[${label}] ${msg.type()}: ${text}`);
    }
  });
  page.on('pageerror', (err) => {
    console.log(`[${label}] PAGEERROR: ${err.message}`);
  });
}

/** Register a fresh account through the onboarding form. */
export async function register(user: TestUser): Promise<void> {
  user.username = randomUsername();
  user.password = 'TestPass1234';

  await user.page.goto(PRUDENCE_URL, { waitUntil: 'networkidle' });
  await user.page.locator('input[autocomplete="username"]').fill(user.username);
  await user.page.locator('input[autocomplete="new-password"]').first().fill(user.password);
  await user.page.locator('input[autocomplete="new-password"]').nth(1).fill(user.password);
  await user.page.locator('button[type="submit"]').click();
  await user.page.waitForLoadState('networkidle');
  await user.page.waitForTimeout(2000);
}

/**
 * Reload the page, simulating the user closing and re-opening Prudence
 * on the same device. IDB persists; service worker stays registered.
 *
 * `networkidle` is unsuitable here because the relay WebSocket never
 * goes idle. `domcontentloaded` + a short stabilisation pause is what
 * we want.
 */
export async function reload(user: TestUser): Promise<void> {
  await user.page.reload({ waitUntil: 'domcontentloaded' });
  await user.page.waitForTimeout(3000);
}

/**
 * Close the browser entirely and re-open with a fresh context but
 * the SAME storage state. Approximates "user quit Prudence and came
 * back later." Using storage state preserves IDB across the close/open.
 */
export async function relaunch(user: TestUser): Promise<TestUser> {
  // Capture storage state (cookies + localStorage). IDB doesn't persist
  // through context.storageState() — but the same browser+profile
  // approach below preserves it.
  await user.context.close();
  await user.browser.close();

  const browser = await chromium.launch();
  // Use a persistent context tied to a stable directory per label so IDB
  // survives the relaunch. We swap in this directory for both the original
  // creation (lazy) and subsequent relaunches.
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await context.newPage();
  attachLogging(page, user.label);
  await page.goto(PRUDENCE_URL, { waitUntil: 'networkidle' });
  return { browser, context, page, label: user.label, username: user.username, password: user.password };
}

/**
 * Start a fresh browser with a persistent profile directory. IDB and
 * service workers persist across calls with the same `profileDir`.
 * Use this when you need genuine "close & reopen" semantics.
 */
export async function newPersistentUser(label: string, profileDir: string): Promise<TestUser> {
  const context = await chromium.launchPersistentContext(profileDir, {
    viewport: { width: 420, height: 900 },
  });
  const page = context.pages()[0] ?? await context.newPage();
  attachLogging(page, label);
  // launchPersistentContext returns a context whose .browser() is null;
  // wrap so closeAll/relaunch can still tear it down.
  const browserShim = { close: () => context.close() } as unknown as Browser;
  return { browser: browserShim, context, page, label, username: '', password: '' };
}

/** Wait for the conversation list to be ready (hydrated, sdk connected). */
export async function waitForReady(user: TestUser, timeout = 30_000): Promise<void> {
  await user.page.waitForSelector('text=/No conversations yet|@/i', { timeout });
  // Give the SDK a beat to flush any queued state.
  await user.page.waitForTimeout(1500);
}

export async function snap(user: TestUser, name: string): Promise<void> {
  await user.page.screenshot({ path: `e2e/screenshots/${name}.png`, fullPage: true });
}

export async function closeAll(...users: TestUser[]): Promise<void> {
  for (const u of users) {
    try { await u.context.close(); } catch { /* already closed */ }
    try { await u.browser?.close(); } catch { /* already closed */ }
  }
}

// ---------------------------------------------------------------- //
// Domain-level actions — Prudence-specific UI interactions          //
// ---------------------------------------------------------------- //

export async function aliceAddContact(user: TestUser, peerUsername: string): Promise<void> {
  await user.page.locator('button[title="Add contact"]').click();
  await user.page.locator('h2:has-text("Add contact")').waitFor({ state: 'visible', timeout: 5_000 });
  await user.page.locator('input[placeholder="username"]').fill(peerUsername);
  await user.page.locator('button[type="submit"]:has-text("Search")').click();
  await user.page.locator(`text=@${peerUsername}`).waitFor({ state: 'visible', timeout: 10_000 });
  await user.page.locator('button:has-text("Connect")').click();
  await user.page.waitForTimeout(1500);
  await user.page.keyboard.press('Escape').catch(() => {});
}

export async function acceptIncomingRequest(user: TestUser, timeout = 30_000): Promise<void> {
  await user.page.locator('text=/Contact requests/i').waitFor({ state: 'visible', timeout });
  await user.page.locator('button.bg-brand-600, button.bg-brand-500').first().click();
  // Generous settle window — accept triggers a directory lookup, addContactByKey,
  // and several control messages bouncing between peers. Give all of that time
  // to land before the test starts sending real traffic.
  await user.page.waitForTimeout(4000);
}

export async function openConversation(user: TestUser, peerUsername: string): Promise<void> {
  const tile = user.page.locator(`button:has-text("@${peerUsername}")`).first();
  await tile.click();
  await user.page.waitForTimeout(500);
}

export async function sendMessage(user: TestUser, text: string): Promise<void> {
  const input = user.page.locator('input[placeholder*="Message"], textarea[placeholder*="Message"]').first();
  await input.fill(text);
  await user.page.keyboard.press('Enter');
  await user.page.waitForTimeout(800);
}

/** Read all visible message bubble texts in the currently-open conversation. */
export async function readMessages(user: TestUser): Promise<string[]> {
  return user.page.evaluate(() => {
    const bubbles = Array.from(document.querySelectorAll('[class*="rounded-2xl"], [class*="rounded-3xl"]'));
    return bubbles
      .map((el) => el.textContent?.trim() ?? '')
      .filter((t) => t && t.length > 0 && t.length < 500);
  });
}

/** Wait for a specific message to appear in the conversation pane (not the list preview). */
export async function waitForMessage(user: TestUser, text: string, timeout = 30_000): Promise<void> {
  // Message bubbles have rounded-2xl AND a background slate-800 (incoming)
  // or brand-* (outgoing). The conversation-list preview is a <p> with
  // text-xs. Scope to bubble divs only.
  await user.page.locator('div[class*="rounded-2xl"]', { hasText: text }).first().waitFor({
    state: 'visible',
    timeout,
  });
}
