// ============================================================
// Group fan-out — reactions, replies, forwarding, disappearing
// messages now work in groups (DM-only before).
//
// Three SDK instances (the SDK is a per-process singleton) form a
// group; each test verifies the fan-out path lands the right
// persisted state on the OTHER two members. The relay is shared.
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
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mw-grp-relay-')), 'relay.db');
  return childProcess.spawn(
    TSX,
    [path.join(REPO, 'node', 'src', 'index.ts')],
    {
      cwd: path.join(REPO, 'node'),
      env: { ...process.env, PORT: String(port), DB_PATH: dbPath },
      stdio: 'ignore',
    },
  );
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

function pickLast<T>(lines: string[], prefix: string, parse: (l: string) => T | null): T | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.startsWith(prefix)) {
      const v = parse(lines[i]!);
      if (v !== null) return v;
    }
  }
  return null;
}

describe('Group fan-out — reactions, replies, forwarding, disappearing', () => {
  const PORT = 20100 + Math.floor(Math.random() * 4000);
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
    procs.push(bob.proc);
    carol = spawnWorker(nodeUrl, 'carol');
    procs.push(carol.proc);
    alice = spawnWorker(nodeUrl, 'alice');
    procs.push(alice.proc);

    for (const w of [alice, bob, carol]) {
      await waitFor(() => w.lines.some((l) => l.startsWith('READY')), 25_000, `${w === alice ? 'alice' : w === bob ? 'bob' : 'carol'} ready`);
      const ready = w.lines.find((l) => l.startsWith('READY'))!;
      w.peerId = ready.slice(6);
    }

    // Wait for prekey publish to settle before username lookups.
    await new Promise((r) => setTimeout(r, 1500));

    alice.send('ADD @bob');
    alice.send('ADD @carol');
    await waitFor(() => alice.lines.filter((l) => l.startsWith('ADDED')).length >= 2, 30_000, 'alice added bob+carol');
    await new Promise((r) => setTimeout(r, 2000));

    // Alice creates the group with bob + carol; both auto-accept.
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

  it('group message reaches every other member', async () => {
    const before = { bob: bob.lines.length, carol: carol.lines.length };
    alice.send(`GSEND ${groupId} hello-team`);
    await waitFor(
      () => bob.lines.slice(before.bob).some((l) => l.startsWith(`MSG ${groupId}`) && l.endsWith(' hello-team'))
         && carol.lines.slice(before.carol).some((l) => l.startsWith(`MSG ${groupId}`) && l.endsWith(' hello-team')),
      30_000,
      'group delivery',
    );
  });

  it('reaction fans out — bob reacts, alice and carol both see it', async () => {
    const before = { alice: alice.lines.length, bob: bob.lines.length, carol: carol.lines.length };
    alice.send(`GSEND ${groupId} react-target`);
    await waitFor(
      () => bob.lines.slice(before.bob).some((l) => l.startsWith(`MSG ${groupId}`) && l.endsWith(' react-target')),
      30_000,
      'react-target landed',
    );
    const msgLine = bob.lines.slice(before.bob).find((l) => l.startsWith(`MSG ${groupId}`) && l.endsWith(' react-target'))!;
    const msgId = msgLine.split(' ')[2]!;

    const reactBefore = { alice: alice.lines.length, carol: carol.lines.length };
    bob.send(`GREACT ${groupId} ${msgId} 🎉`);
    await waitFor(
      () => alice.lines.slice(reactBefore.alice).some((l) => l === `REACT ${groupId} ${msgId} 🎉 ${bob.peerId} true`)
         && carol.lines.slice(reactBefore.carol).some((l) => l === `REACT ${groupId} ${msgId} 🎉 ${bob.peerId} true`),
      30_000,
      'reaction fanout',
    );

    // Persisted shape: each member's stored copy of the message carries
    // the reaction under bob's peerId.
    for (const peer of [alice, carol]) {
      const showBefore = peer.lines.length;
      peer.send(`SHOW ${groupId} ${msgId}`);
      await waitFor(() => peer.lines.slice(showBefore).some((l) => l.startsWith(`STORED ${groupId}`)), 5000, 'show');
      const line = peer.lines.slice(showBefore).find((l) => l.startsWith(`STORED ${groupId}`))!;
      const json = line.slice(`STORED ${groupId} ${msgId} `.length);
      const fields = JSON.parse(json);
      expect(fields.reactions?.['🎉']).toContain(bob.peerId);
    }
  }, 120_000);

  it('disappearing-messages policy fans out and new sends inherit the TTL', async () => {
    const changeBefore = { bob: bob.lines.length, carol: carol.lines.length };
    alice.send(`GDISAPPEAR ${groupId} 60000`);
    await waitFor(
      () => bob.lines.slice(changeBefore.bob).some((l) => l === `DISAPPEAR ${groupId} 60000 ${alice.peerId}`)
         && carol.lines.slice(changeBefore.carol).some((l) => l === `DISAPPEAR ${groupId} 60000 ${alice.peerId}`),
      30_000,
      'TTL propagated',
    );

    // A subsequent group send inherits the TTL and lands with expiresAt set.
    const msgBefore = { bob: bob.lines.length };
    alice.send(`GSEND ${groupId} expiring`);
    await waitFor(
      () => bob.lines.slice(msgBefore.bob).some((l) => l.startsWith(`MSG ${groupId}`) && l.endsWith(' expiring')),
      30_000,
      'expiring msg arrived',
    );
    const msgLine = bob.lines.slice(msgBefore.bob).find((l) => l.startsWith(`MSG ${groupId}`) && l.endsWith(' expiring'))!;
    const msgId = msgLine.split(' ')[2]!;
    const showBefore = bob.lines.length;
    bob.send(`SHOW ${groupId} ${msgId}`);
    await waitFor(() => bob.lines.slice(showBefore).some((l) => l.startsWith(`STORED ${groupId}`)), 5000, 'show');
    const showLine = bob.lines.slice(showBefore).find((l) => l.startsWith(`STORED ${groupId}`))!;
    const fields = JSON.parse(showLine.slice(`STORED ${groupId} ${msgId} `.length));
    expect(fields.expiresAt).toBeGreaterThan(Date.now());
  }, 120_000);

  it('replyTo on a group message survives the round-trip', async () => {
    const before = { bob: bob.lines.length, carol: carol.lines.length };
    alice.send(`GSEND ${groupId} reply-target`);
    await waitFor(
      () => bob.lines.slice(before.bob).some((l) => l.startsWith(`MSG ${groupId}`) && l.endsWith(' reply-target')),
      30_000,
      'reply-target landed',
    );
    const targetMsgId = bob.lines.slice(before.bob).find((l) => l.startsWith(`MSG ${groupId}`) && l.endsWith(' reply-target'))!.split(' ')[2]!;

    const replyBefore = { carol: carol.lines.length };
    bob.send(`REPLYSEND ${groupId} ${targetMsgId} reply-target::quoted-reply-text`);
    await waitFor(
      () => carol.lines.slice(replyBefore.carol).some((l) => l.startsWith(`MSG ${groupId}`) && l.endsWith(' quoted-reply-text')),
      30_000,
      'reply landed at carol',
    );
    const replyMsgId = carol.lines.slice(replyBefore.carol).find((l) => l.startsWith(`MSG ${groupId}`) && l.endsWith(' quoted-reply-text'))!.split(' ')[2]!;

    const showBefore = carol.lines.length;
    carol.send(`SHOW ${groupId} ${replyMsgId}`);
    await waitFor(() => carol.lines.slice(showBefore).some((l) => l.startsWith(`STORED ${groupId}`)), 5000, 'show');
    const line = carol.lines.slice(showBefore).find((l) => l.startsWith(`STORED ${groupId}`))!;
    const fields = JSON.parse(line.slice(`STORED ${groupId} ${replyMsgId} `.length));
    expect(fields.replyTo?.messageId).toBe(targetMsgId);
    expect(fields.replyTo?.snippetText).toBe('reply-target');
  }, 120_000);

  it('forwardMessage into a group routes via group send (not DM) and preserves original author', async () => {
    // Alice DMs bob a payload, then bob forwards it INTO the group.
    // (DM step uses the existing alice<->bob DM contact established at boot.)
    const beforeDm = bob.lines.length;
    // Use the SDK's regular send to bob from alice — alice has bob as a contact.
    // We can't directly drive that from the worker, so instead bob will
    // forward an existing group message TO the group itself (self-target
    // is rejected by toggleReaction-style noop logic — for forwarding it's
    // a legitimate "share the same payload again" operation, and the
    // important assertion is that group routing kicked in).
    void beforeDm;

    const groupMsgsBefore = { carol: carol.lines.length };
    alice.send(`GSEND ${groupId} forward-source`);
    await waitFor(
      () => bob.lines.some((l) => l.startsWith(`MSG ${groupId}`) && l.endsWith(' forward-source')),
      30_000,
      'forward-source landed',
    );
    const sourceMsgId = bob.lines.find((l) => l.startsWith(`MSG ${groupId}`) && l.endsWith(' forward-source'))!.split(' ')[2]!;

    bob.send(`GFORWARD ${groupId} ${sourceMsgId} ${groupId}`);
    await waitFor(
      () => carol.lines.slice(groupMsgsBefore.carol).filter(
        (l) => l.startsWith(`MSG ${groupId}`) && l.endsWith(' forward-source'),
      ).length >= 2,
      30_000,
      'forwarded copy landed at carol',
    );

    // forwardedFrom must be alice (the original author), not bob the forwarder.
    // Find the most recent forward-source message on carol's side.
    const forwardedMsgs = carol.lines
      .filter((l) => l.startsWith(`MSG ${groupId}`) && l.endsWith(' forward-source'))
      .map((l) => l.split(' ')[2]!);
    const forwardedMsgId = forwardedMsgs[forwardedMsgs.length - 1]!;
    const showBefore = carol.lines.length;
    carol.send(`SHOW ${groupId} ${forwardedMsgId}`);
    await waitFor(() => carol.lines.slice(showBefore).some((l) => l.startsWith(`STORED ${groupId}`)), 5000, 'show');
    const line = carol.lines.slice(showBefore).find((l) => l.startsWith(`STORED ${groupId}`))!;
    const fields = JSON.parse(line.slice(`STORED ${groupId} ${forwardedMsgId} `.length));
    expect(fields.forwardedFrom).toBe(alice.peerId);
  }, 120_000);
});
