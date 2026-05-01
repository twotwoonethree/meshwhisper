// Three-user group test: alice creates a group with bob, then alice
// adds carol to the group. Verify all three end up in sync, system
// messages appear, and post-add messaging works in all directions.
//
// Run: npx tsx e2e/run.ts e2e/07-group-add-member.ts

import {
  newUser, register, aliceAddContact, acceptIncomingRequest,
  openConversation, sendMessage, waitForMessage, snap, closeAll,
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
  for (const username of memberUsernames) {
    await modal.locator(`button:has-text("@${username}")`).click();
  }
  await creator.page.locator('button:has-text("Create group")').click();
  await creator.page.waitForTimeout(2000);
}

async function acceptGroupInvite(user: TestUser, timeout = 30_000) {
  await user.page.locator('h2:has-text("Group invitations")').waitFor({ state: 'visible', timeout });
  await user.page.locator('button:has-text("Join")').first().click();
  await user.page.waitForTimeout(2500);
}

async function openGroup(user: TestUser, groupName: string) {
  await user.page.locator(`button:has-text("${groupName}")`).first().click();
  await user.page.waitForTimeout(500);
}

async function addGroupMember(admin: TestUser, peerUsername: string) {
  await admin.page.locator('button[title="Add member"]').click();
  await admin.page.locator('h2:has-text("Add member")').waitFor({ state: 'visible', timeout: 5_000 });
  // Scope to the modal so we don't match the conversation-list tile.
  const modal = admin.page.locator('h2:has-text("Add member")').locator('xpath=ancestor::div[contains(@class,"rounded-2xl")][1]');
  await modal.locator(`button:has-text("@${peerUsername}")`).click();
  await admin.page.waitForTimeout(2500);
}

(async () => {
  const alice = await newUser('alice');
  const bob = await newUser('bob');
  const carol = await newUser('carol');

  console.log('--- registering three users ---');
  await register(alice);
  await register(bob);
  await register(carol);
  console.log('alice =', alice.username);
  console.log('bob   =', bob.username);
  console.log('carol =', carol.username);

  // Alice needs both Bob and Carol as contacts (so she has their edKeys).
  // Bob and Carol DON'T need to know each other yet — that's the point
  // of this test: post-create add should propagate Carol's keys to Bob.
  console.log('--- alice adds bob and carol as contacts ---');
  await addAndAcceptContact(alice, bob);
  await addAndAcceptContact(alice, carol);

  const groupName = 'Add Member Test';
  console.log(`--- alice creates a group "${groupName}" with just bob ---`);
  await createGroup(alice, groupName, [bob.username]);

  console.log('--- bob accepts the invite ---');
  await acceptGroupInvite(bob);

  await openGroup(alice, groupName);
  await openGroup(bob, groupName);

  console.log('--- baseline: alice sends, bob receives ---');
  await sendMessage(alice, 'hello bob (just us so far)');
  let pass = true;
  try {
    await waitForMessage(bob, 'hello bob (just us so far)', 15_000);
    console.log('  ✓ bob received baseline');
  } catch {
    console.log('  ✗ bob did NOT receive baseline');
    pass = false;
  }

  console.log('--- alice adds carol ---');
  await addGroupMember(alice, carol.username);
  await snap(alice, '07-alice-after-add');

  console.log('--- carol accepts the invite ---');
  await acceptGroupInvite(carol);
  await snap(carol, '07-carol-after-accept');

  // Bob should see a system message that carol was added.
  try {
    await waitForMessage(bob, 'added', 15_000);
    console.log('  ✓ bob saw the "added" system message');
  } catch {
    console.log('  ✗ bob did NOT see the "added" system message');
    pass = false;
  }

  await openGroup(carol, groupName);

  console.log('--- alice sends a message; carol must receive ---');
  await sendMessage(alice, 'welcome carol');
  for (const u of [bob, carol]) {
    try {
      await waitForMessage(u, 'welcome carol', 15_000);
      console.log(`  ✓ ${u.label} received "welcome carol"`);
    } catch {
      console.log(`  ✗ ${u.label} did NOT receive "welcome carol"`);
      pass = false;
    }
  }

  console.log('--- carol sends a message; alice and bob must receive ---');
  await sendMessage(carol, 'hi everyone');
  for (const u of [alice, bob]) {
    try {
      await waitForMessage(u, 'hi everyone', 15_000);
      console.log(`  ✓ ${u.label} received "hi everyone"`);
    } catch {
      console.log(`  ✗ ${u.label} did NOT receive "hi everyone"`);
      pass = false;
    }
  }

  console.log('--- bob sends a message; carol must receive (non-creator → late-added member) ---');
  await sendMessage(bob, 'welcome from bob');
  for (const u of [alice, carol]) {
    try {
      await waitForMessage(u, 'welcome from bob', 15_000);
      console.log(`  ✓ ${u.label} received "welcome from bob"`);
    } catch {
      console.log(`  ✗ ${u.label} did NOT receive "welcome from bob"`);
      pass = false;
    }
  }

  await closeAll(alice, bob, carol);
  process.exit(pass ? 0 : 1);
})().catch((err) => { console.error('FAIL:', err); process.exit(1); });
