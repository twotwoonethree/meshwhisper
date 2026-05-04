// Scenario: faithful repro of user-reported bug from 2026-05-03.
//
// Both users live in persistent Chrome profile directories (mirrors
// the "different Chrome profile per account on the same machine"
// setup). They register, converse, archive pushes. Then robby's
// Chrome window is closed entirely (context.close()) and reopened
// from the same profile directory, simulating "Robby logged back in
// after a few days." Anton's tab stays online throughout.
//
// Expected: robby sees the conversation history, robby receives
// messages sent by Anton, and Anton's send to robby succeeds (no `!`).

import {
  newPersistentUser, register, aliceAddContact, acceptIncomingRequest,
  openConversation, sendMessage, waitForMessage, snap, closeAll,
  readMessages, waitForReady,
} from './lib.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

(async () => {
  const antonDir = mkdtempSync(join(tmpdir(), 'p-anton-'));
  const robbyDir = mkdtempSync(join(tmpdir(), 'p-robby-'));

  const anton = await newPersistentUser('anton', antonDir);
  let robby = await newPersistentUser('robby', robbyDir);

  await register(anton);
  await register(robby);
  console.log('anton =', anton.username);
  console.log('robby =', robby.username);

  await aliceAddContact(anton, robby.username);
  await acceptIncomingRequest(robby);
  await openConversation(anton, robby.username);
  await openConversation(robby, anton.username);

  console.log('--- exchange messages ---');
  await sendMessage(anton, 'hello-robby-1');
  await waitForMessage(robby, 'hello-robby-1');
  await sendMessage(robby, 'hello-anton-1');
  await waitForMessage(anton, 'hello-anton-1');
  await sendMessage(anton, 'hello-robby-2');
  await waitForMessage(robby, 'hello-robby-2');

  console.log('--- waiting 10s for archive pushes to fire ---');
  await anton.page.waitForTimeout(10_000);

  console.log('--- closing robby chrome window entirely ---');
  await robby.context.close();
  await new Promise((r) => setTimeout(r, 2000));

  console.log('--- robby reopens chrome (persistent profile, IDB preserved) ---');
  robby = await newPersistentUser('robby', robbyDir);
  await robby.page.waitForTimeout(5000);
  await snap(robby, '18-robby-after-relaunch');

  // What state does Prudence land in after the relaunch?
  // - If localStorage `prudence:username` survived, robby sees Login (unlock)
  // - Otherwise, Onboarding
  let pass = true;
  const visibleText = await robby.page.locator('body').innerText();
  console.log('--- robby page state after relaunch (first 300 chars) ---');
  console.log(visibleText.slice(0, 300).replace(/\n/g, ' | '));

  // If robby is at the unlock screen, type the password and continue.
  const unlockButton = robby.page.locator('button[type="submit"]:has-text("Unlock")');
  if (await unlockButton.count() > 0) {
    console.log('--- robby is locked; entering password ---');
    await robby.page.locator('input[autocomplete="current-password"]').fill(robby.password);
    await unlockButton.click();
    await robby.page.waitForTimeout(4000);
  }

  await waitForReady(robby).catch(() => { console.log('  (waitForReady timed out)'); });
  await snap(robby, '18-robby-after-unlock');

  // Did the conversation list survive?
  try {
    await openConversation(robby, anton.username);
    console.log('  ✓ robby sees the conversation with anton');
  } catch {
    console.log('  ✗ robby does NOT see the conversation — repro of user bug');
    pass = false;
  }

  // History?
  for (const text of ['hello-robby-1', 'hello-anton-1', 'hello-robby-2']) {
    try { await waitForMessage(robby, text, 5_000); console.log(`  ✓ history: ${text}`); }
    catch { console.log(`  ✗ MISSING from history: ${text}`); pass = false; }
  }

  // Anton sends a new message — does it arrive at the relaunched robby?
  console.log('--- anton sends "after-robby-relaunch" ---');
  await sendMessage(anton, 'after-robby-relaunch');
  try {
    await waitForMessage(robby, 'after-robby-relaunch', 20_000);
    console.log('  ✓ robby received post-relaunch message');
  } catch {
    console.log('  ✗ robby did NOT receive post-relaunch message');
    pass = false;
  }

  // And does robby's reply round-trip?
  console.log('--- robby replies "robby-replies" ---');
  await sendMessage(robby, 'robby-replies');
  try {
    await waitForMessage(anton, 'robby-replies', 20_000);
    console.log('  ✓ anton received robby-replies');
  } catch {
    console.log('  ✗ anton did NOT receive robby-replies');
    pass = false;
  }

  // Anton tries another send to confirm no '!' state on his side.
  console.log('--- anton sends one more "anton-final" ---');
  await sendMessage(anton, 'anton-final');
  try {
    await waitForMessage(robby, 'anton-final', 20_000);
    console.log('  ✓ robby received anton-final');
  } catch {
    console.log('  ✗ robby did NOT receive anton-final (would explain "!" indicator)');
    pass = false;
  }

  console.log('anton sees:', await readMessages(anton));
  console.log('robby sees:', await readMessages(robby));

  await closeAll(anton, robby);
  process.exit(pass ? 0 : 1);
})().catch((err) => { console.error('FAIL:', err); process.exit(1); });
