// ============================================================
// Relay signed-transfer enforcement (stage 2)
//
// Stage 1 made the default policy reject silent takeover. Stage 2
// adds a wire format the current owner can sign to authorize a
// specific new key to take their username.
//
// These tests exercise the relay HTTP API directly (no SDK init),
// minting Ed25519 keypairs and signatures with @noble/curves so we
// can construct both well-formed and malformed transferAuth payloads.
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { ed25519 } from '@noble/curves/ed25519';

// ---- Relay harness (kept local for the same reason as namespace-policy.test.ts) ----

async function waitForRelay(port: number, proc: childProcess.ChildProcess, timeoutMs = 10000): Promise<void> {
  let exited = false;
  let exitCode: number | null = null;
  proc.once('exit', (code) => { exited = true; exitCode = code; });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`Relay exited early (code ${exitCode})`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Relay did not start within ${timeoutMs}ms`);
}

function spawnRelay(port: number): { proc: childProcess.ChildProcess; dbPath: string } {
  const dbPath = path.join(os.tmpdir(), `mw-xfer-${port}-${Date.now()}.db`);
  const nodeDir = path.resolve(__dirname, '../node');
  const distEntry = path.join(nodeDir, 'dist/index.js');
  const srcEntry = path.join(nodeDir, 'src/index.ts');
  const useCompiled = fs.existsSync(distEntry);
  const proc = childProcess.spawn(
    useCompiled ? 'node' : 'npx',
    useCompiled ? [distEntry] : ['tsx', srcEntry],
    {
      cwd: nodeDir,
      env: { ...process.env, PORT: String(port), DB_PATH: dbPath, NODE_ENV: 'test' },
      stdio: 'pipe',
    },
  );
  return { proc, dbPath };
}

function stopRelay(proc: childProcess.ChildProcess, dbPath: string): void {
  proc.kill('SIGTERM');
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + ext); } catch { /* ignore */ }
  }
}

// ---- Ed25519 + wire-format helpers ----

interface KeyPair { sk: Uint8Array; pk: Uint8Array; pkHex: string }
function mintKey(): KeyPair {
  const sk = ed25519.utils.randomPrivateKey();
  const pk = ed25519.getPublicKey(sk);
  return { sk, pk, pkHex: Buffer.from(pk).toString('hex') };
}

function buildCanonical(namespace: string, username: string, toPubHex: string, expiresAt: number): Uint8Array {
  return new TextEncoder().encode(
    ['meshwhisper.username-transfer.v1', namespace, username, toPubHex, String(expiresAt)].join('\n'),
  );
}

function mintTransferAuth(
  signer: KeyPair,
  namespace: string,
  username: string,
  toPubHex: string,
  expiresAt: number,
): { fromPublicKey: string; expiresAt: number; signature: string } {
  const msg = buildCanonical(namespace, username, toPubHex, expiresAt);
  const sig = ed25519.sign(msg, signer.sk);
  return {
    fromPublicKey: signer.pkHex,
    expiresAt,
    signature: Buffer.from(sig).toString('base64'),
  };
}

const fakeBundle = (seed: string) => Buffer.from(`bundle-${seed}`).toString('base64');

// ---- Suite ----

describe('Relay signed-transfer (stage 2)', () => {
  const PORT = 19884;
  const NS = 'com.test.transfer';
  const BASE = `http://127.0.0.1:${PORT}`;
  let relayProc: childProcess.ChildProcess;
  let dbPath: string;

  beforeAll(async () => {
    ({ proc: relayProc, dbPath } = spawnRelay(PORT));
    await waitForRelay(PORT, relayProc, 15000);
  }, 15000);

  afterAll(() => stopRelay(relayProc, dbPath));

  // Each test gets its own (namespace, username) pair so they don't
  // interact through shared directory state.
  let counter = 0;
  function nextCase(): { ns: string; username: string } {
    counter += 1;
    return { ns: `${NS}.${counter}`, username: `user${counter}` };
  }

  async function register(
    ns: string,
    pk: KeyPair,
    bundle: string,
    username?: string,
    transferAuth?: { fromPublicKey: string; expiresAt: number; signature: string },
  ) {
    return fetch(`${BASE}/directory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        namespace: ns,
        publicKey: pk.pkHex,
        bundle,
        ...(username ? { username } : {}),
        ...(transferAuth ? { transferAuth } : {}),
      }),
    });
  }

  it('valid token from the current owner allows takeover', async () => {
    const { ns, username } = nextCase();
    const alice = mintKey();
    const bob = mintKey();

    expect((await register(ns, alice, fakeBundle('a'), username)).status).toBe(200);

    const auth = mintTransferAuth(alice, ns, username, bob.pkHex, Date.now() + 60_000);
    const takeover = await register(ns, bob, fakeBundle('b'), username, auth);
    expect(takeover.status).toBe(200);

    const lookup = await fetch(`${BASE}/directory?namespace=${ns}&username=${username}`);
    expect((await lookup.json()).publicKey).toBe(bob.pkHex);
  });

  it('rejects a token signed by someone other than the current owner', async () => {
    const { ns, username } = nextCase();
    const alice = mintKey();
    const bob = mintKey();
    const eve = mintKey();

    await register(ns, alice, fakeBundle('a'), username);

    // Eve signs a token "transferring" alice's username to bob. Eve isn't
    // alice; the relay binds verification to the actual current owner's key.
    const eveAuth = mintTransferAuth(eve, ns, username, bob.pkHex, Date.now() + 60_000);
    const res = await register(ns, bob, fakeBundle('b'), username, eveAuth);
    expect(res.status).toBe(403);
  });

  it('rejects an expired token', async () => {
    const { ns, username } = nextCase();
    const alice = mintKey();
    const bob = mintKey();

    await register(ns, alice, fakeBundle('a'), username);

    const expired = mintTransferAuth(alice, ns, username, bob.pkHex, Date.now() - 1000);
    const res = await register(ns, bob, fakeBundle('b'), username, expired);
    expect(res.status).toBe(403);
  });

  it('rejects a token where the new owner key was forged after signing', async () => {
    // Eve intercepts a token alice signed for bob, swaps her publicKey in
    // the registration. Signature was over bob's pubkey; verification fails.
    const { ns, username } = nextCase();
    const alice = mintKey();
    const bob = mintKey();
    const eve = mintKey();

    await register(ns, alice, fakeBundle('a'), username);

    const authForBob = mintTransferAuth(alice, ns, username, bob.pkHex, Date.now() + 60_000);
    const res = await register(ns, eve, fakeBundle('e'), username, authForBob);
    expect(res.status).toBe(403);
  });

  it('rejects a token whose namespace differs from the registration', async () => {
    const { ns, username } = nextCase();
    const otherNs = `${ns}.other`;
    const alice = mintKey();
    const bob = mintKey();

    // alice owns @user in BOTH namespaces independently
    await register(ns, alice, fakeBundle('a'), username);
    await register(otherNs, alice, fakeBundle('a2'), username);

    // Token signed for OTHER namespace, submitted against the first
    const wrongNsAuth = mintTransferAuth(alice, otherNs, username, bob.pkHex, Date.now() + 60_000);
    const res = await register(ns, bob, fakeBundle('b'), username, wrongNsAuth);
    expect(res.status).toBe(403);
  });

  it('rejects a token whose username differs from the registration', async () => {
    const { ns, username } = nextCase();
    const alice = mintKey();
    const bob = mintKey();

    await register(ns, alice, fakeBundle('a'), username);

    // Token signed by alice, but for a DIFFERENT username than the
    // takeover targets. Canonical-message verification reconstructs
    // with the target username (`username`), which doesn't match
    // what alice actually signed.
    const wrongUsernameAuth = mintTransferAuth(
      alice, ns, 'someotherusername', bob.pkHex, Date.now() + 60_000,
    );
    const res = await register(ns, bob, fakeBundle('b'), username, wrongUsernameAuth);
    expect(res.status).toBe(403);
  });

  it('a takeover chain works: alice → bob → carol', async () => {
    const { ns, username } = nextCase();
    const alice = mintKey();
    const bob = mintKey();
    const carol = mintKey();

    await register(ns, alice, fakeBundle('a'), username);

    const aliceToBob = mintTransferAuth(alice, ns, username, bob.pkHex, Date.now() + 60_000);
    expect((await register(ns, bob, fakeBundle('b'), username, aliceToBob)).status).toBe(200);

    const bobToCarol = mintTransferAuth(bob, ns, username, carol.pkHex, Date.now() + 60_000);
    expect((await register(ns, carol, fakeBundle('c'), username, bobToCarol)).status).toBe(200);

    const lookup = await fetch(`${BASE}/directory?namespace=${ns}&username=${username}`);
    expect((await lookup.json()).publicKey).toBe(carol.pkHex);
  });

  it('a valid token from alice cannot transfer a username alice does not own', async () => {
    const { ns } = nextCase();
    const alice = mintKey();
    const bob = mintKey();
    const real = mintKey();

    // `real` owns @target; alice does not.
    await register(ns, real, fakeBundle('r'), 'target');

    // alice signs a token authorizing bob to take @target
    const fraudulent = mintTransferAuth(alice, ns, 'target', bob.pkHex, Date.now() + 60_000);
    const res = await register(ns, bob, fakeBundle('b'), 'target', fraudulent);
    expect(res.status).toBe(403);
  });

  it('rejects a malformed transferAuth (missing fields) with 400', async () => {
    const { ns, username } = nextCase();
    const alice = mintKey();
    const bob = mintKey();
    await register(ns, alice, fakeBundle('a'), username);

    const res = await fetch(`${BASE}/directory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        namespace: ns,
        publicKey: bob.pkHex,
        bundle: fakeBundle('b'),
        username,
        transferAuth: { fromPublicKey: alice.pkHex }, // missing expiresAt + signature
      }),
    });
    expect(res.status).toBe(400);
  });
});
