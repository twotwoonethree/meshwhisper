// ============================================================
// Customer service, end to end — the commercial-CS shape proven
// against a real (local) relay, no LLM key required.
//
//   guest customer  ─DM→  triage bot  ─escalates→  supervised group
//                                          [customer, agent, supervisor]
//
// What this proves:
//  1. An ANONYMOUS customer (no registered username — a generated guest
//     identity, the way a web visitor reaches support) can reach the
//     triage bot and hold an E2EE conversation.
//  2. The triage bot autonomously decides to escalate and forms a
//     supervised group (rule-based here; LLM in examples/ticket-lifecycle).
//  3. Supervisor oversight is by group MEMBERSHIP — the supervisor sees
//     every message in the escalated conversation because it is an
//     encrypted recipient, not because the relay can read anything.
//
// Five processes (relay + 4 peers); the SDK is a per-process singleton.
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

function spawnWorker(nodeUrl: string, role: string, username?: string): Worker {
  const args = [path.join(__dirname, 'helpers', 'cs-worker.mts'), nodeUrl, role];
  if (username) args.push(username);
  const proc = childProcess.spawn(TSX, args, { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] });
  const label = username ?? role;
  const lines: string[] = [];
  let buf = '';
  proc.stdout!.on('data', (d: Buffer) => {
    buf += d.toString();
    const parts = buf.split('\n');
    buf = parts.pop()!;
    for (const line of parts) {
      lines.push(line);
      process.stdout.write(`[${label}] ${line}\n`);
    }
  });
  proc.stderr!.on('data', (d: Buffer) => process.stderr.write(`[${label}!] ${d}`));
  return { proc, lines, send: (cmd) => proc.stdin!.write(cmd + '\n'), peerId: '' };
}

function spawnRelay(port: number): childProcess.ChildProcess {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mw-cs-relay-')), 'relay.db');
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

function readyPeerId(w: Worker): string {
  return w.lines.find((l) => l.startsWith('READY'))!.slice(6);
}

describe('Customer service — guest customer, autonomous triage, supervised escalation', () => {
  const PORT = 24100 + Math.floor(Math.random() * 4000);
  const procs: childProcess.ChildProcess[] = [];
  let triage!: Worker;
  let agent!: Worker;
  let supervisor!: Worker;
  let customer!: Worker;
  let triagePeerId!: string;

  beforeAll(async () => {
    const relay = spawnRelay(PORT);
    procs.push(relay);
    await waitForRelay(PORT);
    const nodeUrl = `ws://127.0.0.1:${PORT}`;

    // Support staff register usernames so they're resolvable.
    agent = spawnWorker(nodeUrl, 'agent', 'acme-agent');
    supervisor = spawnWorker(nodeUrl, 'supervisor', 'acme-supervisor');
    triage = spawnWorker(nodeUrl, 'triage', 'acme-triage');
    // The customer is a GUEST — no username.
    customer = spawnWorker(nodeUrl, 'customer');
    procs.push(agent.proc, supervisor.proc, triage.proc, customer.proc);

    for (const w of [agent, supervisor, triage, customer]) {
      await waitFor(() => w.lines.some((l) => l.startsWith('READY')), 25_000, 'ready');
      w.peerId = readyPeerId(w);
    }

    // Let prekey bundles publish before username lookups.
    await new Promise((r) => setTimeout(r, 2000));

    // Triage resolves + establishes sessions with agent and supervisor.
    triage.send('PREP @acme-agent @acme-supervisor');
    await waitFor(() => triage.lines.some((l) => l === 'PREPPED'), 30_000, 'triage prepped');

    // Guest customer reaches support by the triage handle.
    customer.send('ADD @acme-triage');
    await waitFor(() => customer.lines.some((l) => l.startsWith('ADDED')), 30_000, 'customer added triage');
    triagePeerId = customer.lines.find((l) => l.startsWith('ADDED'))!.slice(6);
    await new Promise((r) => setTimeout(r, 1500));
  }, 180_000);

  afterAll(() => {
    for (const p of procs) {
      try { p.kill('SIGKILL'); } catch { /* gone */ }
    }
  });

  it('guest customer can DM the triage bot and get a reply (no escalation)', async () => {
    const before = customer.lines.length;
    customer.send(`SEND ${triagePeerId} what are your opening hours`);
    await waitFor(
      () => customer.lines.slice(before).some((l) => l.startsWith(`MSG ${triagePeerId}`) && l.includes('ack: what are your opening hours')),
      30_000,
      'triage reply to guest',
    );
  }, 60_000);

  it('triage escalates to a supervised group; agent + supervisor + guest all join', async () => {
    customer.send(`SEND ${triagePeerId} I really need to speak to a human`);
    await waitFor(() => triage.lines.some((l) => l.startsWith('ESCALATED')), 30_000, 'triage escalated');
    const groupId = triage.lines.find((l) => l.startsWith('ESCALATED'))!.split(' ')[1]!;

    await waitFor(
      () => [customer, agent, supervisor].every((w) => w.lines.some((l) => l === `INVITED ${groupId}`)),
      30_000,
      'all members joined the supervised group',
    );
  }, 90_000);

  it('agent reply + guest reply both reach the supervisor — oversight by membership', async () => {
    const groupId = triage.lines.find((l) => l.startsWith('ESCALATED'))!.split(' ')[1]!;

    // Human agent answers in the group; guest customer AND supervisor must see it.
    const beforeAgentMsg = { customer: customer.lines.length, supervisor: supervisor.lines.length };
    agent.send(`GSEND ${groupId} hi this is a human agent how can I help`);
    await waitFor(
      () =>
        customer.lines.slice(beforeAgentMsg.customer).some((l) => l.startsWith(`MSG ${groupId}`) && l.includes('human agent')) &&
        supervisor.lines.slice(beforeAgentMsg.supervisor).some((l) => l.startsWith(`MSG ${groupId}`) && l.includes('human agent')),
      30_000,
      'agent message reached guest + supervisor',
    );

    // Guest replies in the group; agent AND supervisor must see it.
    const beforeCustMsg = { agent: agent.lines.length, supervisor: supervisor.lines.length };
    customer.send(`GSEND ${groupId} yes my order 1234 never arrived`);
    await waitFor(
      () =>
        agent.lines.slice(beforeCustMsg.agent).some((l) => l.startsWith(`MSG ${groupId}`) && l.includes('order 1234')) &&
        supervisor.lines.slice(beforeCustMsg.supervisor).some((l) => l.startsWith(`MSG ${groupId}`) && l.includes('order 1234')),
      30_000,
      'guest message reached agent + supervisor',
    );

    // The supervisor — purely by being a group member — has seen both sides.
    const supSawAgent = supervisor.lines.some((l) => l.startsWith(`MSG ${groupId}`) && l.includes('human agent'));
    const supSawCustomer = supervisor.lines.some((l) => l.startsWith(`MSG ${groupId}`) && l.includes('order 1234'));
    expect(supSawAgent && supSawCustomer).toBe(true);
  }, 90_000);
});
