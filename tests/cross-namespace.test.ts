// ============================================================
// MeshWhisper — Cross-namespace messaging (ADR-009 stage-1b)
//
// Proves the "email model" is automatic, bidirectional, and STRICTLY OPT-IN:
//   - With `interop: true` on both apps, pairing exchanges namespace ids both
//     ways (QR carries the generator's; the x3dh_init carries the scanner's),
//     and users of different namespaces message each other E2EE over one relay.
//   - With interop off (the default), the message does NOT cross — ADR-001
//     isolation holds and the wire format is unchanged.
//
// Uses store-and-forward because init() is a per-process singleton (one live
// instance at a time), mirroring tests/integration.test.ts.
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

const PORT = 19882;
const NS_A = 'com.test.appA';
const NS_B = 'com.test.appB';

describe('Cross-namespace messaging (ADR-009 stage-1b)', () => {
  let relayProc: childProcess.ChildProcess;
  let dbPath: string;
  let MeshWhisper: typeof import('../src/sdk/index.js').MeshWhisper;
  let NodeStorage: typeof import('../src/persistence/node-storage.js').NodeStorage;
  const NODE_URL = `ws://127.0.0.1:${PORT}`;

  beforeAll(async () => {
    ({ proc: relayProc, dbPath } = spawnRelay(PORT));
    await waitForRelay(PORT, relayProc);
    ({ MeshWhisper } = await import('../src/sdk/index.js'));
    ({ NodeStorage } = await import('../src/persistence/node-storage.js'));
  }, 20000);

  afterAll(() => stopRelay(relayProc, dbPath));

  it('automatic + bidirectional when both apps opt into interop', async () => {
    const aliceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-xn-a-'));
    const bobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-xn-b-'));

    // A (namespace A, interop) — generate QR (carries A's namespace), capture id.
    const alice = await MeshWhisper.init({ namespace: NS_A, node: NODE_URL, developerKey: TEST_DEV_KEY, interop: true, storage: new NodeStorage(aliceDir) });
    const aliceId = alice.getLocalPeerId();
    const qrA = MeshWhisper.generateContactQR();
    await new Promise((r) => setTimeout(r, 300));

    // B (namespace B, interop) scans A's QR — learns A's namespace automatically,
    // then sends to A. No manual setPeerNamespace anywhere.
    const bob = await MeshWhisper.init({ namespace: NS_B, node: NODE_URL, developerKey: TEST_DEV_KEY, interop: true, storage: new NodeStorage(bobDir) });
    const bobId = bob.getLocalPeerId();
    await MeshWhisper.acceptContact(qrA);
    await new Promise((r) => setTimeout(r, 300));
    await bob.sendMessage(aliceId, new TextEncoder().encode('from B (appB) to A (appA)'));
    await new Promise((r) => setTimeout(r, 400));
    await bob.shutdown();

    // A comes online: receives B's message AND learns B's namespace from B's
    // x3dh_init — then replies, addressing into B's namespace automatically.
    let aGot = '';
    let aResolve: (() => void) | null = null;
    const aReceived = new Promise<void>((r) => { aResolve = r; });
    const aliceBack = await MeshWhisper.init({
      namespace: NS_A, node: NODE_URL, developerKey: TEST_DEV_KEY, interop: true, storage: new NodeStorage(aliceDir),
      onMessage: (m) => { aGot = new TextDecoder().decode(new Uint8Array(m.payload)); aResolve?.(); },
    });
    await Promise.race([aReceived, new Promise<void>((_, rej) => setTimeout(() => rej(new Error('A never received B')), 6000))]);
    await aliceBack.sendMessage(bobId, new TextEncoder().encode('from A (appA) to B (appB)'));
    await new Promise((r) => setTimeout(r, 400));
    await aliceBack.shutdown();

    // B comes online: receives A's reply.
    let bGot = '';
    let bResolve: (() => void) | null = null;
    const bReceived = new Promise<void>((r) => { bResolve = r; });
    await MeshWhisper.init({
      namespace: NS_B, node: NODE_URL, developerKey: TEST_DEV_KEY, interop: true, storage: new NodeStorage(bobDir),
      onMessage: (m) => { bGot = new TextDecoder().decode(new Uint8Array(m.payload)); bResolve?.(); },
    });
    await Promise.race([bReceived, new Promise<void>((_, rej) => setTimeout(() => rej(new Error('B never received A reply')), 6000))]);

    expect(aGot).toBe('from B (appB) to A (appA)');
    expect(bGot).toBe('from A (appA) to B (appB)');

    await MeshWhisper.instance.shutdown();
    fs.rmSync(aliceDir, { recursive: true, force: true });
    fs.rmSync(bobDir, { recursive: true, force: true });
  }, 30000);

  it('isolation holds by default: without interop the message does not cross', async () => {
    const aliceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-xn2-a-'));
    const bobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-xn2-b-'));

    // No `interop` flag anywhere — the default, isolated behaviour.
    const alice = await MeshWhisper.init({ namespace: NS_A, node: NODE_URL, developerKey: TEST_DEV_KEY, storage: new NodeStorage(aliceDir) });
    const aliceId = alice.getLocalPeerId();
    const qrA = MeshWhisper.generateContactQR();
    await new Promise((r) => setTimeout(r, 300));

    const bob = await MeshWhisper.init({ namespace: NS_B, node: NODE_URL, developerKey: TEST_DEV_KEY, storage: new NodeStorage(bobDir) });
    await MeshWhisper.acceptContact(qrA);
    await new Promise((r) => setTimeout(r, 300));
    await bob.sendMessage(aliceId, new TextEncoder().encode('this must not cross'));
    await new Promise((r) => setTimeout(r, 400));
    await bob.shutdown();

    let aGot = '';
    await MeshWhisper.init({
      namespace: NS_A, node: NODE_URL, developerKey: TEST_DEV_KEY, storage: new NodeStorage(aliceDir),
      onMessage: (m) => { aGot = new TextDecoder().decode(new Uint8Array(m.payload)); },
    });
    await new Promise((r) => setTimeout(r, 3500));
    expect(aGot).toBe('');

    await MeshWhisper.instance.shutdown();
    fs.rmSync(aliceDir, { recursive: true, force: true });
    fs.rmSync(bobDir, { recursive: true, force: true });
  }, 20000);
});
