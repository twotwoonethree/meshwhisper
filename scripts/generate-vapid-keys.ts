#!/usr/bin/env tsx
// ============================================================
// Generate VAPID keys for the MeshWhisper push service.
//
// Run once before deploying:
//   npx tsx scripts/generate-vapid-keys.ts
//
// Copy the output into your .env file (or server environment).
// Keep VAPID_PRIVATE_KEY secret — treat it like a password.
// ============================================================

import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();

console.log('');
console.log('VAPID keys generated. Add these to your .env file:\n');
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log(`VAPID_SUBJECT=mailto:ops@example.com`);
console.log('');
console.log('Also add the public key to your service worker registration:');
console.log(`  applicationServerKey: "${keys.publicKey}"`);
console.log('');
