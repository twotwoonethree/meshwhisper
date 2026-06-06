// ============================================================
// QR pairing — DeviceLinkOffer + acceptDeviceLinkOffer
//
// End-to-end multi-device pairing requires two SDK instances
// running simultaneously, which the SDK singleton doesn't easily
// allow. These tests therefore cover:
//   1. Offer shape and TTL semantics on the secondary
//   2. Validation rejections on the primary (wrong version,
//      namespace, expired, secondary not published)
//   3. The successful primary-side execution path (lookup,
//      session establish, control send) using a secondary that
//      published its bundle before being torn down.
//
// A separate integration test that exercises the secondary's
// inbound handler is best added once the multi-SDK testing
// pattern is firmed up.
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const TEST_DEV_KEY_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const TEST_DEV_KEY_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';

// ---- Relay harness ----

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
  const dbPath = path.join(os.tmpdir(), `mw-link-${port}-${Date.now()}.db`);
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

// ---- Suite ----

describe('DeviceLinkOffer + acceptDeviceLinkOffer', () => {
  const PORT = 19885;
  const NAMESPACE = 'com.test.device-link';
  const NODE_URL = `ws://127.0.0.1:${PORT}`;
  let relayProc: childProcess.ChildProcess;
  let dbPath: string;
  let MeshWhisper: typeof import('../src/sdk/index.js').MeshWhisper;
  let NodeStorage: typeof import('../src/persistence/node-storage.js').NodeStorage;

  beforeAll(async () => {
    ({ proc: relayProc, dbPath } = spawnRelay(PORT));
    await waitForRelay(PORT, relayProc, 15000);
    ({ MeshWhisper } = await import('../src/sdk/index.js'));
    ({ NodeStorage } = await import('../src/persistence/node-storage.js'));
  }, 15000);

  afterAll(() => stopRelay(relayProc, dbPath));

  it('createDeviceLinkOffer returns a well-formed v1 offer', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-sec-'));
    await MeshWhisper.init({
      namespace: NAMESPACE,
      node: NODE_URL,
      developerKey: TEST_DEV_KEY_A,
      storage: new NodeStorage(dir),
    });

    const offer = await MeshWhisper.createDeviceLinkOffer();
    expect(offer.version).toBe('v1');
    expect(offer.namespace).toBe(NAMESPACE);
    expect(offer.deviceEdKey).toMatch(/^[0-9a-f]{64}$/);
    expect(offer.linkChallenge.length).toBeGreaterThan(0);
    expect(offer.expiresAt).toBeGreaterThan(Date.now());
    expect(offer.expiresAt - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000);

    await MeshWhisper.instance.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('createDeviceLinkOffer respects ttlMs override', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-sec-ttl-'));
    await MeshWhisper.init({
      namespace: NAMESPACE,
      node: NODE_URL,
      developerKey: TEST_DEV_KEY_A,
      storage: new NodeStorage(dir),
    });

    const start = Date.now();
    const offer = await MeshWhisper.createDeviceLinkOffer({ ttlMs: 30_000 });
    const delta = offer.expiresAt - start;
    expect(delta).toBeGreaterThanOrEqual(29_000);
    expect(delta).toBeLessThanOrEqual(31_000);

    await MeshWhisper.instance.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('acceptDeviceLinkOffer rejects an unknown version', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-pri-'));
    await MeshWhisper.init({
      namespace: NAMESPACE,
      node: NODE_URL,
      developerKey: TEST_DEV_KEY_A,
      storage: new NodeStorage(dir),
    });

    await expect(
      MeshWhisper.acceptDeviceLinkOffer({
        version: 'v99' as 'v1',
        deviceEdKey: '0'.repeat(64),
        namespace: NAMESPACE,
        linkChallenge: 'aaaa',
        expiresAt: Date.now() + 60_000,
      }),
    ).rejects.toThrow(/version/i);

    await MeshWhisper.instance.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('acceptDeviceLinkOffer rejects a different namespace', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-pri-ns-'));
    await MeshWhisper.init({
      namespace: NAMESPACE,
      node: NODE_URL,
      developerKey: TEST_DEV_KEY_A,
      storage: new NodeStorage(dir),
    });

    await expect(
      MeshWhisper.acceptDeviceLinkOffer({
        version: 'v1',
        deviceEdKey: '0'.repeat(64),
        namespace: 'com.test.OTHER',
        linkChallenge: 'aaaa',
        expiresAt: Date.now() + 60_000,
      }),
    ).rejects.toThrow(/namespace/i);

    await MeshWhisper.instance.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('acceptDeviceLinkOffer rejects an expired offer', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-pri-exp-'));
    await MeshWhisper.init({
      namespace: NAMESPACE,
      node: NODE_URL,
      developerKey: TEST_DEV_KEY_A,
      storage: new NodeStorage(dir),
    });

    await expect(
      MeshWhisper.acceptDeviceLinkOffer({
        version: 'v1',
        deviceEdKey: '0'.repeat(64),
        namespace: NAMESPACE,
        linkChallenge: 'aaaa',
        expiresAt: Date.now() - 1000,
      }),
    ).rejects.toThrow(/expired/i);

    await MeshWhisper.instance.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('acceptDeviceLinkOffer rejects when the secondary bundle is not at the relay', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-pri-nobundle-'));
    await MeshWhisper.init({
      namespace: NAMESPACE,
      node: NODE_URL,
      developerKey: TEST_DEV_KEY_A,
      storage: new NodeStorage(dir),
    });

    await expect(
      MeshWhisper.acceptDeviceLinkOffer({
        version: 'v1',
        // 32 random-looking bytes that aren't a registered identity
        deviceEdKey: 'feedfacecafebeef'.repeat(4),
        namespace: NAMESPACE,
        linkChallenge: 'aaaa',
        expiresAt: Date.now() + 60_000,
      }),
    ).rejects.toThrow(/bundle/i);

    await MeshWhisper.instance.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('end-to-end primary side: lookup → session → control send completes', async () => {
    // Phase 1: a secondary device publishes its bundle, mints an offer
    // (in-memory state is lost on shutdown, but the bundle persists at
    // the relay), captures the offer for the primary to consume.
    const secDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-link-sec-'));
    await MeshWhisper.init({
      namespace: NAMESPACE,
      node: NODE_URL,
      developerKey: TEST_DEV_KEY_B,
      storage: new NodeStorage(secDir),
    });
    const offer = await MeshWhisper.createDeviceLinkOffer();
    // Give the bundle time to publish.
    await new Promise((r) => setTimeout(r, 400));
    await MeshWhisper.instance.shutdown();

    // Phase 2: the primary scans the offer and accepts it. The bundle
    // is at the relay; X3DH completes; a device_linked control is sent
    // (it gets stored-and-forwarded since the secondary is offline).
    const priDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-link-pri-'));
    await MeshWhisper.init({
      namespace: NAMESPACE,
      node: NODE_URL,
      developerKey: TEST_DEV_KEY_A,
      storage: new NodeStorage(priDir),
    });

    // Should not throw — proves bundle lookup, X3DH, session
    // establishment, and control-send path all work end-to-end on the
    // primary side. The secondary's onDeviceLinked is exercised in a
    // future integration test that supports two live SDK instances.
    await expect(MeshWhisper.acceptDeviceLinkOffer(offer)).resolves.toBeUndefined();

    await MeshWhisper.instance.shutdown();
    fs.rmSync(secDir, { recursive: true, force: true });
    fs.rmSync(priDir, { recursive: true, force: true });
  });
});
