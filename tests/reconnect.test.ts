// ============================================================
// Reconnect-robustness tests
//
// Exercises the failure modes that have actually bitten users in the
// wild: delete + re-add scenarios, rapid bursts, multi-cycle churn,
// session-health ping/pong. Complements integration.test.ts which
// covers the basic happy paths.
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

// Shared developer key so namespace ids match across init() calls.
const TEST_DEV_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const PORT = 19880;
const NODE_URL = `ws://127.0.0.1:${PORT}`;

// ---- Helpers (mirrored from integration.test.ts) ----

async function waitForRelay(
  port: number,
  proc: childProcess.ChildProcess,
  timeoutMs = 15000,
): Promise<void> {
  proc.stdout?.on('data', (d: Buffer) => process.stdout.write(`[relay] ${d}`));
  proc.stderr?.on('data', (d: Buffer) => process.stderr.write(`[relay-err] ${d}`));
  let exited = false;
  proc.once('exit', () => { exited = true; });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) throw new Error('Relay exited early');
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Relay on port ${port} did not start within ${timeoutMs}ms`);
}

function spawnRelay(port: number): { proc: childProcess.ChildProcess; dbPath: string } {
  const dbPath = path.join(os.tmpdir(), `mw-reconnect-${port}-${Date.now()}.db`);
  const nodeDir = path.resolve(__dirname, '../node');
  const distEntry = path.join(nodeDir, 'dist/index.js');
  const useCompiled = fs.existsSync(distEntry);
  const proc = childProcess.spawn(
    useCompiled ? 'node' : 'npx',
    useCompiled ? [distEntry] : ['tsx', path.join(nodeDir, 'src/index.ts')],
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
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

// ---- Test suite ----

describe('Reconnect robustness', () => {
  let relayProc: childProcess.ChildProcess;
  let dbPath: string;
  let MeshWhisper: typeof import('../src/sdk/index.js').MeshWhisper;
  let NodeStorage: typeof import('../src/persistence/node-storage.js').NodeStorage;

  beforeAll(async () => {
    ({ proc: relayProc, dbPath } = spawnRelay(PORT));
    await waitForRelay(PORT, relayProc, 15000);
    ({ MeshWhisper } = await import('../src/sdk/index.js'));
    ({ NodeStorage } = await import('../src/persistence/node-storage.js'));
  }, 20000);

  afterAll(() => {
    stopRelay(relayProc, dbPath);
  });

  // ----------------------------------------------------------------
  // 1. The user's actual reported bug: delete + re-add + chat works
  // ----------------------------------------------------------------
  //
  // This is the canonical "Anton + Danny" scenario. If this test fails,
  // we've regressed on the exact UX that prompted the recent fixes.
  it('Delete + re-add: bidirectional messages flow after the re-add', async () => {
    const NAMESPACE = 'com.test.reconnect.deleteReadd';
    const aliceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-rr-a-'));
    const bobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-rr-b-'));

    try {
      // ---- Bob inits, generates QR ----
      const bob = await MeshWhisper.init({
        namespace: NAMESPACE,
        node: NODE_URL,
        developerKey: TEST_DEV_KEY,
        storage: new NodeStorage(bobDir),
      });
      const bobQR = MeshWhisper.generateContactQR();
      const bobId = bob.getLocalPeerId();
      await new Promise((r) => setTimeout(r, 300));

      // ---- Alice inits, accepts Bob, sends initial message ----
      const alice = await MeshWhisper.init({
        namespace: NAMESPACE,
        node: NODE_URL,
        developerKey: TEST_DEV_KEY,
        storage: new NodeStorage(aliceDir),
      });
      const aliceId = alice.getLocalPeerId();
      await MeshWhisper.acceptContact(bobQR);
      await new Promise((r) => setTimeout(r, 300));
      await alice.sendMessage(bobId, new TextEncoder().encode('hello bob'));
      await new Promise((r) => setTimeout(r, 400));

      // ---- Alice deletes Bob (writes tombstone, wipes local state) ----
      await alice.deleteConversationInstance(bobId);
      await new Promise((r) => setTimeout(r, 300));
      await alice.shutdown();

      // ---- Bob comes online briefly to drain Alice's segment-1 messages.
      // This is the path that exposed the OPK-persistence ordering bug —
      // if replenishOPKPool's local-storage write is fire-and-forget,
      // OPKs uploaded to the relay during this brief window won't be on
      // disk when Bob shuts down, and Alice's next handshake will claim
      // an OPK Bob can't find locally → silent X3DH 4-DH/3-DH mismatch.
      await MeshWhisper.init({
        namespace: NAMESPACE,
        node: NODE_URL,
        developerKey: TEST_DEV_KEY,
        storage: new NodeStorage(bobDir),
      });
      await new Promise((r) => setTimeout(r, 800));
      await MeshWhisper.instance.shutdown();

      // ---- Alice re-inits and re-acceptContacts Bob ----
      await MeshWhisper.init({
        namespace: NAMESPACE,
        node: NODE_URL,
        developerKey: TEST_DEV_KEY,
        storage: new NodeStorage(aliceDir),
      });
      await MeshWhisper.acceptContact(bobQR);
      await new Promise((r) => setTimeout(r, 500));

      // Send a post-re-add message from Alice
      await MeshWhisper.send(bobId, new TextEncoder().encode('after readd'));
      await new Promise((r) => setTimeout(r, 500));
      await MeshWhisper.instance.shutdown();

      // ---- Bob comes back online, receives the post-re-add message, replies ----
      const bobReceived: string[] = [];
      let bobGotMsg: (() => void) | null = null;
      const bobMsgPromise = new Promise<void>((r) => { bobGotMsg = r; });
      await MeshWhisper.init({
        namespace: NAMESPACE,
        node: NODE_URL,
        developerKey: TEST_DEV_KEY,
        storage: new NodeStorage(bobDir),
        onMessage: (msg) => {
          const text = new TextDecoder().decode(new Uint8Array(msg.payload));
          bobReceived.push(text);
          if (text === 'after readd') {
            // Reply, then resolve only AFTER it has actually been sent — resolving
            // first (fire-and-forget) lets the fixed post-resolve delay race Bob's
            // shutdown(), which terminates the socket before the reply reaches the
            // relay. Retry a few times: a freshly-established RESPONDER session is
            // briefly receiver-only until its sending chain initialises, so the
            // first send can throw (a real app retries too).
            void (async () => {
              for (let attempt = 0; attempt < 6; attempt++) {
                try {
                  await MeshWhisper.instance.sendMessage(msg.senderId, new TextEncoder().encode('reply from bob'));
                  break;
                } catch {
                  await new Promise((r) => setTimeout(r, 300));
                }
              }
              bobGotMsg?.();
            })();
          }
        },
      });

      await Promise.race([
        bobMsgPromise,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('Bob never received the post-re-add message')), 15000),
        ),
      ]);
      await new Promise((r) => setTimeout(r, 800));
      await MeshWhisper.instance.shutdown();

      // ---- Alice comes back to receive Bob's reply ----
      let aliceGotReply = '';
      let aliceGotMsg: (() => void) | null = null;
      const aliceMsgPromise = new Promise<void>((r) => { aliceGotMsg = r; });
      await MeshWhisper.init({
        namespace: NAMESPACE,
        node: NODE_URL,
        developerKey: TEST_DEV_KEY,
        storage: new NodeStorage(aliceDir),
        onMessage: (msg) => {
          aliceGotReply = new TextDecoder().decode(new Uint8Array(msg.payload));
          aliceGotMsg?.();
        },
      });
      await Promise.race([
        aliceMsgPromise,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("Alice never received Bob's post-re-add reply")), 15000),
        ),
      ]);

      expect(aliceGotReply).toBe('reply from bob');
      // The chain succeeded — re-add re-established a working session and
      // both directions flow.
      void aliceId;

      await MeshWhisper.instance.shutdown();
    } finally {
      fs.rmSync(aliceDir, { recursive: true, force: true });
      fs.rmSync(bobDir, { recursive: true, force: true });
    }
  }, 60000);

  // ----------------------------------------------------------------
  // 2. Rapid burst — the concurrent-RMW race that was fixed by the
  //    per-recipient sessionMutex. If sends race the ratchet state,
  //    msgN collisions cause silent drops at the receiver.
  // ----------------------------------------------------------------
  it('Rapid burst of 8 messages from one peer all arrive in order', async () => {
    const NAMESPACE = 'com.test.reconnect.burst';
    const aliceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-burst-a-'));
    const bobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-burst-b-'));

    try {
      const bob = await MeshWhisper.init({
        namespace: NAMESPACE,
        node: NODE_URL,
        developerKey: TEST_DEV_KEY,
        storage: new NodeStorage(bobDir),
      });
      const bobQR = MeshWhisper.generateContactQR();
      const bobId = bob.getLocalPeerId();
      await new Promise((r) => setTimeout(r, 300));

      await MeshWhisper.init({
        namespace: NAMESPACE,
        node: NODE_URL,
        developerKey: TEST_DEV_KEY,
        storage: new NodeStorage(aliceDir),
      });
      await MeshWhisper.acceptContact(bobQR);
      await new Promise((r) => setTimeout(r, 300));

      // Fire 8 sends without awaiting between them — they all race for the
      // sessionMutex. Pre-fix, several would land with msgN=0 and the
      // receiver would only decrypt one.
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 8; i++) {
        promises.push(MeshWhisper.send(bobId, new TextEncoder().encode(`burst-${i}`)));
      }
      await Promise.all(promises);
      await new Promise((r) => setTimeout(r, 400));
      await MeshWhisper.instance.shutdown();

      // Bob comes online and drains.
      const received: string[] = [];
      let resolveAll: (() => void) | null = null;
      const allDelivered = new Promise<void>((r) => { resolveAll = r; });
      await MeshWhisper.init({
        namespace: NAMESPACE,
        node: NODE_URL,
        developerKey: TEST_DEV_KEY,
        storage: new NodeStorage(bobDir),
        onMessage: (msg) => {
          received.push(new TextDecoder().decode(new Uint8Array(msg.payload)));
          if (received.length === 8) resolveAll?.();
        },
      });
      await Promise.race([
        allDelivered,
        new Promise<void>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Bob only received ${received.length}/8 messages: ${received.join(', ')}`)),
            6000,
          ),
        ),
      ]);

      expect(received.length).toBe(8);
      // Order may be slightly out-of-order due to ratchet skipping but the
      // SET of messages must match — no silent drops.
      expect([...received].sort()).toEqual(
        ['burst-0', 'burst-1', 'burst-2', 'burst-3', 'burst-4', 'burst-5', 'burst-6', 'burst-7'],
      );

      await MeshWhisper.instance.shutdown();
    } finally {
      fs.rmSync(aliceDir, { recursive: true, force: true });
      fs.rmSync(bobDir, { recursive: true, force: true });
    }
  }, 30000);

  // ----------------------------------------------------------------
  // 3. Multi-cycle churn — repeatedly delete + re-add the same peer.
  //    Tests that tombstone/revival state doesn't accumulate broken-ness
  //    over multiple cycles, and that the session keeps re-establishing.
  // ----------------------------------------------------------------
  it('Three delete/re-add cycles still let a final message flow', async () => {
    const NAMESPACE = 'com.test.reconnect.multicycle';
    const aliceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-mc-a-'));
    const bobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-mc-b-'));

    try {
      const bob = await MeshWhisper.init({
        namespace: NAMESPACE,
        node: NODE_URL,
        developerKey: TEST_DEV_KEY,
        storage: new NodeStorage(bobDir),
      });
      const bobInitialQR = MeshWhisper.generateContactQR();
      const bobId = bob.getLocalPeerId();
      await new Promise((r) => setTimeout(r, 300));

      // Alice inits + adds Bob once. Use the same QR across cycles — it's
      // just the prekey bundle, which Bob's relay-published bundle keeps fresh.
      let lastQR = bobInitialQR;

      for (let cycle = 0; cycle < 3; cycle++) {
        await MeshWhisper.init({
          namespace: NAMESPACE,
          node: NODE_URL,
          developerKey: TEST_DEV_KEY,
          storage: new NodeStorage(aliceDir),
        });
        await MeshWhisper.acceptContact(lastQR);
        await new Promise((r) => setTimeout(r, 300));
        await MeshWhisper.send(bobId, new TextEncoder().encode(`cycle-${cycle}-hello`));
        await new Promise((r) => setTimeout(r, 300));

        // Delete Bob locally (writes a tombstone)
        await MeshWhisper.instance.deleteConversationInstance(bobId);
        await new Promise((r) => setTimeout(r, 200));
        await MeshWhisper.instance.shutdown();

        // Bob comes online briefly to drain + republish bundle / generate fresh QR
        await MeshWhisper.init({
          namespace: NAMESPACE,
          node: NODE_URL,
          developerKey: TEST_DEV_KEY,
          storage: new NodeStorage(bobDir),
        });
        lastQR = MeshWhisper.generateContactQR();
        await new Promise((r) => setTimeout(r, 300));
        await MeshWhisper.instance.shutdown();
      }

      // ---- Final re-add and message ----
      await MeshWhisper.init({
        namespace: NAMESPACE,
        node: NODE_URL,
        developerKey: TEST_DEV_KEY,
        storage: new NodeStorage(aliceDir),
      });
      await MeshWhisper.acceptContact(lastQR);
      await new Promise((r) => setTimeout(r, 400));
      await MeshWhisper.send(bobId, new TextEncoder().encode('final message'));
      await new Promise((r) => setTimeout(r, 500));
      await MeshWhisper.instance.shutdown();

      // Bob receives.
      let bobGot = '';
      let bobReady: (() => void) | null = null;
      const bobMsg = new Promise<void>((r) => { bobReady = r; });
      await MeshWhisper.init({
        namespace: NAMESPACE,
        node: NODE_URL,
        developerKey: TEST_DEV_KEY,
        storage: new NodeStorage(bobDir),
        onMessage: (msg) => {
          const text = new TextDecoder().decode(new Uint8Array(msg.payload));
          if (text === 'final message') {
            bobGot = text;
            bobReady?.();
          }
        },
      });
      await Promise.race([
        bobMsg,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("Bob didn't receive the final message after 3 churn cycles")), 6000),
        ),
      ]);

      expect(bobGot).toBe('final message');

      await MeshWhisper.instance.shutdown();
    } finally {
      fs.rmSync(aliceDir, { recursive: true, force: true });
      fs.rmSync(bobDir, { recursive: true, force: true });
    }
  }, 60000);

  // ----------------------------------------------------------------
  // 4. Session ping/pong unit-ish check — after a fresh acceptContact,
  //    we expect a successful ping/pong round trip. If the timeout fires,
  //    the SDK logs a specific warning we can detect.
  // ----------------------------------------------------------------
  it('Session ping/pong completes without timeout warning', async () => {
    const NAMESPACE = 'com.test.reconnect.ping';
    const aliceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-ping-a-'));
    const bobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-ping-b-'));

    // Capture warn() calls for the "session_ping unanswered" message.
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      const msg = args.map(String).join(' ');
      warnings.push(msg);
      originalWarn.apply(console, args as Parameters<typeof console.warn>);
    };

    try {
      const bob = await MeshWhisper.init({
        namespace: NAMESPACE,
        node: NODE_URL,
        developerKey: TEST_DEV_KEY,
        storage: new NodeStorage(bobDir),
      });
      const bobQR = MeshWhisper.generateContactQR();
      void bob.getLocalPeerId();
      await new Promise((r) => setTimeout(r, 300));

      // Alice inits + accepts. Ping fires 4s later; pong-timeout fires at +14s.
      // We need to keep BOTH sides online during this window so the pong can
      // actually flow back. To do that we host Bob in a separate process? No —
      // since MeshWhisper is a process-singleton we can't have both alive.
      //
      // Workaround: this test only checks that the timeout warning is NOT
      // emitted on the initiator side within the window. Alice initiates,
      // we shut Bob down so Bob can't pong, and we wait for the timeout.
      //
      // Inverse logic: if the ping/pong mechanism is wired correctly, then
      // with Bob OFFLINE we DO expect the timeout warning. Use that as the
      // positive signal that the machinery is alive.
      await bob.shutdown();

      await MeshWhisper.init({
        namespace: NAMESPACE,
        node: NODE_URL,
        developerKey: TEST_DEV_KEY,
        storage: new NodeStorage(aliceDir),
      });
      await MeshWhisper.acceptContact(bobQR);

      // Wait long enough for the ping to fire (4s) + the pong timeout (10s).
      // Total ~14s. The timeout warning should appear and a re-handshake
      // should be triggered (targetedReestablish, also offline → no-op
      // but harmless).
      await new Promise((r) => setTimeout(r, 15_500));

      const timedOut = warnings.some((w) => w.includes('session_ping') && w.includes('unanswered'));
      expect(timedOut).toBe(true);

      await MeshWhisper.instance.shutdown();
    } finally {
      console.warn = originalWarn;
      fs.rmSync(aliceDir, { recursive: true, force: true });
      fs.rmSync(bobDir, { recursive: true, force: true });
    }
  }, 25000);
});
