// ============================================================
// Presence — real END-PEER presence, not transport-neighbour.
//
// The bug this fixes: presence was keyed on the transport `source` that
// delivered a packet. In relay mode that's the relay, so getPresence(peer)
// never reflected the actual peer. Now any successfully DECRYPTED traffic
// from a real peer (message, control, receipt) marks that peer seen, and
// announcePresence() lets an idle-but-connected peer advertise liveness.
//
// Two peers on a shared local relay. We assert getPresence(realPeerId) — not
// the relay — reads 'online' after a DM and after an announce.
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
    [path.join(__dirname, 'helpers', 'presence-worker.mts'), nodeUrl, username],
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
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mw-pres-relay-')), 'relay.db');
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

async function getPresence(w: Worker, peerId: string): Promise<string> {
  const before = w.lines.length;
  w.send(`GETP ${peerId}`);
  await waitFor(() => w.lines.slice(before).some((l) => l.startsWith(`GOTP ${peerId}`)), 5000, 'getp');
  return w.lines.slice(before).find((l) => l.startsWith(`GOTP ${peerId}`))!.split(' ')[2]!;
}

describe('Presence — real end-peer, over a relay', () => {
  const PORT = 30100 + Math.floor(Math.random() * 4000);
  const procs: childProcess.ChildProcess[] = [];
  let alice!: Worker;
  let bob!: Worker;

  beforeAll(async () => {
    const relay = spawnRelay(PORT);
    procs.push(relay);
    await waitForRelay(PORT);
    const nodeUrl = `ws://127.0.0.1:${PORT}`;

    bob = spawnWorker(nodeUrl, 'pres-bob');
    alice = spawnWorker(nodeUrl, 'pres-alice');
    procs.push(bob.proc, alice.proc);

    for (const w of [alice, bob]) {
      await waitFor(() => w.lines.some((l) => l.startsWith('READY')), 25_000, 'ready');
      w.peerId = w.lines.find((l) => l.startsWith('READY'))!.slice(6);
    }
    await new Promise((r) => setTimeout(r, 2000));

    alice.send('ADD @pres-bob');
    await waitFor(() => alice.lines.some((l) => l.startsWith('ADDED')), 30_000, 'alice added bob');
    await new Promise((r) => setTimeout(r, 1500));
  }, 120_000);

  afterAll(() => {
    for (const p of procs) {
      try { p.kill('SIGKILL'); } catch { /* gone */ }
    }
  });

  it('getPresence reflects the real peer (not the relay) after a DM', async () => {
    // bob messages alice; alice should now see bob — by bob's REAL peerId — online.
    bob.send(`SEND ${alice.peerId} hello-from-bob`);
    await waitFor(() => alice.lines.some((l) => l === `MSG ${bob.peerId} hello-from-bob`), 30_000, 'alice got bob msg');

    expect(await getPresence(alice, bob.peerId)).toBe('online');
    // onPresence fired for bob's real peerId at some point during the exchange.
    expect(alice.lines.some((l) => l === `PRESENCE ${bob.peerId} online`)).toBe(true);
    // Sanity: the relay's own id is never what a peer queries — presence is keyed by peer.
    expect(await getPresence(alice, 'ws://127.0.0.1:' + PORT)).toBe('unknown');
  }, 60_000);

  it('announcePresence makes an idle peer read as online on both sides', async () => {
    // alice announces to bob (no chat message). bob records alice online from the
    // ping; alice records bob online from the echoed pong.
    alice.send(`ANNOUNCE ${bob.peerId}`);
    await new Promise((r) => setTimeout(r, 2000)); // let the ping/pong round-trip

    expect(await getPresence(bob, alice.peerId)).toBe('online');
    expect(await getPresence(alice, bob.peerId)).toBe('online');
  }, 60_000);
});
