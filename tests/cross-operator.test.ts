// ============================================================
// Cross-operator + interop — the full "email model" end to end (ADR-009 stage-2)
//
// Two SEPARATE operators' relays, federated together, and two live SDK peers
// in DIFFERENT namespaces — one homed on each relay. Proves that a real,
// E2EE message crosses BOTH boundaries at once: different app (namespace) AND
// different operator (relay), addressed via interop and routed over the
// federation link, decrypted on the far side.
//
// Builds on what already exists: federation v1 forwards opaque packets between
// relays (tests/federation.test.ts), interop addresses into the peer's namespace
// (tests/cross-namespace.test.ts). This composes them with real SDK instances.
//
// Two live instances ⇒ two child processes (the SDK is a per-process singleton).
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodeCrypto from 'node:crypto';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.join(__dirname, '..');
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');

const PORT_A = 19910;
const PORT_B = 19911;

// ---- relay (federation) harness ----

function generateFederationKeyFile(filePath: string): string {
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const publicKeyHex = spki.subarray(spki.length - 32).toString('hex');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ publicKeyHex, privateKeyPkcs8Base64: pkcs8.toString('base64') }));
  return publicKeyHex;
}

function spawnRelay(port: number, dir: string, env: Record<string, string>): childProcess.ChildProcess {
  return childProcess.spawn(TSX, [path.join(REPO, 'node', 'src', 'index.ts')], {
    cwd: path.join(REPO, 'node'),
    env: { ...process.env, PORT: String(port), DB_PATH: path.join(dir, 'relay.db'), NODE_ENV: 'test', ...env },
    stdio: 'pipe',
  });
}

async function waitForHealth(port: number, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`relay :${port} did not start`);
}

async function waitForFederation(port: number, expected: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json() as Promise<Record<string, number>>).catch(() => null);
    if (h && h.federationPeersConnected === expected) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`relay :${port} never reached federationPeersConnected=${expected}`);
}

// ---- worker harness ----

interface Worker {
  proc: childProcess.ChildProcess;
  lines: string[];
  send: (cmd: string) => void;
}

