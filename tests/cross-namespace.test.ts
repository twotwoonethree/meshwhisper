// ============================================================
// MeshWhisper — Cross-namespace messaging (ADR-009 stage-1 spike)
//
// Proves that a message can cross from one namespace to another,
// end-to-end encrypted, over a single (namespace-blind) relay — i.e.
// that ADR-001's identity-layer isolation is a sender-side addressing
// policy, not a crypto wall.
//
// Mechanism: a packet's destHash bakes in the namespace, and the recipient
// listens on destHash(theirNamespace, theirKey). So a sender in namespace A
// reaches a recipient in namespace B simply by addressing into B's namespace
// (SDK.setPeerNamespace) instead of its own. The relay is unchanged.
//
// Uses the store-and-forward pattern because init() is a per-process
// singleton (one live instance at a time), mirroring tests/integration.test.ts.
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const TEST_DEV_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

async function waitForRelay(port: number, proc: childProcess.ChildProcess, timeoutMs = 15000): Promise<void> {
  proc.stdout?.on('data', (d: Buffer) => process.stdout.write(`[relay] ${d}`));
  proc.stderr?.on('data', (d: Buffer) => process.stderr.write(`[relay-err] ${d}`));
  let exited = false; let code: number | null = null;
  proc.once('exit', (c) => { exited = true; code = c; });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`Relay exited early (code ${code})`);
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Relay on port ${port} did not start within ${timeoutMs}ms`);
}

function spawnRelay(port: number): { proc: childProcess.ChildProcess; dbPath: string } {
  const dbPath = path.join(os.tmpdir(), `mw-xn-${port}-${Date.now()}.db`);
  const nodeDir = path.resolve(__dirname, '../node');
  const distEntry = path.join(nodeDir, 'dist/index.js');
  const useCompiled = fs.existsSync(distEntry);
  const proc = childProcess.spawn(
    useCompiled ? 'node' : 'npx',
    useCompiled ? [distEntry] : ['tsx', path.join(nodeDir, 'src/index.ts')],
    { cwd: nodeDir, env: { ...process.env, PORT: String(port), DB_PATH: dbPath, NODE_ENV: 'test' }, stdio: 'pipe' },
  );
  return { proc, dbPath };
}

function stopRelay(proc: childProcess.ChildProcess, dbPath: string): void {
  proc.kill('SIGTERM');
  for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
}

const NODE_URL_PORT = 19882;

describe('Cross-namespace messaging (ADR-009 stage-1)', () => {
  let relayProc: childProcess.ChildProcess;
  let dbPath: string;
  let MeshWhisper: typeof import('../src/sdk/index.js').MeshWhisper;
  let NodeStorage: typeof import('../src/persistence/node-storage.js').NodeStorage;

  beforeAll(async () => {
    ({ proc: relayProc, dbPath } = spawnRelay(NODE_URL_PORT));
    await waitForRelay(NODE_URL_PORT, relayProc);
    ({ MeshWhisper } = await import('../src/sdk/index.js'));
    ({ NodeStorage } = await import('../src/persistence/node-storage.js'));
  }, 20000);

  afterAll(() => stopRelay(relayProc, dbPath));

  const NODE_URL = `ws://127.0.0.1:${NODE_URL_PORT}`;
  const NS_A = 'com.test.appA';
  const NS_B = 'com.test.appB';

  it('delivers an E2EE message from namespace A to namespace B (addressed into B)', async () => {
    const aliceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-xn-alice-'));
    const bobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-xn-bob-'));

    // Bob lives in namespace B — generate his QR + capture his id & namespace id.
    const bob = await MeshWhisper.init({ namespace: NS_B, node: NODE_URL, developerKey: TEST_DEV_KEY, storage: new NodeStorage(bobDir) });
    const bobQR = MeshWhisper.generateContactQR();
    const bobId = bob.getLocalPeerId();
    const bobNsId = bob.getNamespaceId();
    await new Promise((r) => setTimeout(r, 300));

    // Alice lives in namespace A (this shuts Bob down — singleton).
    const alice = await MeshWhisper.init({ namespace: NS_A, node: NODE_URL, developerKey: TEST_DEV_KEY, storage: new NodeStorage(aliceDir) });
    const aliceNsId = alice.getNamespaceId();
    expect(Buffer.from(aliceNsId).toString('hex')).not.toBe(Buffer.from(bobNsId).toString('hex'));

    // Tell Alice to address Bob in HIS namespace, then pair + send.
    alice.setPeerNamespace(bobId, bobNsId);
    await MeshWhisper.acceptContact(bobQR);
    await new Promise((r) => setTimeout(r, 300));
    await alice.sendMessage(bobId, new TextEncoder().encode('Hello across namespaces, Bob!'));
    await new Promise((r) => setTimeout(r, 400));
    await alice.shutdown();

    // Bob comes back online in namespace B and should receive + decrypt it.
    let received = '';
    let resolve: (() => void) | null = null;
    const got = new Promise<void>((r) => { resolve = r; });
    await MeshWhisper.init({
      namespace: NS_B, node: NODE_URL, developerKey: TEST_DEV_KEY, storage: new NodeStorage(bobDir),
      onMessage: (msg) => { received = new TextDecoder().decode(new Uint8Array(msg.payload)); resolve?.(); },
    });
    await Promise.race([
      got,
      new Promise<void>((_, rej) => setTimeout(() => rej(new Error('Timeout: Bob (B) did not receive Alice (A) cross-namespace message')), 6000)),
    ]);

    expect(received).toBe('Hello across namespaces, Bob!');

    await MeshWhisper.instance.shutdown();
    fs.rmSync(aliceDir, { recursive: true, force: true });
    fs.rmSync(bobDir, { recursive: true, force: true });
  }, 25000);

  it('isolation holds by default: WITHOUT cross-namespace addressing the message is not delivered', async () => {
    const aliceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-xn2-alice-'));
    const bobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-xn2-bob-'));

    const bob = await MeshWhisper.init({ namespace: NS_B, node: NODE_URL, developerKey: TEST_DEV_KEY, storage: new NodeStorage(bobDir) });
    const bobQR = MeshWhisper.generateContactQR();
    const bobId = bob.getLocalPeerId();
    await new Promise((r) => setTimeout(r, 300));

    const alice = await MeshWhisper.init({ namespace: NS_A, node: NODE_URL, developerKey: TEST_DEV_KEY, storage: new NodeStorage(aliceDir) });
    // NOTE: deliberately NOT calling setPeerNamespace — Alice addresses into her own namespace (A).
    await MeshWhisper.acceptContact(bobQR);
    await new Promise((r) => setTimeout(r, 300));
    await alice.sendMessage(bobId, new TextEncoder().encode('This should NOT cross'));
    await new Promise((r) => setTimeout(r, 400));
    await alice.shutdown();

    let received = '';
    await MeshWhisper.init({
      namespace: NS_B, node: NODE_URL, developerKey: TEST_DEV_KEY, storage: new NodeStorage(bobDir),
      onMessage: (msg) => { received = new TextDecoder().decode(new Uint8Array(msg.payload)); },
    });
    // Give it a real chance to (not) arrive.
    await new Promise((r) => setTimeout(r, 3500));
    expect(received).toBe('');

    await MeshWhisper.instance.shutdown();
    fs.rmSync(aliceDir, { recursive: true, force: true });
    fs.rmSync(bobDir, { recursive: true, force: true });
  }, 20000);
});
