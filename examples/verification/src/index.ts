// =============================================================================
// MeshWhisper · Verification (phone / email) reference example
//
// Demonstrates how to layer SMS / email verification on top of the MeshWhisper
// SDK without compromising its trust model. The pattern (Pattern B from
// docs/identity-patterns.md):
//
//   - The user's identity keypair is generated locally by the SDK on first
//     init. The private key NEVER leaves the device.
//   - The "verification service" (this would be your backend) issues a
//     short-lived code via SMS / email, accepts it back, and on success
//     records "phone X is currently associated with public key Y".
//   - The client, on successful verification, calls
//     `MeshWhisper.setIdentifier(phone)` to claim the handle in the relay
//     directory.
//
// The verification service learns the user's public key but nothing more.
// The MeshWhisper relay learns the public key and (after registration) the
// human-readable identifier. Neither sees message content, neither holds the
// user's private key.
//
// This demo runs both halves in one process for clarity. In a real
// deployment you'd split them: the VerificationService class would live in
// your backend (Node, Go, anything that can speak HTTP + an SMS provider's
// API), the Client section would live inside your app embedded with
// @meshwhisper/sdk. Replace `sendSimulatedSMS` with Twilio / AWS SNS /
// SendGrid / your provider of choice — that's the only change.
//
// Run:
//   npm install && npm run dev
// =============================================================================

import { MeshWhisper } from '@meshwhisper/sdk';
import { NodeStorage } from '@meshwhisper/sdk/node';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const NAMESPACE = 'org.example.verification';
const NODE = process.env.MESHWHISPER_NODE ?? 'wss://relay.meshwhisper.org';

// =============================================================================
// VERIFICATION SERVICE — would live in your backend in a real deployment.
//
// State is in-memory for this demo; in production use a database (or Redis
// with TTL) so codes survive process restarts and so attempt-counting
// works across server instances.
// =============================================================================

interface PendingVerification {
  code: string;
  expiresAt: number;
  attemptsRemaining: number;
}

class VerificationService {
  private readonly pending = new Map<string, PendingVerification>();
  // Once a phone is verified, we record which public key currently claims it
  // and at what time. Your app's database would hold this in production.
  private readonly verifiedAssociations = new Map<string, { publicKey: string; verifiedAt: number }>();

  /**
   * Submit a phone / email for verification. Generates a 6-digit code,
   * stores it with a 5-minute TTL, and triggers the gateway send.
   * Returns nothing — the response on a real backend would be "code sent,
   * check your messages."
   */
  async submitIdentifier(identifier: string): Promise<void> {
    const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
    this.pending.set(identifier, {
      code,
      expiresAt: Date.now() + 5 * 60_000,
      attemptsRemaining: 3,
    });
    await sendSimulatedSMS(identifier, code);
  }

  /**
   * Verify a code for an identifier. On success, records the (identifier,
   * publicKey) association in the service's database and returns true.
   * The `publicKey` here is the client's MeshWhisper identity key hex,
   * which the client passes along when verifying so the service can record
   * the binding.
   */
  verifyCode(identifier: string, code: string, publicKey: string): { ok: true } | { ok: false; reason: string } {
    const entry = this.pending.get(identifier);
    if (!entry) return { ok: false, reason: 'No pending verification for this identifier' };
    if (Date.now() > entry.expiresAt) {
      this.pending.delete(identifier);
      return { ok: false, reason: 'Code expired — request a new one' };
    }
    if (entry.attemptsRemaining <= 0) {
      this.pending.delete(identifier);
      return { ok: false, reason: 'Too many attempts — request a new code' };
    }
    if (entry.code !== code) {
      entry.attemptsRemaining -= 1;
      return { ok: false, reason: `Incorrect code — ${entry.attemptsRemaining} attempts left` };
    }
    this.pending.delete(identifier);
    this.verifiedAssociations.set(identifier, { publicKey, verifiedAt: Date.now() });
    return { ok: true };
  }

  /** Look up which public key is currently verified-as for an identifier. */
  whoIs(identifier: string): { publicKey: string; verifiedAt: number } | null {
    return this.verifiedAssociations.get(identifier) ?? null;
  }
}

