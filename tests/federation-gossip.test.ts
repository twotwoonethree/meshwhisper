// ============================================================
// Federation gossip address overlay — ADR-010 stage-2
//
// Proves DNS-free relay LOCATION: relay A delivers a packet to relay B that it
// has NO static configuration for (no peer entry, no URL). A and B each only
// know a shared bootstrap relay C. B advertises its endpoint; the signed
// address record gossips B → C → A; A then dials B *on demand* from the learned
// address and routes the packet there. No DNS, no flood, no A→B config.
//
// Topology (all open mode, each advertises its own ws:// endpoint):
//
//        A ──dials──▶ C ◀──dials── B
//   (knows only C)  (bootstrap)  (knows only C)
//
// Decisive signals on A: discovered_dials_total > 0 (it dialed a gossip-learned
// endpoint) AND the client on B receives the packet.
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodeCrypto from 'node:crypto';
import { WebSocket } from 'ws';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const NODE_DIR = path.resolve(__dirname, '../node');

const PORT_A = 19920;
const PORT_B = 19921;
const PORT_C = 19922;

function generateFederationKeyFile(filePath: string): string {
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const publicKeyHex = spki.subarray(spki.length - 32).toString('hex');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ publicKeyHex, privateKeyPkcs8Base64: pkcs8.toString('base64') }));
  return publicKeyHex;
}

function spawnRelay(port: number, dir: string, env: Record<string, string>): childProcess.ChildProcess {
  const distEntry = path.join(NODE_DIR, 'dist/index.js');
  const useCompiled = fs.existsSync(distEntry);
  return childProcess.spawn(
    useCompiled ? 'node' : 'npx',
    useCompiled ? [distEntry] : ['tsx', path.join(NODE_DIR, 'src/index.ts')],
    { cwd: NODE_DIR, env: { ...process.env, PORT: String(port), DB_PATH: path.join(dir, 'relay.db'), NODE_ENV: 'test', ...env }, stdio: 'pipe' },
  );
}

async function waitForHealth(port: number, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`relay :${port} did not start`);
}

async function scrapeMetric(port: number, name: string): Promise<number> {
  const body = await fetch(`http://127.0.0.1:${port}/metrics`).then((r) => r.text()).catch(() => '');
  const line = body.split('\n').find((l) => l.startsWith(`${name} `));
  return line ? Number(line.slice(name.length + 1)) : 0;
}

