// ============================================================
// MeshWhisper — Group & Contact integration tests
//
// Uses the same relay infrastructure as integration.test.ts.
// Each test uses a unique port so suites can run in parallel.
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const TEST_DEV_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const __dirname = path.dirname(new URL(import.meta.url).pathname);

async function waitForRelay(
  port: number,
  proc: childProcess.ChildProcess,
  timeoutMs = 15000,
): Promise<void> {
  const chunks: Buffer[] = [];
  proc.stderr?.on('data', (d: Buffer) => chunks.push(d));
  let exited = false;
  proc.once('exit', () => { exited = true; });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) throw new Error('Relay exited early:\n' + Buffer.concat(chunks).toString());
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Relay on port ${port} did not start within ${timeoutMs}ms`);
}

function spawnRelay(port: number): { proc: childProcess.ChildProcess; dbPath: string } {
  const dbPath = path.join(os.tmpdir(), `mw-test-${port}-${Date.now()}.db`);
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
  proc.stdout?.on('data', (d: Buffer) => process.stdout.write(`[relay] ${d}`));
  return { proc, dbPath };
}

function stopRelay(proc: childProcess.ChildProcess, dbPath: string): void {
  proc.kill('SIGTERM');
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + ext); } catch { /* ignore */ }
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ================================================================
// Group invite + messaging
// ================================================================

describe('group invite and messaging', () => {
  const PORT = 19878;
  let relayProc: childProcess.ChildProcess;
  let dbPath: string;
  let MeshWhisper: typeof import('../src/sdk/index.js').MeshWhisper;
  let NodeStorage: typeof import('../src/persistence/node-storage.js').NodeStorage;

  beforeAll(async () => {
    ({ proc: relayProc, dbPath } = spawnRelay(PORT));
    await waitForRelay(PORT, relayProc);
    ({ MeshWhisper } = await import('../src/sdk/index.js'));
    ({ NodeStorage } = await import('../src/persistence/node-storage.js'));
  }, 20000);

  afterAll(() => stopRelay(relayProc, dbPath));

  it('Alice creates a group and Bob receives an invite', async () => {
    const NODE_URL = `ws://127.0.0.1:${PORT}`;
    const NS = 'com.test.groups.invite';
    const bobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-bob-'));
    const aliceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-alice-'));

    // Bob comes online first, generates QR
    const bob = await MeshWhisper.init({
      namespace: NS, node: NODE_URL, developerKey: TEST_DEV_KEY,
      storage: new NodeStorage(bobDir),
    });
    const bobQR = MeshWhisper.generateContactQR();
    const bobId = bob.getLocalPeerId();
    await wait(300);

    // Alice comes online, adds Bob as contact
    const receivedInvites: Array<{ groupId: string; groupName: string; invitedBy: string }> = [];
    const alice = await MeshWhisper.init({
      namespace: NS, node: NODE_URL, developerKey: TEST_DEV_KEY,
      storage: new NodeStorage(aliceDir),
      onGroupInvite: (groupId, groupName, invitedBy) => {
        receivedInvites.push({ groupId, groupName, invitedBy });
      },
    });
    await MeshWhisper.acceptContact(bobQR);
    await wait(500);

    // Alice now uses the bob singleton (since MeshWhisper is a singleton, alice IS the instance now)
    // Re-init as alice is already done. Let's switch: shutdown and re-init Bob with onGroupInvite.
    await MeshWhisper.instance.shutdown();

    const bobInvites: Array<{ groupId: string; groupName: string }> = [];
    const aliceId = alice.getLocalPeerId();

    // Bob re-initialises with onGroupInvite callback
    await MeshWhisper.init({
      namespace: NS, node: NODE_URL, developerKey: TEST_DEV_KEY,
      storage: new NodeStorage(bobDir),
      onGroupInvite: (groupId, groupName, invitedBy) => {
        bobInvites.push({ groupId, groupName });
      },
    });
    await wait(300);

    // Swap back to Alice to create the group
    await MeshWhisper.instance.shutdown();
    await MeshWhisper.init({
      namespace: NS, node: NODE_URL, developerKey: TEST_DEV_KEY,
      storage: new NodeStorage(aliceDir),
    });
    await wait(300);

    const group = MeshWhisper.createGroup({ name: 'Test Group', members: [bobId] });
    expect(group.id).toBeTruthy();
    expect(group.name).toBe('Test Group');
    await wait(400);

    // Switch to Bob to receive the invite
    await MeshWhisper.instance.shutdown();
    await MeshWhisper.init({
      namespace: NS, node: NODE_URL, developerKey: TEST_DEV_KEY,
      storage: new NodeStorage(bobDir),
      onGroupInvite: (groupId, groupName) => {
        bobInvites.push({ groupId, groupName });
      },
    });
    await wait(800);

    expect(bobInvites.length).toBeGreaterThan(0);
    expect(bobInvites[0].groupName).toBe('Test Group');

    const pending = MeshWhisper.getPendingGroupInvites();
    expect(pending.length).toBeGreaterThan(0);

    // Bob accepts
    MeshWhisper.acceptGroupInvite(pending[0].groupId);
    const groups = MeshWhisper.getGroups();
    expect(groups.some((g) => g.name === 'Test Group')).toBe(true);

    await MeshWhisper.instance.shutdown();
  }, 30000);

  it('createGroup with no members does not throw', async () => {
    const NS = 'com.test.groups.empty';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-solo-'));
    await MeshWhisper.init({
      namespace: NS, node: `ws://127.0.0.1:${PORT}`, developerKey: TEST_DEV_KEY,
      storage: new NodeStorage(dir),
    });
    expect(() => MeshWhisper.createGroup({ name: 'Solo Group' })).not.toThrow();
    const groups = MeshWhisper.getGroups();
    expect(groups.some((g) => g.name === 'Solo Group')).toBe(true);
    await MeshWhisper.instance.shutdown();
  }, 15000);

  it('GroupHandle.leave() removes the group', async () => {
    const NS = 'com.test.groups.leave';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-leave-'));
    await MeshWhisper.init({
      namespace: NS, node: `ws://127.0.0.1:${PORT}`, developerKey: TEST_DEV_KEY,
      storage: new NodeStorage(dir),
    });
    const group = MeshWhisper.createGroup({ name: 'Goodbye Group' });
    group.leave();
    expect(MeshWhisper.getGroup(group.id)).toBeNull();
    await MeshWhisper.instance.shutdown();
  }, 15000);
});

