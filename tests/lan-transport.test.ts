// ================================================================
// LAN bearer — discovery, broadcast fan-out, and dual-send delivery
// (docs/p2p-transport.md Phase 1)
//
// Two layers:
//   1. Transport-level: two LocalTransport instances on this host
//      discover each other via UDP broadcast and deliver a
//      broadcast-destination ('') packet over TCP.
//   2. SDK-level, the relay-down test: two SDK instances in child
//      processes establish a session via a local relay, the relay is
//      killed, and a message still arrives — via the LAN bearer.
// ================================================================

import { describe, it, expect, afterAll } from 'vitest';
import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { PacketFlags, type Packet } from '../src/types.js';
import { LocalTransport } from '../src/transport/local/index.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.join(__dirname, '..');
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');

function makePacket(payload: string): Packet {
  const encryptedPayload = new TextEncoder().encode(payload);
  return {
    version: 1,
    flags: PacketFlags.DATA,
    destHash: new Uint8Array(8).fill(7),
    senderEphemeralId: new Uint8Array(16).fill(9),
    ttl: 3,
    payloadLength: encryptedPayload.length,
    encryptedPayload,
  };
}

async function waitFor(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('LocalTransport — same-host discovery and broadcast', () => {
  it('two instances discover each other and deliver a broadcast packet', async () => {
    const a = new LocalTransport(new Uint8Array(16).fill(1), { tcpPort: 19311 });
    const b = new LocalTransport(new Uint8Array(16).fill(2), { tcpPort: 19312 });
    const received: string[] = [];
    b.onReceive((pkt) => received.push(new TextDecoder().decode(pkt.encryptedPayload)));

    try {
      await a.start();
      await b.start();
      await waitFor(
        () => a.connectedPeerCount() >= 1 && b.connectedPeerCount() >= 1,
        15_000,
        'mutual LAN discovery',
      );

      await a.send(makePacket('over-the-lan'), '');
      await waitFor(() => received.includes('over-the-lan'), 5_000, 'broadcast delivery');
      expect(received).toContain('over-the-lan');
    } finally {
      await a.stop();
      await b.stop();
    }
  }, 30_000);

  it('broadcast with zero peers is a quiet no-op', async () => {
    const lone = new LocalTransport(new Uint8Array(16).fill(3), { tcpPort: 19313, udpPort: 19315 });
    await lone.start();
    await expect(lone.send(makePacket('nobody-home'), '')).resolves.toBeUndefined();
    await lone.stop();
  });
});

// ---- SDK-level: message delivery with the relay dead ----

interface Worker {
  proc: childProcess.ChildProcess;
  lines: string[];
  send: (cmd: string) => void;
}

function spawnWorker(nodeUrl: string, username: string, tcpPort: number): Worker {
  const proc = childProcess.spawn(
    TSX,
    [path.join(__dirname, 'helpers', 'lan-worker.mts'), nodeUrl, username, String(tcpPort)],
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
  return { proc, lines, send: (cmd) => proc.stdin!.write(cmd + '\n') };
}

function spawnRelay(port: number): { proc: childProcess.ChildProcess; dbPath: string } {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mw-lan-relay-')), 'relay.db');
  const proc = childProcess.spawn(
    TSX,
    [path.join(REPO, 'node', 'src', 'index.ts')],
    {
      cwd: path.join(REPO, 'node'),
      env: { ...process.env, PORT: String(port), DB_PATH: dbPath },
      stdio: 'ignore',
    },
  );
  return { proc, dbPath };
}

async function waitForRelay(port: number, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
      if (resp.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() - start > timeoutMs) throw new Error('relay did not come up');
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('LAN dual-send — delivery survives relay death', () => {
  // Random ports per run: an orphaned relay from an aborted previous run
  // (afterAll never fires on a hard vitest abort) would otherwise answer
  // /health with a stale username registry and poison the @bob lookup.
  const PORT = 20000 + Math.floor(Math.random() * 5000);
  const LAN_BASE = 26000 + Math.floor(Math.random() * 5000);
  const procs: childProcess.ChildProcess[] = [];

  afterAll(() => {
    for (const p of procs) {
      try { p.kill('SIGKILL'); } catch { /* gone */ }
    }
  });

  it('message sent after the relay dies still arrives via the LAN bearer', async () => {
    const relay = spawnRelay(PORT);
    procs.push(relay.proc);
    await waitForRelay(PORT);

    const bob = spawnWorker(`ws://127.0.0.1:${PORT}`, 'bob', LAN_BASE);
    procs.push(bob.proc);
    await waitFor(() => bob.lines.some((l) => l.startsWith('READY')), 20_000, 'bob ready');

    const alice = spawnWorker(`ws://127.0.0.1:${PORT}`, 'alice', LAN_BASE + 1);
    procs.push(alice.proc);
    await waitFor(() => alice.lines.some((l) => l.startsWith('READY')), 20_000, 'alice ready');

    // Establish the session via the relay (prekey lookup + X3DH).
    alice.send('ADD @bob');
    await waitFor(() => alice.lines.some((l) => l.startsWith('ADDED')), 40_000, 'contact added');
    // Let the handshake_activate round-trip settle before the first send —
    // under full-suite load the race surfaces as a delayed first delivery.
    await new Promise((r) => setTimeout(r, 2_500));

    // Sanity + dedup check while both paths are live: exactly one delivery.
    alice.send('SEND first-with-relay');
    await waitFor(() => bob.lines.some((l) => l === 'MSG first-with-relay'), 40_000, 'first message');
    await new Promise((r) => setTimeout(r, 2_000));
    expect(bob.lines.filter((l) => l === 'MSG first-with-relay')).toHaveLength(1);

    // Give UDP discovery time to establish the LAN TCP link (5s announce interval).
    await new Promise((r) => setTimeout(r, 7_000));

    // Kill the relay. Both peers lose their node connection.
    relay.proc.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 2_000));

    // The money shot: delivery with no relay anywhere.
    alice.send('SEND second-no-relay');
    await waitFor(() => bob.lines.some((l) => l === 'MSG second-no-relay'), 15_000, 'LAN-only delivery');
    expect(bob.lines.filter((l) => l === 'MSG second-no-relay')).toHaveLength(1);
  }, 120_000);
});
