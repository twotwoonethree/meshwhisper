// ============================================================
// Group receipts — per-member delivery + read status.
//
// DMs already had delivery/read receipts (a scalar status per message).
// A group message has many recipients, so receipts are a per-member map:
// each recipient fans a 'delivered' back over the group channel on receive,
// and markGroupRead() fans a 'read'. The original SENDER accumulates them in
// StoredMessage.groupReceipts and is notified via onGroupReceipt.
//
// Three SDK instances (per-process singleton) form a group on a shared local
// relay. We assert the sender learns both members delivered, then that a
// member's read receipt arrives — proving the path end to end.
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.join(__dirname, '..');
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');

interface Worker {
  proc: childProcess.ChildProcess;
  lines: string[];
  send: (cmd: string) => void;
  peerId: string;
}

async function waitFor(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function spawnWorker(nodeUrl: string, username: string): Worker {
  const proc = childProcess.spawn(
    TSX,
    [path.join(__dirname, 'helpers', 'group-worker.mts'), nodeUrl, username],
    { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const lines: string[] = [];
  let buf = '';
  proc.stdout!.on('data', (d: Buffer) => {
    buf += d.toString();
    const parts = buf.split('\n');
    buf = parts.pop()!;
    for (const line of parts) {
      lines.push(line);
      process.stdout.write(`[${username}] ${line}\n`);
    }
  });
  proc.stderr!.on('data', (d: Buffer) => process.stderr.write(`[${username}!] ${d}`));
  return { proc, lines, send: (cmd) => proc.stdin!.write(cmd + '\n'), peerId: '' };
}

function spawnRelay(port: number): childProcess.ChildProcess {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mw-grcpt-relay-')), 'relay.db');
  return childProcess.spawn(TSX, [path.join(REPO, 'node', 'src', 'index.ts')], {
    cwd: path.join(REPO, 'node'),
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath },
    stdio: 'ignore',
  });
}

async function waitForRelay(port: number, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() - start > timeoutMs) throw new Error('relay did not come up');
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('Group receipts — per-member delivery and read', () => {
  const PORT = 28100 + Math.floor(Math.random() * 4000);
  const procs: childProcess.ChildProcess[] = [];
  let alice!: Worker;
  let bob!: Worker;
  let carol!: Worker;
  let groupId!: string;

  beforeAll(async () => {
    const relay = spawnRelay(PORT);
    procs.push(relay);
    await waitForRelay(PORT);

    const nodeUrl = `ws://127.0.0.1:${PORT}`;
    bob = spawnWorker(nodeUrl, 'bob');
    carol = spawnWorker(nodeUrl, 'carol');
    alice = spawnWorker(nodeUrl, 'alice');
    procs.push(bob.proc, carol.proc, alice.proc);

    for (const w of [alice, bob, carol]) {
      await waitFor(() => w.lines.some((l) => l.startsWith('READY')), 25_000, 'ready');
      w.peerId = w.lines.find((l) => l.startsWith('READY'))!.slice(6);
    }
    await new Promise((r) => setTimeout(r, 1500));

    alice.send('ADD @bob');
    alice.send('ADD @carol');
    await waitFor(() => alice.lines.filter((l) => l.startsWith('ADDED')).length >= 2, 30_000, 'alice added both');
    await new Promise((r) => setTimeout(r, 2000));

    alice.send(`CREATE chat ${bob.peerId} ${carol.peerId}`);
    await waitFor(() => alice.lines.some((l) => l.startsWith('CREATED')), 15_000, 'group created');
    groupId = alice.lines.find((l) => l.startsWith('CREATED'))!.slice(8);
    await waitFor(
      () => bob.lines.some((l) => l === `INVITED ${groupId}`) && carol.lines.some((l) => l === `INVITED ${groupId}`),
      30_000,
      'invites accepted',
    );
    await new Promise((r) => setTimeout(r, 1500));
  }, 180_000);

  afterAll(() => {
    for (const p of procs) {
      try { p.kill('SIGKILL'); } catch { /* gone */ }
    }
  });

  it('sender learns each member delivered, then that a member read it', async () => {
    const before = { bob: bob.lines.length, carol: carol.lines.length, alice: alice.lines.length };
    alice.send(`GSEND ${groupId} receipt-target`);

    // Both members receive the message.
    await waitFor(
      () =>
        bob.lines.slice(before.bob).some((l) => l.startsWith(`MSG ${groupId}`) && l.endsWith(' receipt-target')) &&
        carol.lines.slice(before.carol).some((l) => l.startsWith(`MSG ${groupId}`) && l.endsWith(' receipt-target')),
      30_000,
      'message delivered to members',
    );
    const msgId = bob.lines.find((l) => l.startsWith(`MSG ${groupId}`) && l.endsWith(' receipt-target'))!.split(' ')[2]!;

    // Alice (the sender) gets a 'delivered' receipt from BOTH bob and carol.
    await waitFor(
      () =>
        alice.lines.some((l) => l === `GRECEIPT ${groupId} ${msgId} ${bob.peerId} delivered`) &&
        alice.lines.some((l) => l === `GRECEIPT ${groupId} ${msgId} ${carol.peerId} delivered`),
      30_000,
      'delivered receipts from both members',
    );

    // Bob reads it → Alice gets a 'read' receipt from bob (and only bob).
    bob.send(`GREAD ${groupId} ${msgId}`);
    await waitFor(
      () => alice.lines.some((l) => l === `GRECEIPT ${groupId} ${msgId} ${bob.peerId} read`),
      30_000,
      'read receipt from bob',
    );

    // Carol never read it, so no read receipt from carol.
    expect(alice.lines.some((l) => l === `GRECEIPT ${groupId} ${msgId} ${carol.peerId} read`)).toBe(false);

    // Persisted shape on the sender's outbound copy: bob=read, carol=delivered.
    const showBefore = alice.lines.length;
    alice.send(`SHOW ${groupId} ${msgId}`);
    await waitFor(() => alice.lines.slice(showBefore).some((l) => l.startsWith(`STORED ${groupId}`)), 5000, 'show');
    const line = alice.lines.slice(showBefore).find((l) => l.startsWith(`STORED ${groupId}`))!;
    const fields = JSON.parse(line.slice(`STORED ${groupId} ${msgId} `.length));
    expect(fields.groupReceipts?.[bob.peerId]).toBe('read');
    expect(fields.groupReceipts?.[carol.peerId]).toBe('delivered');
  }, 120_000);
});
