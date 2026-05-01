// First step: register two users and take screenshots so we can
// see what the UI actually looks like before scripting interactions.
// Run: npx tsx e2e/01-register-and-screenshot.ts

import { newUser, register, snap, closeAll } from './lib.js';

(async () => {
  console.log('--- creating two users ---');
  const alice = await newUser('alice');
  const bob = await newUser('bob');

  console.log('--- registering alice ---');
  await register(alice);
  console.log('alice registered as', alice.username);
  await snap(alice, 'alice-after-register');

  console.log('--- registering bob ---');
  await register(bob);
  console.log('bob registered as', bob.username);
  await snap(bob, 'bob-after-register');

  await closeAll(alice, bob);
  console.log('done. screenshots in e2e/screenshots/');
})().catch((err) => { console.error(err); process.exit(1); });
