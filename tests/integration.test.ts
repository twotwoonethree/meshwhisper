// ============================================================
// MeshWhisper — End-to-end integration tests
//
// Spins up a real MeshWhisper Node relay as a child process,
// then exercises the full SDK → Node → SDK message path.
//
// Requirements:
//   - Node relay built (node/dist/index.js) or tsx available
//   - No external services required — relay uses in-memory SQLite (:memory:)
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

// ---- Helpers ----

/** Wait until the relay's /health endpoint responds OK. */
async function waitForRelay(port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) return;
    } catch {
      // Not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Relay on port ${port} did not start within ${timeoutMs}ms`);
}

/** Spawn the Node relay on a given port with an isolated temp DB. */
function spawnRelay(port: number): { proc: childProcess.ChildProcess; dbPath: string } {
  const dbPath = path.join(os.tmpdir(), `mw-test-${port}-${Date.now()}.db`);
  const relayEntry = path.resolve(__dirname, '../node/src/index.ts');

  const proc = childProcess.spawn(
    'npx',
    ['tsx', relayEntry],
    {
      env: {
        ...process.env,
        PORT: String(port),
        DB_PATH: dbPath,
        // Silence startup logs in test output
        NODE_ENV: 'test',
      },
      stdio: 'pipe',
    },
  );

  // Uncomment to debug relay output:
  // proc.stdout?.on('data', (d) => process.stdout.write('[relay] ' + d));
  // proc.stderr?.on('data', (d) => process.stderr.write('[relay] ' + d));

  return { proc, dbPath };
}

/** Clean up relay process and temp DB. */
function stopRelay(proc: childProcess.ChildProcess, dbPath: string): void {
  proc.kill('SIGTERM');
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ignore */ }
  try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ignore */ }
}

// ---- Test suite ----

