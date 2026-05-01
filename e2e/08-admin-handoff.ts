// Admin leaving a group must transfer the role first. This test runs
// the two paths (transfer to a successor, become adminless) end-to-end.
//
// Run: npx tsx e2e/run.ts e2e/08-admin-handoff.ts

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
  for (const username of memberUsernames) {
    await modal.locator(`button:has-text("@${username}")`).click();
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

async function adminLeaveBecomingAdminless(admin: TestUser) {
  await admin.page.locator('button[title="Leave group"]').click();
  // Admin-handoff dialog appears.
  await admin.page.locator('h2:has-text("Before you leave")').waitFor({ state: 'visible', timeout: 5_000 });
  await admin.page.locator('button:has-text("Make admin-less and leave")').click();
  await admin.page.waitForTimeout(2500);
}

async function adminLeaveTransferringTo(admin: TestUser, peerUsername: string) {
  await admin.page.locator('button[title="Leave group"]').click();
  await admin.page.locator('h2:has-text("Before you leave")').waitFor({ state: 'visible', timeout: 5_000 });
  // Pick the successor inside the modal (avoid the conversation list tile).
  const modal = admin.page.locator('h2:has-text("Before you leave")').locator('xpath=ancestor::div[contains(@class,"rounded-2xl")][1]');
  await modal.locator(`button:has-text("@${peerUsername}")`).click();
  await admin.page.waitForTimeout(2500);
}

async function addGroupMember(user: TestUser, peerUsername: string) {
  await user.page.locator('button[title="Add member"]').click();
  await user.page.locator('h2:has-text("Add member")').waitFor({ state: 'visible', timeout: 5_000 });
  const modal = user.page.locator('h2:has-text("Add member")').locator('xpath=ancestor::div[contains(@class,"rounded-2xl")][1]');
  await modal.locator(`button:has-text("@${peerUsername}")`).click();
  await user.page.waitForTimeout(2500);
}

(async () => {
  let pass = true;

  // ---------- Path 1: admin makes group admin-less and leaves ----------
  console.log('=== Path 1: admin → adminless → leave; bob (now in adminless group) adds carol ===');
  {
    const alice = await newUser('alice');
    const bob = await newUser('bob');
    const carol = await newUser('carol');

    await register(alice);
    await register(bob);
    await register(carol);
    console.log('alice =', alice.username);
    console.log('bob   =', bob.username);
    console.log('carol =', carol.username);

    // Alice contacts Bob and Carol so she has both edKeys; Bob also needs
    // Carol as a contact for him to add her later.
    await addAndAcceptContact(alice, bob);
    await addAndAcceptContact(alice, carol);
    await addAndAcceptContact(bob, carol);

    await createGroup(alice, 'Adminless Path', [bob.username]);
    await acceptGroupInvite(bob);
    await openGroup(alice, 'Adminless Path');
    await openGroup(bob, 'Adminless Path');

    await sendMessage(alice, 'baseline');
    try { await waitForMessage(bob, 'baseline', 15_000); console.log('  ✓ baseline received'); }
    catch { console.log('  ✗ baseline missed'); pass = false; }

    console.log('--- alice → adminless and leaves ---');
    await adminLeaveBecomingAdminless(alice);
    await snap(bob, '08-bob-after-alice-adminless-leave');

    // Bob should see two system messages: "made admin-less" and "alice left".
    try { await waitForMessage(bob, 'admin-less', 15_000); console.log('  ✓ bob saw admin-less message'); }
    catch { console.log('  ✗ bob did NOT see admin-less message'); pass = false; }
    try { await waitForMessage(bob, 'left the group', 15_000); console.log('  ✓ bob saw alice-left message'); }
    catch { console.log('  ✗ bob did NOT see alice-left message'); pass = false; }

    // Bob (in an adminless group) can now add Carol.
    console.log('--- bob (non-creator) adds carol to the adminless group ---');
    await addGroupMember(bob, carol.username);
    await acceptGroupInvite(carol);
    await openGroup(carol, 'Adminless Path');

    await sendMessage(bob, 'hi carol from bob');
    try { await waitForMessage(carol, 'hi carol from bob', 15_000); console.log('  ✓ carol received bob\'s message in adminless group'); }
    catch { console.log('  ✗ carol did NOT receive bob\'s message'); pass = false; }

    await closeAll(alice, bob, carol);
  }

  // ---------- Path 2: admin transfers to bob, then leaves ----------
  console.log('\n=== Path 2: admin → transfer to bob → leave; bob (now admin) adds carol ===');
  {
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
    await addAndAcceptContact(bob, carol);

    await createGroup(alice, 'Transfer Path', [bob.username]);
    await acceptGroupInvite(bob);
    await openGroup(alice, 'Transfer Path');
    await openGroup(bob, 'Transfer Path');

    console.log('--- alice transfers to bob and leaves ---');
    await adminLeaveTransferringTo(alice, bob.username);
    await snap(bob, '08-bob-after-alice-transfer-leave');

    // Bob (receiver) sees "@alice made @bob the admin" (inbound wording).
    try { await waitForMessage(bob, 'the admin', 15_000); console.log('  ✓ bob saw transfer message'); }
    catch { console.log('  ✗ bob did NOT see transfer message'); pass = false; }
    try { await waitForMessage(bob, 'left the group', 15_000); console.log('  ✓ bob saw alice-left message'); }
    catch { console.log('  ✗ bob did NOT see alice-left message'); pass = false; }

    console.log('--- bob (now admin) adds carol ---');
    await addGroupMember(bob, carol.username);
    await acceptGroupInvite(carol);
    await openGroup(carol, 'Transfer Path');

    await sendMessage(bob, 'hi carol — i\'m admin now');
    try { await waitForMessage(carol, "hi carol — i'm admin now", 15_000); console.log('  ✓ carol received bob\'s message'); }
    catch { console.log('  ✗ carol did NOT receive bob\'s message'); pass = false; }

    await closeAll(alice, bob, carol);
  }

  process.exit(pass ? 0 : 1);
})().catch((err) => { console.error('FAIL:', err); process.exit(1); });