/**
 * Pretend SMS gateway. In production, swap this for a one-liner against
 * your provider:
 *
 *   await twilio.messages.create({ to: phone, from: '+...', body: `Your code: ${code}` });
 *
 * Email is analogous via SES / SendGrid / etc.
 */
async function sendSimulatedSMS(identifier: string, code: string): Promise<void> {
  // Imitate network latency.
  await new Promise((r) => setTimeout(r, 150));
  console.log(`\n[gateway → ${identifier}] Your verification code is: ${code}\n`);
}

// =============================================================================
// CLIENT — would live inside your app, embedded with @meshwhisper/sdk.
//
// All this code does is:
//   1. Initialise MeshWhisper (which generates a local keypair on first run).
//   2. Submit the identifier to the verification service.
//   3. Accept a code from the user.
//   4. On verification success, claim the identifier in the relay directory
//      via MeshWhisper.setIdentifier.
// =============================================================================

async function runClient(service: VerificationService): Promise<void> {
  const rl = createInterface({ input, output });

  // Persistent storage so the keypair survives between runs of this demo.
  const dataDir = path.join(os.tmpdir(), `mw-verify-${process.pid}`);
  fs.mkdirSync(dataDir, { recursive: true });

  const sdk = await MeshWhisper.init({
    namespace: NAMESPACE,
    node: NODE,
    storage: new NodeStorage(dataDir),
  });
  const myPublicKey = sdk.getLocalPeerId();
  console.log(`\nclient ready. local public key: ${myPublicKey.slice(0, 12)}…`);

  const identifier = (await rl.question('Enter phone or email to verify: ')).trim();
  if (!identifier) {
    console.log('aborted');
    await sdk.shutdown();
    rl.close();
    return;
  }

  await service.submitIdentifier(identifier);
  console.log('code dispatched. (in this demo the code is also printed above for convenience.)');

  // Three attempts allowed by the service; loop until success or exhaustion.
  for (;;) {
    const code = (await rl.question('Enter the code you received: ')).trim();
    const result = service.verifyCode(identifier, code, myPublicKey);
    if (result.ok) {
      console.log('\n✓ verified.');
      break;
    }
    console.log(`✗ ${result.reason}`);
    if (result.reason.startsWith('Too many') || result.reason.startsWith('Code expired')) {
      console.log('aborted');
      await sdk.shutdown();
      rl.close();
      return;
    }
  }

  // Claim the identifier in the relay directory. This is the moment the
  // human-readable name becomes resolvable — `MeshWhisper.addContactByKey('@<identifier>')`
  // on another user's device will now return our public key.
  //
  // Under the default 'signed-transfer' namespace policy, the same key
  // can re-register the same identifier any number of times (e.g. on
  // every app launch) without surprise. A *different* key trying to
  // claim the same identifier is rejected — see docs/identifier-patterns.md.
  try {
    await MeshWhisper.setIdentifier(identifier);
    console.log(`✓ registered ${identifier} → ${myPublicKey.slice(0, 12)}… in the relay directory.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`\n✗ relay registration failed: ${msg}`);
    console.log('  (most likely: another key has already claimed this identifier under signed-transfer policy.');
    console.log('   in production you would either prompt the user to pick a different handle, OR run a');
    console.log('   recovery flow — see docs/multi-device.md for the linked-devices pattern.)');
  }

  // Show the binding the service recorded — this is what a "is alice on the
  // service?" query would return in production (your backend's DB).
  const binding = service.whoIs(identifier);
  if (binding) {
    console.log(`service db: ${identifier} → ${binding.publicKey.slice(0, 12)}… (verified at ${new Date(binding.verifiedAt).toISOString()})`);
  }

  await sdk.shutdown();
  rl.close();
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
  console.log('MeshWhisper · verification demo (single-process)');
  console.log(`namespace: ${NAMESPACE}`);
  console.log(`relay: ${NODE}`);

  const service = new VerificationService();
  await runClient(service);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