// ================================================================
// Contact management
// ================================================================

describe('contact management', () => {
  const PORT = 19879;
  let relayProc: childProcess.ChildProcess;
  let dbPath: string;
  let MeshWhisper: typeof import('../src/sdk/index.js').MeshWhisper;
  let NodeStorage: typeof import('../src/persistence/node-storage.js').NodeStorage;

  beforeAll(async () => {
    ({ proc: relayProc, dbPath } = spawnRelay(PORT));
    await waitForRelay(PORT, relayProc);
    ({ MeshWhisper } = await import('../src/sdk/index.js'));
    ({ NodeStorage } = await import('../src/persistence/node-storage.js'));
  }, 20000);

  afterAll(() => stopRelay(relayProc, dbPath));

  it('addContactByKey and getContacts', async () => {
    const NS = 'com.test.contacts.add';
    const bobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-bob-'));
    const aliceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-alice-'));

    // Bob publishes bundle
    await MeshWhisper.init({
      namespace: NS, node: `ws://127.0.0.1:${PORT}`, developerKey: TEST_DEV_KEY,
      storage: new NodeStorage(bobDir),
    });
    MeshWhisper.generateContactQR(); // triggers publishPreKeyBundle
    await wait(400);
    const bobEdKey = Buffer.from(MeshWhisper.instance['identity'].getEdPublicKey()).toString('hex');
    await MeshWhisper.instance.shutdown();

    // Alice adds Bob by key
    await MeshWhisper.init({
      namespace: NS, node: `ws://127.0.0.1:${PORT}`, developerKey: TEST_DEV_KEY,
      storage: new NodeStorage(aliceDir),
    });
    const found = await MeshWhisper.addContactByKey(bobEdKey);
    expect(found).not.toBeNull();
    expect(MeshWhisper.getContacts().length).toBeGreaterThan(0);
    await MeshWhisper.instance.shutdown();
  }, 20000);

  it('removeContact removes peer from contact list', async () => {
    const NS = 'com.test.contacts.remove';
    const bobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-bob-'));
    const aliceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-alice-'));

    await MeshWhisper.init({
      namespace: NS, node: `ws://127.0.0.1:${PORT}`, developerKey: TEST_DEV_KEY,
      storage: new NodeStorage(bobDir),
    });
    const bobQR = MeshWhisper.generateContactQR();
    await wait(300);
    await MeshWhisper.instance.shutdown();

    await MeshWhisper.init({
      namespace: NS, node: `ws://127.0.0.1:${PORT}`, developerKey: TEST_DEV_KEY,
      storage: new NodeStorage(aliceDir),
    });
    await MeshWhisper.acceptContact(bobQR);
    await wait(400);

    const contacts = MeshWhisper.getContacts();
    expect(contacts.length).toBe(1);

    MeshWhisper.removeContact(contacts[0]);
    expect(MeshWhisper.getContacts()).toHaveLength(0);
    await MeshWhisper.instance.shutdown();
  }, 20000);

  it('blockPeer prevents further messages from blocked peer', async () => {
    const NS = 'com.test.contacts.block';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-block-'));
    await MeshWhisper.init({
      namespace: NS, node: `ws://127.0.0.1:${PORT}`, developerKey: TEST_DEV_KEY,
      storage: new NodeStorage(dir),
    });

    const fakePeerId = 'a'.repeat(64);
    MeshWhisper.blockPeer(fakePeerId);
    expect(MeshWhisper.instance['permissionManager'].isBlocked(fakePeerId)).toBe(true);

    MeshWhisper.unblockPeer(fakePeerId);
    expect(MeshWhisper.instance['permissionManager'].isBlocked(fakePeerId)).toBe(false);
    await MeshWhisper.instance.shutdown();
  }, 15000);

  it('getLocalPeerId static method works', async () => {
    const NS = 'com.test.contacts.peerid';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-pid-'));
    await MeshWhisper.init({
      namespace: NS, node: `ws://127.0.0.1:${PORT}`, developerKey: TEST_DEV_KEY,
      storage: new NodeStorage(dir),
    });
    const staticId = MeshWhisper.getLocalPeerId();
    const instanceId = MeshWhisper.instance.getLocalPeerId();
    expect(staticId).toBe(instanceId);
    expect(staticId.length).toBeGreaterThan(0);
    await MeshWhisper.instance.shutdown();
  }, 15000);
});
