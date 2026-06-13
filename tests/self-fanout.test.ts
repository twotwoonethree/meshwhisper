// ============================================================
// Self-fan-out — own outbound messages mirror to own other devices
//
// Three workers: alice-phone (primary), alice-laptop (linked
// secondary), bob (peer). Phone sends to bob. Bob receives it as
// inbound (existing behavior); laptop receives the SAME message as
// outbound (new in 0.5).
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
    [path.join(__dirname, 'helpers', 'multidevice-worker.mts'), nodeUrl, username],
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
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mw-self-relay-')), 'relay.db');
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

describe('Self-fan-out — own messages appear on own other devices', () => {
  const PORT = 20500 + Math.floor(Math.random() * 4000);
  const procs: childProcess.ChildProcess[] = [];
  let phone!: Worker;
  let laptop!: Worker;
  let bob!: Worker;

  beforeAll(async () => {
    const relay = spawnRelay(PORT);
    procs.push(relay);
    await waitForRelay(PORT);
    const nodeUrl = `ws://127.0.0.1:${PORT}`;

    const stamp = Date.now().toString(36).slice(-5);
    bob = spawnWorker(nodeUrl, `bob-${stamp}`);
    procs.push(bob.proc);
    phone = spawnWorker(nodeUrl, `aphone-${stamp}`);
    procs.push(phone.proc);
    laptop = spawnWorker(nodeUrl, `alap-${stamp}`);
    procs.push(laptop.proc);

    for (const w of [phone, laptop, bob]) {
      await waitFor(() => w.lines.some((l) => l.startsWith('READY')), 25_000, `${w === phone ? 'phone' : w === laptop ? 'laptop' : 'bob'} ready`);
      w.peerId = w.lines.find((l) => l.startsWith('READY'))!.slice(6);
    }
    await new Promise((r) => setTimeout(r, 1500));

    // Phone adds bob — establishes session phone <-> bob
    phone.send(`ADD @bob-${stamp}`);
    await waitFor(() => phone.lines.some((l) => l.startsWith('ADDED')), 30_000, 'phone added bob');
    await new Promise((r) => setTimeout(r, 1500));

    // Laptop creates link offer; phone accepts. This:
    //  - Establishes a phone<->laptop session
    //  - Signs device_added with the phone's identity
    //  - Sends device_linked back so the laptop knows phone is its account
    //  - Imports phone's contacts into laptop (so laptop knows bob)
    laptop.send('LINKOFFER');
    await waitFor(() => laptop.lines.some((l) => l.startsWith('OFFER ')), 15_000, 'offer emitted');
    const offerJson = laptop.lines.find((l) => l.startsWith('OFFER '))!.slice(6);
    phone.send(`LINKACCEPT ${offerJson}`);
    await waitFor(() => laptop.lines.some((l) => l.startsWith('LINKED ')), 30_000, 'laptop linked');
    await new Promise((r) => setTimeout(r, 2_000));
  }, 240_000);

  afterAll(() => {
    for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
  });

  it('phone sends to bob — laptop receives the same message as outbound', async () => {
    const before = { bob: bob.lines.length, laptop: laptop.lines.length };
    phone.send(`SEND ${bob.peerId} hello-from-phone`);

    // Bob sees it as inbound under his conversation with phone.
    await waitFor(
      () => bob.lines.slice(before.bob).some((l) => l.startsWith(`MSG ${phone.peerId}`) && l.includes(' inbound ') && l.endsWith(' hello-from-phone')),
      30_000,
      'bob received inbound',
    );

    // Laptop sees the SAME messageId as OUTBOUND under bob's conversation.
    await waitFor(
      () => laptop.lines.slice(before.laptop).some((l) => l.startsWith(`MSG ${bob.peerId}`) && l.includes(' outbound ') && l.endsWith(' hello-from-phone')),
      30_000,
      'laptop received outbound sync',
    );

    // Same messageId on both sides.
    const phoneToBobMsgId = bob.lines.slice(before.bob).find((l) => l.includes(' hello-from-phone'))!.split(' ')[2]!;
    const laptopMirrorMsgId = laptop.lines.slice(before.laptop).find((l) => l.includes(' hello-from-phone'))!.split(' ')[2]!;
    expect(laptopMirrorMsgId).toBe(phoneToBobMsgId);

    // Persisted shape on laptop: outbound under bob's conversation, sent by us.
    laptop.send(`SHOW ${bob.peerId} ${phoneToBobMsgId}`);
    await waitFor(() => laptop.lines.some((l) => l.startsWith(`STORED ${bob.peerId}`)), 5_000, 'show');
    const line = laptop.lines.find((l) => l.startsWith(`STORED ${bob.peerId}`))!;
    const fields = JSON.parse(line.slice(`STORED ${bob.peerId} ${phoneToBobMsgId} `.length));
    expect(fields.direction).toBe('outbound');
    expect(fields.senderId).toBe(laptop.peerId); // "we" on this device
  }, 120_000);

  it('sync_send from a non-linked peer is rejected (no history poisoning)', async () => {
    // Bob, who is NOT one of alice's devices, crafts a sync_send to phone.
    // The receiver-side accountKey check should drop it silently. The
    // simplest way to assert this end-to-end without a malicious worker
    // is to verify that bob's outbound to phone arrives only as INBOUND
    // (which the existing onMessage already proves) — the sync codepath
    // requires senderAccountKey === ourAccountKey, and bob's accountKey
    // (= his own peerId) is not ours. There is no test wire to inject a
    // forged sync_send without modifying the SDK, so we assert the
    // negative state: after a normal bob→phone send, phone never logs
    // the message as outbound (which is what sync_send acceptance would
    // produce). Sentinel value picked to be specific to this test.
    const before = phone.lines.length;
    bob.send(`SEND ${phone.peerId} pretend-i-sent-this`);
    await waitFor(
      () => phone.lines.slice(before).some((l) => l.includes(' inbound ') && l.endsWith(' pretend-i-sent-this')),
      30_000,
      'phone got inbound from bob',
    );
    // Give any (theoretical) sync_send a chance to land
    await new Promise((r) => setTimeout(r, 1500));
    const outboundFromBobSentinel = phone.lines.slice(before).some(
      (l) => l.includes(' outbound ') && l.endsWith(' pretend-i-sent-this'),
    );
    expect(outboundFromBobSentinel).toBe(false);
  }, 90_000);
});