describe('MeshWhisper end-to-end', () => {
  const PORT = 19877;
  let relayProc: childProcess.ChildProcess;
  let dbPath: string;
  let MeshWhisper: typeof import('../src/sdk/index.js').MeshWhisper;
  let NodeStorage: typeof import('../src/persistence/node-storage.js').NodeStorage;

  beforeAll(async () => {
    // Start relay
    ({ proc: relayProc, dbPath } = spawnRelay(PORT));
    await waitForRelay(PORT, 8000);

    // Import SDK (dynamic to avoid module-level side effects)
    ({ MeshWhisper } = await import('../src/sdk/index.js'));
    ({ NodeStorage } = await import('../src/persistence/node-storage.js'));
  }, 15000);

  afterAll(() => {
    stopRelay(relayProc, dbPath);
  });

  it('Alice sends a message and Bob receives it via store-and-forward', async () => {
    // Note: MeshWhisper.init() is a singleton per process — initialising Alice shuts
    // down Bob. This test therefore uses the store-and-forward path: Alice sends while
    // Bob is offline, then Bob reconnects and the relay delivers the queued message.
    const NODE_URL = `ws://localhost:${PORT}`;
    const NAMESPACE = 'com.test.integration';
    const aliceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-alice-'));
    const bobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-bob-'));

    // ---- Init Bob, generate QR ----
    const bob = await MeshWhisper.init({
      namespace: NAMESPACE,
      node: NODE_URL,
      storage: new NodeStorage(bobDir),
    });
    const bobQR = MeshWhisper.generateContactQR();
    const bobId = bob.getLocalPeerId();
    await new Promise((r) => setTimeout(r, 300));

    // ---- Init Alice (this shuts down Bob) ----
    const alice = await MeshWhisper.init({
      namespace: NAMESPACE,
      node: NODE_URL,
      storage: new NodeStorage(aliceDir),
    });

    // Alice scans Bob's QR — establishes X3DH session
    await MeshWhisper.acceptContact(bobQR);
    await new Promise((r) => setTimeout(r, 300));

    // Alice sends — Bob is offline, relay stores the blob
    await alice.sendMessage(bobId, new TextEncoder().encode('Hello, Bob!'));
    await new Promise((r) => setTimeout(r, 400));
    await alice.shutdown();

    // ---- Bob comes back online ----
    let bobReceivedText = '';
    let bobResolve: (() => void) | null = null;
    const bobReceived = new Promise<void>((r) => { bobResolve = r; });

    await MeshWhisper.init({
      namespace: NAMESPACE,
      node: NODE_URL,
      storage: new NodeStorage(bobDir),
      onMessage: (msg) => {
        bobReceivedText = new TextDecoder().decode(new Uint8Array(msg.payload));
        bobResolve?.();
      },
    });

    await Promise.race([
      bobReceived,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout: Bob did not receive the message')), 5000),
      ),
    ]);

    expect(bobReceivedText).toBe('Hello, Bob!');

    await MeshWhisper.instance.shutdown();
    fs.rmSync(aliceDir, { recursive: true, force: true });
    fs.rmSync(bobDir, { recursive: true, force: true });
  }, 20000);

  it('messages are stored and delivered when recipient comes online', async () => {
    const NODE_URL = `ws://localhost:${PORT}`;
    const NAMESPACE = 'com.test.offline';
    const aliceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-alice2-'));
    const bobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-bob2-'));

    // ---- Init Bob, exchange contacts with Alice ----
    const bob = await MeshWhisper.init({
      namespace: NAMESPACE,
      node: NODE_URL,
      storage: new NodeStorage(bobDir),
    });
    const bobQR = MeshWhisper.generateContactQR();
    const bobId = bob.getLocalPeerId();
    await new Promise((r) => setTimeout(r, 300));

    const alice = await MeshWhisper.init({
      namespace: NAMESPACE,
      node: NODE_URL,
      storage: new NodeStorage(aliceDir),
    });
    await MeshWhisper.acceptContact(bobQR);
    await new Promise((r) => setTimeout(r, 300));

    // ---- Bob goes offline ----
    await bob.shutdown();

    // ---- Alice sends while Bob is offline ----
    await alice.sendMessage(bobId, new TextEncoder().encode('Offline message'));
    await new Promise((r) => setTimeout(r, 400));
    await alice.shutdown();

    // ---- Bob comes back online ----
    let deliveredText = '';
    let deliverResolve: (() => void) | null = null;
    const delivered = new Promise<void>((r) => { deliverResolve = r; });

    await MeshWhisper.init({
      namespace: NAMESPACE,
      node: NODE_URL,
      storage: new NodeStorage(bobDir),
      onMessage: (msg) => {
        deliveredText = new TextDecoder().decode(new Uint8Array(msg.payload));
        deliverResolve?.();
      },
    });

    await Promise.race([
      delivered,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout: offline message not delivered')), 5000),
      ),
    ]);

    expect(deliveredText).toBe('Offline message');

    await MeshWhisper.instance.shutdown();
    fs.rmSync(aliceDir, { recursive: true, force: true });
    fs.rmSync(bobDir, { recursive: true, force: true });
  }, 25000);

  it('Bob can reply to Alice (bidirectional Double Ratchet)', async () => {
    const NODE_URL = `ws://localhost:${PORT}`;
    const NAMESPACE = 'com.test.bidir';
    const aliceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-alice3-'));
    const bobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-bob3-'));

    // ---- Bob inits, generates QR ----
    const bob = await MeshWhisper.init({
      namespace: NAMESPACE,
      node: NODE_URL,
      storage: new NodeStorage(bobDir),
    });
    const bobQR = MeshWhisper.generateContactQR();
    const bobId = bob.getLocalPeerId();
    await new Promise((r) => setTimeout(r, 300));

    // ---- Alice inits (shuts Bob down), accepts contact, sends to Bob ----
    const alice = await MeshWhisper.init({
      namespace: NAMESPACE,
      node: NODE_URL,
      storage: new NodeStorage(aliceDir),
    });
    const aliceId = alice.getLocalPeerId();
    await MeshWhisper.acceptContact(bobQR);
    await new Promise((r) => setTimeout(r, 300));
    await alice.sendMessage(bobId, new TextEncoder().encode('Hello Bob!'));
    await new Promise((r) => setTimeout(r, 400));
    await alice.shutdown();

    // ---- Bob2 inits, receives Alice's message, sends a reply ----
    await MeshWhisper.init({
      namespace: NAMESPACE,
      node: NODE_URL,
      storage: new NodeStorage(bobDir),
      onMessage: (msg) => {
        if (new TextDecoder().decode(new Uint8Array(msg.payload)) === 'Hello Bob!') {
          MeshWhisper.instance.sendMessage(msg.senderId, new TextEncoder().encode('Hello Alice!'))
            .catch(() => {});
        }
      },
    });
    // Wait for Bob to receive Alice's message and fire off the reply
    await new Promise((r) => setTimeout(r, 800));

    // ---- Alice2 inits (shuts Bob2 down), receives Bob's reply ----
    let replyText = '';
    let resolveReply: (() => void) | null = null;
    const replyReceived = new Promise<void>((r) => { resolveReply = r; });

    await MeshWhisper.init({
      namespace: NAMESPACE,
      node: NODE_URL,
      storage: new NodeStorage(aliceDir),
      onMessage: (msg) => {
        replyText = new TextDecoder().decode(new Uint8Array(msg.payload));
        resolveReply?.();
      },
    });

    await Promise.race([
      replyReceived,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout: Alice did not receive Bob's reply")), 5000),
      ),
    ]);

    expect(replyText).toBe('Hello Alice!');

    await MeshWhisper.instance.shutdown();
    fs.rmSync(aliceDir, { recursive: true, force: true });
    fs.rmSync(bobDir, { recursive: true, force: true });
  }, 30000);

  it('/health returns ok', async () => {
    const res = await fetch(`http://localhost:${PORT}/health`);
    expect(res.ok).toBe(true);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('ok');
  });
});
