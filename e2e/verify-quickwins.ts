// Verifies the elevate quick-wins against a real two-peer local stack:
//   (1) unread count in the browser tab title
//   (2) conversation-list search toggle + filter + no-results
//   (3) draft message persistence across reload, per conversation
//   (4) message delete on your own DM message
// Run: npx tsx e2e/run.ts e2e/verify-quickwins.ts

import {
  newUser, register, waitForReady, aliceAddContact, acceptIncomingRequest,
  openConversation, sendMessage, snap, closeAll,
} from './lib.js';

const results: Record<string, boolean> = {};

(async () => {
  const alice = await newUser('alice');
  const bob = await newUser('bob');

  await register(alice);
  await register(bob);
  await waitForReady(alice);
  await waitForReady(bob);
  console.log(`alice=${alice.username}  bob=${bob.username}`);

  // Establish a DM: alice adds bob (auto-opens her into the thread), bob accepts.
  await aliceAddContact(alice, bob.username);
  await acceptIncomingRequest(bob);
  await sendMessage(alice, 'hello from alice');
  // alice's own message renders optimistically regardless of delivery — that's
  // all the draft/delete tests need. Confirm her own bubble is present.
  await alice.page.locator('div[class*="rounded-2xl"]', { hasText: 'hello from alice' })
    .first().waitFor({ state: 'visible', timeout: 15_000 });
  console.log('--- conversation established + alice sees her own message ---');

  // ---------- (3) DRAFT PERSISTENCE ----------
  // Type a draft WITHOUT sending, reload, reopen, expect it restored.
  await alice.page.locator('textarea[placeholder="Message"]').fill('this is an unsent draft');
  await alice.page.waitForTimeout(500); // let persistDraft write to localStorage
  await alice.page.reload({ waitUntil: 'domcontentloaded' });
  await alice.page.waitForTimeout(3000);
  await openConversation(alice, bob.username);
  await alice.page.waitForTimeout(800);
  const restored = await alice.page.locator('textarea[placeholder="Message"]').inputValue();
  results.draft = restored === 'this is an unsent draft';
  console.log(`[draft] restored="${restored}" PASS=${results.draft}`);
  await snap(alice, 'qw-3-draft-restored');

  // ---------- (4) MESSAGE DELETE ----------
  alice.page.on('dialog', (d) => { void d.accept(); }); // auto-accept the confirm()
  await alice.page.locator('button[title="Message actions"]').first().click({ force: true });
  await alice.page.waitForTimeout(300);
  await snap(alice, 'qw-4-actions-menu');
  await alice.page.locator('button:has-text("Delete")').click();
  await alice.page.waitForTimeout(1500);
  const remaining = await alice.page
    .locator('div[class*="rounded-2xl"]', { hasText: 'hello from alice' }).count();
  results.delete = remaining === 0;
  console.log(`[delete] bubbles still matching deleted text=${remaining} PASS=${results.delete}`);
  await snap(alice, 'qw-4-after-delete');

  // ---------- (2) CONVERSATION-LIST SEARCH ----------
  // Reload returns alice to the list view (activeConversationId is not persisted).
  await alice.page.reload({ waitUntil: 'domcontentloaded' });
  await alice.page.waitForTimeout(3000);
  await alice.page.locator('button[title="Search conversations"]').click();
  await alice.page.waitForTimeout(300);
  const search = alice.page.locator('input[placeholder="Search conversations…"]');
  await search.fill(bob.username.slice(0, 5));
  await alice.page.waitForTimeout(400);
  const matchCount = await alice.page.locator(`button:has-text("@${bob.username}")`).count();
  await snap(alice, 'qw-2-search-match');
  await search.fill('zzzz-no-such-contact');
  await alice.page.waitForTimeout(400);
  const noResults = await alice.page.locator('text=/No conversations match/i').count();
  results.search = matchCount >= 1 && noResults === 1;
  console.log(`[search] matchCount=${matchCount} noResults=${noResults} PASS=${results.search}`);
  await snap(alice, 'qw-2-search-noresults');
  // Clear search so it doesn't hide the tab-title test's state.
  await search.fill('');
  await alice.page.waitForTimeout(200);

  // ---------- (1) TAB-TITLE UNREAD BADGE ----------
  // alice is on the list (not viewing bob). bob sends → alice unread++ → "(N) Prudence".
  const titleBefore = await alice.page.title();
  await openConversation(bob, alice.username);
  await sendMessage(bob, 'ping for the unread badge');
  // Poll alice's tab title for up to ~18s — first post-handshake delivery can lag.
  let titleAfter = titleBefore;
  for (let i = 0; i < 18; i++) {
    await alice.page.waitForTimeout(1000);
    titleAfter = await alice.page.title();
    if (/^\(\d+\) Prudence$/.test(titleAfter)) break;
  }
  results.tabTitle = /^\(\d+\) Prudence$/.test(titleAfter);
  console.log(`[tab-title] before="${titleBefore}" after="${titleAfter}" PASS=${results.tabTitle}`);
  await snap(alice, 'qw-1-tab-title');

  await closeAll(alice, bob);

  // ---------- VERDICT ----------
  console.log('\n=== RESULTS ===');
  for (const [k, v] of Object.entries(results)) console.log(`  ${v ? 'PASS' : 'FAIL'}  ${k}`);
  const allPass = Object.values(results).every(Boolean);
  console.log(`\nOVERALL: ${allPass ? 'PASS' : 'FAIL'}`);
  process.exit(allPass ? 0 : 1);
})().catch((err) => { console.error('SCRIPT ERROR:', err); process.exit(1); });
