// End-to-end: alice adds bob, both exchange a message, both see the
// other's username in the conversation. This is the scenario where we
// kept seeing message-loss / username-missing bugs.
// Run: npx tsx e2e/02-contact-and-message.ts

import { newUser, register, snap, closeAll } from './lib.js';

async function aliceAddsBob(alice: { page: import('@playwright/test').Page }, bobUsername: string) {
  // Click the "+" button in the header.
  await alice.page.locator('button[aria-label="Add contact"], button:has(svg path[d*="M12 4.5"])').first().click()
    .catch(async () => {
      // Fallback: just click the last button in the header (the + button).
      await alice.page.locator('header button, .h-14 button').last().click();
    });
  // Wait for the modal.
  await alice.page.locator('text=Add contact').waitFor({ state: 'visible', timeout: 5_000 });

  // Type the username and Search.
  await alice.page.locator('input[placeholder="username"]').fill(bobUsername);
  await alice.page.locator('button[type="submit"]:has-text("Search")').click();

  // The found card appears with a Connect button.
  await alice.page.locator(`text=@${bobUsername}`).waitFor({ state: 'visible', timeout: 10_000 });
  await alice.page.locator('button:has-text("Connect")').click();

  // The modal shows "Request sent" or auto-closes.
  await alice.page.waitForTimeout(1_500);
}

async function bobAcceptsRequest(bob: { page: import('@playwright/test').Page }) {
  // Wait for a contact request to arrive — could come via the SDK firing
  // onContactRequest on inbound x3dh_init, or via the prudence_contact_request
  // follow-up. Either way, "Contact requests" UI should surface.
  await bob.page.locator('text=/Contact requests|wants to connect|connect with/i').waitFor({
    state: 'visible',
    timeout: 30_000,
  });

  // Click Accept (the green checkmark button or any button labelled Accept).
  await bob.page.locator('button[aria-label="Accept"], button:has-text("Accept")').first().click()
    .catch(async () => {
      // Fallback: click the green-ish button in the request row.
      await bob.page.locator('button.bg-brand-600, button.bg-emerald-500').first().click();
    });
  await bob.page.waitForTimeout(1_500);
}

async function sendMessage(user: { page: import('@playwright/test').Page }, peerUsername: string, text: string) {
  // Open the conversation if not already open.
  const convoTile = user.page.locator(`text=@${peerUsername}`).first();
  if (await convoTile.isVisible().catch(() => false)) {
    await convoTile.click();
  }
  await user.page.locator('input[placeholder*="Message"], textarea[placeholder*="Message"]').fill(text);
  await user.page.keyboard.press('Enter');
  await user.page.waitForTimeout(1_000);
}

async function readMessages(user: { page: import('@playwright/test').Page }): Promise<string[]> {
  // Grab all visible message bubble texts.
  return user.page.evaluate(() => {
    const bubbles = Array.from(document.querySelectorAll('[class*="rounded-2xl"], [class*="rounded-3xl"]'));
    return bubbles.map((el) => el.textContent?.trim() ?? '').filter((t) => t && t.length < 500);
  });
}

(async () => {
  const alice = await newUser('alice');
  const bob = await newUser('bob');

  console.log('--- registering both users ---');
  await register(alice);
  await register(bob);
  console.log('alice =', alice.username);
  console.log('bob   =', bob.username);

  console.log('--- alice adds bob ---');
  await aliceAddsBob(alice, bob.username);
  await snap(alice, '02-alice-after-connect');
  await snap(bob, '02-bob-after-receive');

  console.log('--- bob accepts ---');
  await bobAcceptsRequest(bob);
  await snap(bob, '02-bob-after-accept');

  console.log('--- alice sends a message ---');
  await sendMessage(alice, bob.username, 'hello bob');
  await snap(alice, '02-alice-after-send');
  await snap(bob, '02-bob-after-receive-message');

  console.log('--- bob replies ---');
  await sendMessage(bob, alice.username, 'hi alice');
  await snap(alice, '02-alice-after-reply');

  const aliceSees = await readMessages(alice);
  const bobSees = await readMessages(bob);
  console.log('alice sees:', aliceSees);
  console.log('bob   sees:', bobSees);

  await closeAll(alice, bob);
})().catch((err) => { console.error('FAIL:', err); process.exit(1); });