async function waitForMetric(port: number, name: string, atLeast: number, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await scrapeMetric(port, name) >= atLeast) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for ${label} (${name} >= ${atLeast} on :${port})`);
}

function buildPacket(destHashHex: string, payload: Uint8Array): Buffer {
  const header = Buffer.alloc(31);
  header.writeUInt8(1, 0);
  header.writeUInt8(0, 1);
  Buffer.from(destHashHex, 'hex').copy(header, 2);
  nodeCrypto.randomBytes(16).copy(header, 10);
  header.writeUInt8(3, 26);
  header.writeUInt32BE(payload.length, 27);
  return Buffer.concat([header, Buffer.from(payload)]);
}

function connectClient(port: number, destHashes: string[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', destHashes }));
      setTimeout(() => resolve(ws), 200);
    });
    ws.on('error', reject);
  });
}

describe('Federation gossip address overlay (ADR-010 stage-2)', () => {
  let relayA: childProcess.ChildProcess;
  let relayB: childProcess.ChildProcess;
  let relayC: childProcess.ChildProcess;
  let dirA: string; let dirB: string; let dirC: string;
  let pubB: string;

  beforeAll(async () => {
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-gx-a-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-gx-b-'));
    dirC = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-gx-c-'));
    const pubC = generateFederationKeyFile(path.join(dirC, 'fed-key.json'));
    generateFederationKeyFile(path.join(dirA, 'fed-key.json'));
    pubB = generateFederationKeyFile(path.join(dirB, 'fed-key.json'));

    // A and B each know ONLY the bootstrap C. C knows no one (open mode).
    fs.writeFileSync(path.join(dirA, 'fed-peers.json'), JSON.stringify({ peers: [{ pubkey: pubC, url: `ws://127.0.0.1:${PORT_C}` }] }));
    fs.writeFileSync(path.join(dirB, 'fed-peers.json'), JSON.stringify({ peers: [{ pubkey: pubC, url: `ws://127.0.0.1:${PORT_C}` }] }));
    fs.writeFileSync(path.join(dirC, 'fed-peers.json'), JSON.stringify({ peers: [] }));

    const env = (dir: string, port: number) => ({
      FEDERATION_MODE: 'open',
      FEDERATION_KEY_FILE: path.join(dir, 'fed-key.json'),
      FEDERATION_PEERS_FILE: path.join(dir, 'fed-peers.json'),
      FEDERATION_ADVERTISE_URL: `ws://127.0.0.1:${port}`,
    });
    relayC = spawnRelay(PORT_C, dirC, env(dirC, PORT_C));
    relayA = spawnRelay(PORT_A, dirA, env(dirA, PORT_A));
    relayB = spawnRelay(PORT_B, dirB, env(dirB, PORT_B));
    await Promise.all([waitForHealth(PORT_A), waitForHealth(PORT_B), waitForHealth(PORT_C)]);
  }, 40000);

  afterAll(() => {
    relayA?.kill('SIGTERM'); relayB?.kill('SIGTERM'); relayC?.kill('SIGTERM');
    for (const d of [dirA, dirB, dirC]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  it('A routes to B via a gossip-learned address + on-demand dial — no static A→B config', async () => {
    // A learns B's endpoint transitively through C: A's address book grows to
    // {A.self, C.self, B.self} = 3. (A is configured with only C.)
    await waitForMetric(PORT_A, 'meshwhisper_federation_addr_records_known', 3, 25000, 'A learns B via gossip');

    const dialsBefore = await scrapeMetric(PORT_A, 'meshwhisper_federation_discovered_dials_total');

    // Bob listens on B for destHash D.
    const destHash = nodeCrypto.randomBytes(8).toString('hex');
    const bob = await connectClient(PORT_B, [destHash]);
    const gotPacket = new Promise<Buffer>((resolve) => {
      bob.on('message', (raw: Buffer, isBinary: boolean) => { if (isBinary) resolve(raw); });
    });

    // Alice sends via A: a route hint naming B's pubkey, then the packet. A has
    // no client/push for D and no peer config for B — its ONLY way to reach B
    // is the gossip-learned address.
    const alice = await connectClient(PORT_A, []);
    alice.send(JSON.stringify({ type: 'route', destHash, homeRelay: pubB }));
    const packet = buildPacket(destHash, new Uint8Array([42, 7, 7]));
    alice.send(packet, { binary: true });

    const received = await Promise.race([
      gotPacket,
      new Promise<Buffer>((_, reject) => setTimeout(() => reject(new Error('packet never reached B via the gossip overlay')), 15000)),
    ]);

    // End-to-end payload integrity across the discovered link.
    expect(Buffer.compare(received, packet)).toBe(0);

    // Decisive: A performed an on-demand dial to a gossip-learned endpoint, and
    // routed directly (not by flood) to it.
    const dialsAfter = await scrapeMetric(PORT_A, 'meshwhisper_federation_discovered_dials_total');
    expect(dialsAfter).toBeGreaterThan(dialsBefore);
    expect(await scrapeMetric(PORT_A, 'meshwhisper_federation_routed_forwards_sent_total')).toBeGreaterThan(0);

    alice.close();
    bob.close();
  }, 40000);
});

// ============================================================
// ADR-010 stage-3 — NAT transit layer
//
// Relay B is NAT'd: it advertises NO direct endpoint, only that it is reachable
// `via` a public transit anchor T (which it holds a persistent outbound link
// to). A — which cannot dial B at all — routes a packet to B by sending it to T
// with "deliver to B"; T relays it down B's existing link. No direct A→B
// connection is ever possible.
//
//   A ──dials──▶ T ◀──dials── B        B.record = { via: [T] }  (no endpoint)
// ============================================================

describe('Federation NAT transit (ADR-010 stage-3)', () => {
  const PA = 19930, PB = 19931, PT = 19932;
  let relayA: childProcess.ChildProcess;
  let relayB: childProcess.ChildProcess;
  let relayT: childProcess.ChildProcess;
  let dA: string; let dB: string; let dT: string;
  let pubB: string;

  beforeAll(async () => {
    dA = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-nt-a-'));
    dB = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-nt-b-'));
    dT = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-nt-t-'));
    const pubT = generateFederationKeyFile(path.join(dT, 'fed-key.json'));
    generateFederationKeyFile(path.join(dA, 'fed-key.json'));
    pubB = generateFederationKeyFile(path.join(dB, 'fed-key.json'));

    // A and B each dial only the transit relay T. T knows no one (open).
    fs.writeFileSync(path.join(dA, 'fed-peers.json'), JSON.stringify({ peers: [{ pubkey: pubT, url: `ws://127.0.0.1:${PT}` }] }));
    fs.writeFileSync(path.join(dB, 'fed-peers.json'), JSON.stringify({ peers: [{ pubkey: pubT, url: `ws://127.0.0.1:${PT}` }] }));
    fs.writeFileSync(path.join(dT, 'fed-peers.json'), JSON.stringify({ peers: [] }));

    const base = (dir: string) => ({
      FEDERATION_MODE: 'open',
      FEDERATION_KEY_FILE: path.join(dir, 'fed-key.json'),
      FEDERATION_PEERS_FILE: path.join(dir, 'fed-peers.json'),
    });
    // T and A are public (advertise an endpoint). B is NAT'd: NO advertise URL,
    // so its record carries only `via: [T]`.
    relayT = spawnRelay(PT, dT, { ...base(dT), FEDERATION_ADVERTISE_URL: `ws://127.0.0.1:${PT}` });
    relayA = spawnRelay(PA, dA, { ...base(dA), FEDERATION_ADVERTISE_URL: `ws://127.0.0.1:${PA}` });
    relayB = spawnRelay(PB, dB, { ...base(dB) }); // NAT'd — no advertised endpoint
    await Promise.all([waitForHealth(PA), waitForHealth(PB), waitForHealth(PT)]);
  }, 40000);

  afterAll(() => {
    relayA?.kill('SIGTERM'); relayB?.kill('SIGTERM'); relayT?.kill('SIGTERM');
    for (const d of [dA, dB, dT]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  it('A reaches a NAT-bound B by transit through B\'s anchor — never a direct A→B link', async () => {
    // A learns B's (endpoint-less, via:[T]) record through the gossip overlay.
    await waitForMetric(PA, 'meshwhisper_federation_addr_records_known', 3, 25000, 'A learns NAT-bound B');

    const transitBefore = await scrapeMetric(PA, 'meshwhisper_federation_transit_forwards_sent_total');

    const destHash = nodeCrypto.randomBytes(8).toString('hex');
    const bob = await connectClient(PB, [destHash]);
    const gotPacket = new Promise<Buffer>((resolve) => {
      bob.on('message', (raw: Buffer, isBinary: boolean) => { if (isBinary) resolve(raw); });
    });

    const alice = await connectClient(PA, []);
    alice.send(JSON.stringify({ type: 'route', destHash, homeRelay: pubB }));
    const packet = buildPacket(destHash, new Uint8Array([3, 1, 4, 1, 5]));
    alice.send(packet, { binary: true });

    const received = await Promise.race([
      gotPacket,
      new Promise<Buffer>((_, reject) => setTimeout(() => reject(new Error('packet never reached the NAT-bound relay via transit')), 15000)),
    ]);
    expect(Buffer.compare(received, packet)).toBe(0);

    // Decisive: A routed via transit (not a direct dial — B has no endpoint to
    // dial), and the transit relay T re-dispatched the routed frame.
    expect(await scrapeMetric(PA, 'meshwhisper_federation_transit_forwards_sent_total')).toBeGreaterThan(transitBefore);
    expect(await scrapeMetric(PA, 'meshwhisper_federation_discovered_dials_total')).toBe(0);
    expect(await scrapeMetric(PT, 'meshwhisper_federation_transit_frames_received_total')).toBeGreaterThan(0);

    alice.close();
    bob.close();
  }, 40000);
});