function spawnWorker(nodeUrl: string, username: string, namespace: string, interop: boolean, homeRelay?: string): Worker {
  const argv = [path.join(__dirname, 'helpers', 'interop-worker.mts'), nodeUrl, username, namespace, interop ? '1' : '0'];
  if (homeRelay) argv.push(homeRelay);
  const proc = childProcess.spawn(TSX, argv, { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines: string[] = [];
  let buf = '';
  proc.stdout!.on('data', (d: Buffer) => {
    buf += d.toString();
    const parts = buf.split('\n');
    buf = parts.pop()!;
    for (const line of parts) { lines.push(line); process.stdout.write(`[${username}] ${line}\n`); }
  });
  proc.stderr!.on('data', (d: Buffer) => process.stderr.write(`[${username}!] ${d}`));
  return { proc, lines, send: (cmd) => proc.stdin!.write(cmd + '\n') };
}

async function waitFor(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const lineStarting = (w: Worker, prefix: string) => w.lines.find((l) => l.startsWith(prefix));

/** Scrape a single Prometheus counter value from a relay's /metrics. */
async function scrapeMetric(port: number, name: string): Promise<number> {
  const body = await fetch(`http://127.0.0.1:${port}/metrics`).then((r) => r.text());
  const line = body.split('\n').find((l) => l.startsWith(`${name} `));
  return line ? Number(line.slice(name.length + 1)) : 0;
}

describe('Cross-operator + interop (ADR-009 stage-2)', () => {
  let relayA: childProcess.ChildProcess;
  let relayB: childProcess.ChildProcess;
  let dirA: string;
  let dirB: string;
  let pubA: string;
  let pubB: string;

  beforeAll(async () => {
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-xo-a-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-xo-b-'));
    pubA = generateFederationKeyFile(path.join(dirA, 'fed-key.json'));
    pubB = generateFederationKeyFile(path.join(dirB, 'fed-key.json'));
    // A dials B; B allow-lists A.
    fs.writeFileSync(path.join(dirA, 'fed-peers.json'), JSON.stringify({ peers: [{ pubkey: pubB, url: `ws://127.0.0.1:${PORT_B}` }] }));
    fs.writeFileSync(path.join(dirB, 'fed-peers.json'), JSON.stringify({ peers: [{ pubkey: pubA }] }));

    const fedEnv = (dir: string) => ({
      FEDERATION_KEY_FILE: path.join(dir, 'fed-key.json'),
      FEDERATION_PEERS_FILE: path.join(dir, 'fed-peers.json'),
    });
    relayA = spawnRelay(PORT_A, dirA, fedEnv(dirA));
    relayB = spawnRelay(PORT_B, dirB, fedEnv(dirB));
    await Promise.all([waitForHealth(PORT_A), waitForHealth(PORT_B)]);
    await Promise.all([waitForFederation(PORT_A, 1), waitForFederation(PORT_B, 1)]);
  }, 40000);

  afterAll(() => {
    relayA?.kill('SIGTERM'); relayB?.kill('SIGTERM');
    for (const d of [dirA, dirB]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  it('an E2EE message crosses BOTH a namespace and an operator boundary', async () => {
    // Alice: app A, homed on relay A. Bob: app B, homed on relay B. Both interop.
    const alice = spawnWorker(`ws://127.0.0.1:${PORT_A}`, 'alice', 'com.test.opA', true);
    const bob = spawnWorker(`ws://127.0.0.1:${PORT_B}`, 'bob', 'com.test.opB', true);
    try {
      await waitFor(() => !!lineStarting(alice, 'READY') && !!lineStarting(alice, 'QR'), 25000, 'alice ready');
      await waitFor(() => !!lineStarting(bob, 'READY') && !!lineStarting(bob, 'QR'), 25000, 'bob ready');

      const bobId = lineStarting(bob, 'READY')!.split(' ')[1];
      const bobQR = lineStarting(bob, 'QR')!.slice('QR '.length);

      // Alice scans Bob's code (learns Bob's namespace), then messages him.
      alice.send(`ACCEPT ${bobQR}`);
      await waitFor(() => !!lineStarting(alice, 'ACCEPTED'), 10000, 'alice accepted');
      await new Promise((r) => setTimeout(r, 1500)); // handshake settle across the link

      alice.send(`SEND ${bobId} hello across app and operator`);

      // Bob (different namespace, different relay) should receive + decrypt it.
      await waitFor(() => bob.lines.some((l) => l.startsWith('MSG ') && l.includes('hello across app and operator')), 15000, 'bob receives cross-operator message');

      const msg = bob.lines.find((l) => l.startsWith('MSG '))!;
      expect(msg).toContain('hello across app and operator');
    } finally {
      alice.proc.kill('SIGTERM');
      bob.proc.kill('SIGTERM');
    }
  }, 60000);

  it('ADR-010: with home-relay invites the sender relay routes DIRECTLY, not by flood', async () => {
    // Same as above, but each worker advertises its relay's federation key as
    // its homeRelay. Bob's QR now carries pubB; Alice's relay (A) should route
    // her packet straight to relay B instead of flooding the federation.
    const routedBefore = await scrapeMetric(PORT_A, 'meshwhisper_federation_routed_forwards_sent_total');

    const alice = spawnWorker(`ws://127.0.0.1:${PORT_A}`, 'arouted', 'com.test.opA', true, pubA);
    const bob = spawnWorker(`ws://127.0.0.1:${PORT_B}`, 'brouted', 'com.test.opB', true, pubB);
    try {
      await waitFor(() => !!lineStarting(alice, 'READY') && !!lineStarting(alice, 'QR'), 25000, 'alice ready');
      await waitFor(() => !!lineStarting(bob, 'READY') && !!lineStarting(bob, 'QR'), 25000, 'bob ready');

      const bobId = lineStarting(bob, 'READY')!.split(' ')[1];
      const bobQR = lineStarting(bob, 'QR')!.slice('QR '.length);

      // Bob's QR must be the v2 (interop + home relay) format: 0x02 first byte.
      expect(Buffer.from(bobQR, 'base64')[0]).toBe(0x02);

      alice.send(`ACCEPT ${bobQR}`);
      await waitFor(() => !!lineStarting(alice, 'ACCEPTED'), 10000, 'alice accepted');
      await new Promise((r) => setTimeout(r, 1500));

      alice.send(`SEND ${bobId} routed straight to relay B`);

      await waitFor(() => bob.lines.some((l) => l.startsWith('MSG ') && l.includes('routed straight to relay B')), 15000, 'bob receives routed message');

      // The decisive assertion: relay A used a DIRECT routed forward (ADR-010),
      // not the broadcast flood, to reach relay B.
      const routedAfter = await scrapeMetric(PORT_A, 'meshwhisper_federation_routed_forwards_sent_total');
      expect(routedAfter).toBeGreaterThan(routedBefore);
    } finally {
      alice.proc.kill('SIGTERM');
      bob.proc.kill('SIGTERM');
    }
  }, 60000);
});
