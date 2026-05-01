// Three-user group test: alice creates a group with bob and carol,
// they exchange messages, bob leaves, alice and carol see the system
// message and bob's local group state is gone.
//
// Run: npx tsx e2e/run.ts e2e/06-group-leave.ts

import {
  newUser, register, aliceAddContact, acceptIncomingRequest,
  openConversation, sendMessage, waitForMessage, readMessages,
  snap, closeAll,
} from './lib.js';
import type { TestUser } from './lib.js';

async function addAndAcceptContact(initiator: TestUser, recipient: TestUser) {
  await aliceAddContact(initiator, recipient.username);
  await acceptIncomingRequest(recipient);
}

async function createGroup(creator: TestUser, name: string, memberUsernames: string[]) {
  // Open the "New group" panel from the conversation list header.
  await creator.page.locator('button[title="New group"]').click();
  await creator.page.locator('h2:has-text("New group")').waitFor({ state: 'visible', timeout: 5_000 });

  // Name the group.
  await creator.page.locator('input[placeholder="Group name"]').fill(name);

  // Tick each member from the contact list inside the New-group modal.
  // (There's an outer conversation-list tile with the same text.)
  const modal = creator.page.locator('h2:has-text("New group")').locator('xpath=ancestor::div[contains(@class,"rounded-2xl")][1]');
  for (const username of memberUsernames) {
    await modal.locator(`button:has-text("@${username}")`).click();
  }

  // Click Create.
  await creator.page.locator('button:has-text("Create group")').click();
  await creator.page.waitForTimeout(2000);
}

async function acceptGroupInvite(user: TestUser, timeout = 30_000) {
  // The invitation modal pops up automatically when an invite arrives.
  await user.page.locator('h2:has-text("Group invitations")').waitFor({ state: 'visible', timeout });
  await user.page.locator('button:has-text("Join")').first().click();
  await user.page.waitForTimeout(2500);
}

async function openGroup(user: TestUser, groupName: string) {
  await user.page.locator(`button:has-text("${groupName}")`).first().click();
  await user.page.waitForTimeout(500);
}

async function leaveGroup(user: TestUser) {
  // Trash icon in the conversation header — for groups it reads "Leave group".
  await user.page.locator('button[title="Leave group"]').click();
  await user.page.locator('text=Leave group?').waitFor({ state: 'visible', timeout: 5_000 });
  await user.page.locator('button:has-text("Leave"):not(:has-text("group"))').click();
  await user.page.waitForTimeout(2000);
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

  console.log('--- alice adds bob and carol as contacts ---');
  await addAndAcceptContact(alice, bob);
  await addAndAcceptContact(alice, carol);

  // Both bob and carol need to have alice as a known peer too. The
  // accepted-request side already calls addContactByKey with @alice, so
  // they should both have her. Skip extra setup.

  const groupName = 'Test Group';
  console.log(`--- alice creates a group "${groupName}" with bob and carol ---`);
  await createGroup(alice, groupName, [bob.username, carol.username]);
  await snap(alice, '06-alice-after-create-group');

  console.log('--- bob accepts the invite ---');
  await snap(bob, '06-bob-before-accept-invite');
  await acceptGroupInvite(bob);
  await snap(bob, '06-bob-after-accept-invite');

  console.log('--- carol accepts the invite ---');
  await acceptGroupInvite(carol);
  await snap(carol, '06-carol-after-accept-invite');

  // All three open the group conversation.
  await openGroup(alice, groupName);
  await openGroup(bob, groupName);
  await openGroup(carol, groupName);

  console.log('--- alice sends a group message ---');
  await sendMessage(alice, 'hello group');

  let pass = true;
  for (const u of [bob, carol]) {
    try {
      await waitForMessage(u, 'hello group', 15_000);
      console.log(`  ✓ ${u.label} received "hello group"`);
    } catch {
      console.log(`  ✗ ${u.label} did NOT receive "hello group"`);
      pass = false;
    }
  }

  console.log('--- bob sends a reply ---');
  await sendMessage(bob, 'hello from bob');
  for (const u of [alice, carol]) {
    try {
      await waitForMessage(u, 'hello from bob', 15_000);
      console.log(`  ✓ ${u.label} received "hello from bob"`);
    } catch {
      console.log(`  ✗ ${u.label} did NOT receive "hello from bob"`);
      pass = false;
    }
  }

  console.log('--- bob leaves the group ---');
  await leaveGroup(bob);
  await snap(bob, '06-bob-after-leave');
  await snap(alice, '06-alice-after-bob-left');
  await snap(carol, '06-carol-after-bob-left');

  // Alice and carol should see a "left" system message.
  const leftPattern = `@${bob.username} left the group`;
  for (const u of [alice, carol]) {
    try {
      await waitForMessage(u, leftPattern, 15_000);
      console.log(`  ✓ ${u.label} saw the leave system message`);
    } catch {
      console.log(`  ✗ ${u.label} did NOT see the leave system message`);
      pass = false;
    }
  }

  // Bob's conversation list should no longer show the group.
  const bobStillHasGroup = await bob.page.locator(`button:has-text("${groupName}")`).count();
  if (bobStillHasGroup > 0) {
    console.log(`  ✗ bob still sees the group in his conversation list`);
    pass = false;
  } else {
    console.log(`  ✓ bob's group is gone from his list`);
  }

  // Final messages from Alice should still reach Carol but NOT Bob.
  console.log('--- alice sends one more after bob left ---');
  await openGroup(alice, groupName);
  await sendMessage(alice, 'after bob left');
  try {
    await waitForMessage(carol, 'after bob left', 15_000);
    console.log(`  ✓ carol received post-leave message`);
  } catch {
    console.log(`  ✗ carol did NOT receive post-leave message`);
    pass = false;
  }
  // Bob shouldn't see it — the group is gone from his client.
  // (We skip the negative assertion; it would just be a 15s wait.)

  console.log('alice sees:', await readMessages(alice));
  console.log('carol sees:', await readMessages(carol));

  await closeAll(alice, bob, carol);
  process.exit(pass ? 0 : 1);
})().catch((err) => { console.error('FAIL:', err); process.exit(1); });
