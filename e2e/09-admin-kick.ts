// Admin kicks a member: alice removes bob from a 3-person group.
// Bob's local group state is wiped and his conversation disappears;
// alice and carol see a "@alice removed @bob" system message and can
// continue messaging without him.
//
// Run: npx tsx e2e/run.ts e2e/09-admin-kick.ts

import {
  newUser, register, aliceAddContact, acceptIncomingRequest,
  sendMessage, waitForMessage, snap, closeAll,
} from './lib.js';
import type { TestUser } from './lib.js';

async function addAndAcceptContact(initiator: TestUser, recipient: TestUser) {
  await aliceAddContact(initiator, recipient.username);
  await acceptIncomingRequest(recipient);
}

async function createGroup(creator: TestUser, name: string, memberUsernames: string[]) {
  await creator.page.locator('button[title="New group"]').click();
  await creator.page.locator('h2:has-text("New group")').waitFor({ state: 'visible', timeout: 5_000 });
  await creator.page.locator('input[placeholder="Group name"]').fill(name);
  const modal = creator.page.locator('h2:has-text("New group")').locator('xpath=ancestor::div[contains(@class,"rounded-2xl")][1]');
  for (const u of memberUsernames) {
    await modal.locator(`button:has-text("@${u}")`).click();
  }
  await creator.page.locator('button:has-text("Create group")').click();
  await creator.page.waitForTimeout(2000);
}

async function acceptGroupInvite(user: TestUser) {
  await user.page.locator('h2:has-text("Group invitations")').waitFor({ state: 'visible', timeout: 30_000 });
  await user.page.locator('button:has-text("Join")').first().click();
  await user.page.waitForTimeout(2500);
}

async function openGroup(user: TestUser, groupName: string) {
  await user.page.locator(`button:has-text("${groupName}")`).first().click();
  await user.page.waitForTimeout(500);
}

async function kickMember(admin: TestUser, peerUsername: string) {
  await admin.page.locator('button[title="Members"]').click();
  await admin.page.locator('h2:has-text("Kick Test")').first().waitFor({ state: 'visible', timeout: 5_000 });
  // Find the member row (outer flex div) by hasText, then the Remove
  // button inside it. `.first()` plus `.filter()` keeps things scoped.
  const modal = admin.page.locator('h2:has-text("Kick Test")').first().locator('xpath=ancestor::div[contains(@class,"rounded-2xl")][1]');
  const row = modal.locator('div.flex.items-center.gap-3').filter({ hasText: `@${peerUsername}` }).first();
  await row.locator('button:has-text("Remove")').click();
  await admin.page.waitForTimeout(2500);
  await admin.page.keyboard.press('Escape').catch(() => {});
}

(async () => {
  const alice = await newUser('alice');
  const bob = await newUser('bob');
  const carol = await newUser('carol');

  await register(alice);
  await register(bob);
  await register(carol);
  console.log('alice =', alice.username);
  console.log('bob   =', bob.username);
  console.log('carol =', carol.username);

  await addAndAcceptContact(alice, bob);
  await addAndAcceptContact(alice, carol);

  console.log('--- alice creates Kick Test with bob and carol ---');
  await createGroup(alice, 'Kick Test', [bob.username, carol.username]);
  await acceptGroupInvite(bob);
  await acceptGroupInvite(carol);

  await openGroup(alice, 'Kick Test');
  await openGroup(bob, 'Kick Test');
  await openGroup(carol, 'Kick Test');

  await sendMessage(alice, 'baseline');
  let pass = true;
  for (const u of [bob, carol]) {
    try { await waitForMessage(u, 'baseline', 15_000); console.log(`  ✓ ${u.label} got baseline`); }
    catch { console.log(`  ✗ ${u.label} missed baseline`); pass = false; }
  }

  console.log('--- alice kicks bob ---');
  await kickMember(alice, bob.username);
  await snap(alice, '09-alice-after-kick');
  await snap(bob, '09-bob-after-kick');
  await snap(carol, '09-carol-after-kick');

  // Carol sees "@alice removed @bob".
  try { await waitForMessage(carol, `removed @${bob.username}`, 15_000); console.log('  ✓ carol saw the kick system message'); }
  catch { console.log('  ✗ carol did NOT see the kick system message'); pass = false; }

  // Bob's group should be gone from his conversation list.
  await bob.page.waitForTimeout(2000);
  const bobStillHas = await bob.page.locator(`button:has-text("Kick Test")`).count();
  if (bobStillHas > 0) {
    console.log('  ✗ bob still sees the group in his list');
    pass = false;
  } else {
    console.log('  ✓ bob\'s group is gone from his list');
  }

  // Alice and Carol can still message each other in the group.
  console.log('--- alice and carol continue without bob ---');
  await sendMessage(alice, 'just us now');
  try { await waitForMessage(carol, 'just us now', 15_000); console.log('  ✓ carol received post-kick message'); }
  catch { console.log('  ✗ carol did NOT receive post-kick message'); pass = false; }

  await closeAll(alice, bob, carol);
  process.exit(pass ? 0 : 1);
})().catch((err) => { console.error('FAIL:', err); process.exit(1); });
