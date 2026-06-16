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

// Start a relay and wait until it's healthy before returning. Spawning a dial
// TARGET before its dialers ensures the first federation dial succeeds, avoiding
// reconnect-backoff cycles (1s,2s,4s,…) that otherwise compound gossip-
// convergence latency into flaky timeouts under load.
async function startRelay(port: number, dir: string, env: Record<string, string>): Promise<childProcess.ChildProcess> {
  const proc = spawnRelay(port, dir, env);
  await waitForHealth(port);
  return proc;
}

// Kill relays and AWAIT their exit, so a file's processes are fully gone before
// the next file/test starts — otherwise dying relays accumulate across the
// serial suite and starve federation handshakes into flaky timeouts.
async function stopRelays(procs: childProcess.ChildProcess[]): Promise<void> {
  await Promise.all(procs.map((p) => new Promise<void>((resolve) => {
    if (!p || p.exitCode !== null || p.signalCode !== null) return resolve();
    const done = (): void => resolve();
    p.once('exit', done);
    try { p.kill('SIGKILL'); } catch { /* already dead */ }
    setTimeout(done, 3000); // safety net
  })));
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
      FEDERATION_GOSSIP_INTERVAL_MS: '2000',
      FEDERATION_ADVERTISE_URL: `ws://127.0.0.1:${port}`,
    });
    // Start the bootstrap C first so A and B dial a relay that's already up.
    relayC = await startRelay(PORT_C, dirC, env(dirC, PORT_C));
    relayA = await startRelay(PORT_A, dirA, env(dirA, PORT_A));
    relayB = await startRelay(PORT_B, dirB, env(dirB, PORT_B));
  }, 60000);

  afterAll(async () => {
    await stopRelays([relayA, relayB, relayC]);
    for (const d of [dirA, dirB, dirC]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  it('A routes to B via a gossip-learned address + on-demand dial — no static A→B config', async () => {
    // A learns B's endpoint transitively through C: A's address book grows to
    // {A.self, C.self, B.self} = 3. (A is configured with only C.)
    await waitForMetric(PORT_A, 'meshwhisper_federation_addr_records_known', 3, 40000, 'A learns B via gossip');

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
  }, 60000);
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
    FEDERATION_GOSSIP_INTERVAL_MS: '2000',
    });
    // T and A are public (advertise an endpoint). B is NAT'd: NO advertise URL,
    // so its record carries only `via: [T]`.
    // Start the anchor T first so A and B dial a relay that's already up.
    relayT = await startRelay(PT, dT, { ...base(dT), FEDERATION_ADVERTISE_URL: `ws://127.0.0.1:${PT}` });
    relayA = await startRelay(PA, dA, { ...base(dA), FEDERATION_ADVERTISE_URL: `ws://127.0.0.1:${PA}` });
    relayB = await startRelay(PB, dB, { ...base(dB) }); // NAT'd — no advertised endpoint
  }, 60000);

  afterAll(async () => {
    await stopRelays([relayA, relayB, relayT]);
    for (const d of [dA, dB, dT]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  it('A reaches a NAT-bound B by transit through B\'s anchor — never a direct A→B link', async () => {
    // A learns B's (endpoint-less, via:[T]) record through the gossip overlay.
    await waitForMetric(PA, 'meshwhisper_federation_addr_records_known', 3, 40000, 'A learns NAT-bound B');

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
  }, 60000);
});

// ============================================================
// ADR-010 stage-3+ — onion-routed transit (transit-hop privacy)
//
// Same NAT topology as above (A → T ← B, B NAT'd via:[T]), but A has onion
// transit ON. The transit relay T now receives an OPAQUE onion: it peels only
// its own layer, learns "deliver to B", and forwards the still-sealed inner —
// it never sees the packet or its destHash. Only B can open the inner layer.
//
// Decisive: A.onion_forwards_sent > 0 and A.transit_forwards_sent == 0 (it used
// onion, not the cleartext routed frame); T.onion_frames_received > 0 while T's
// delivered/stored counters stay 0 (it never held a deliverable packet); B
// delivers the exact bytes.
// ============================================================

describe('Federation onion transit (ADR-010 stage-3+)', () => {
  const PA = 19940, PB = 19941, PT = 19942;
  let relayA: childProcess.ChildProcess;
  let relayB: childProcess.ChildProcess;
  let relayT: childProcess.ChildProcess;
  let dA: string; let dB: string; let dT: string;
  let pubB: string;

  beforeAll(async () => {
    dA = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-on-a-'));
    dB = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-on-b-'));
    dT = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-on-t-'));
    const pubT = generateFederationKeyFile(path.join(dT, 'fed-key.json'));
    generateFederationKeyFile(path.join(dA, 'fed-key.json'));
    pubB = generateFederationKeyFile(path.join(dB, 'fed-key.json'));

    fs.writeFileSync(path.join(dA, 'fed-peers.json'), JSON.stringify({ peers: [{ pubkey: pubT, url: `ws://127.0.0.1:${PT}` }] }));
    fs.writeFileSync(path.join(dB, 'fed-peers.json'), JSON.stringify({ peers: [{ pubkey: pubT, url: `ws://127.0.0.1:${PT}` }] }));
    fs.writeFileSync(path.join(dT, 'fed-peers.json'), JSON.stringify({ peers: [] }));

    const base = (dir: string) => ({
      FEDERATION_MODE: 'open',
      FEDERATION_KEY_FILE: path.join(dir, 'fed-key.json'),
      FEDERATION_PEERS_FILE: path.join(dir, 'fed-peers.json'),
    FEDERATION_GOSSIP_INTERVAL_MS: '2000',
    });
    // Start the anchor T first so A and B dial a relay that's already up.
    relayT = await startRelay(PT, dT, { ...base(dT), FEDERATION_ADVERTISE_URL: `ws://127.0.0.1:${PT}` });
    // A originates onions (FEDERATION_ONION_TRANSIT=1). B is NAT'd — no endpoint.
    relayA = await startRelay(PA, dA, { ...base(dA), FEDERATION_ADVERTISE_URL: `ws://127.0.0.1:${PA}`, FEDERATION_ONION_TRANSIT: '1' });
    relayB = await startRelay(PB, dB, { ...base(dB) });
  }, 60000);

  afterAll(async () => {
    await stopRelays([relayA, relayB, relayT]);
    for (const d of [dA, dB, dT]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  it('routes to a NAT-bound B through an ONION so the transit relay never sees the packet', async () => {
    await waitForMetric(PA, 'meshwhisper_federation_addr_records_known', 3, 40000, 'A learns NAT-bound B');

    const destHash = nodeCrypto.randomBytes(8).toString('hex');
    const bob = await connectClient(PB, [destHash]);
    const gotPacket = new Promise<Buffer>((resolve) => {
      bob.on('message', (raw: Buffer, isBinary: boolean) => { if (isBinary) resolve(raw); });
    });

    const alice = await connectClient(PA, []);
    alice.send(JSON.stringify({ type: 'route', destHash, homeRelay: pubB }));
    const packet = buildPacket(destHash, new Uint8Array([2, 7, 1, 8, 2, 8]));
    alice.send(packet, { binary: true });

    const received = await Promise.race([
      gotPacket,
      new Promise<Buffer>((_, reject) => setTimeout(() => reject(new Error('packet never reached B via the onion')), 15000)),
    ]);
    expect(Buffer.compare(received, packet)).toBe(0);

    // A originated an onion (not a cleartext routed frame).
    expect(await scrapeMetric(PA, 'meshwhisper_federation_onion_forwards_sent_total')).toBeGreaterThan(0);
    expect(await scrapeMetric(PA, 'meshwhisper_federation_transit_forwards_sent_total')).toBe(0);

    // The transit relay peeled + forwarded an opaque onion, but NEVER held a
    // deliverable packet — it never saw the destHash.
    expect(await scrapeMetric(PT, 'meshwhisper_federation_onion_frames_received_total')).toBeGreaterThan(0);
    expect(await scrapeMetric(PT, 'meshwhisper_federation_delivered_locally_total')).toBe(0);
    expect(await scrapeMetric(PT, 'meshwhisper_federation_stored_locally_total')).toBe(0);

    // Only B could open the innermost layer and deliver.
    expect(await scrapeMetric(PB, 'meshwhisper_federation_onion_delivered_total')).toBeGreaterThan(0);

    alice.close();
    bob.close();
  }, 60000);
});

// ============================================================
// ADR-010 stage-3++ — onion PATH SELECTION (hide the destination from intermediaries)
//
// A multi-hop onion path is selected automatically from the gossip topology so a
// NON-ADJACENT intermediate never learns the destination relay. Topology:
//
//   A ──dials──▶ M ──dials──▶ T ◀──dials── B      B NAT'd, via:[T]
//    \________________dials_________________↑
//
// A is connected to the anchor T directly too — so routing through M is NOT a
// reachability need; path selection deliberately inserts M as a privacy hop. M
// peels its layer, learns only "next = T", forwards an opaque inner, and never
// sees B or the packet. Only B opens the innermost layer. (The A→T link also
// lets A learn B's record in a single gossip hop, keeping the test robust.)
//
// Decisive: M (intermediate) peels+forwards an onion but NEVER delivers/stores
// (it isn't the destination); T (anchor) likewise; only B delivers.
// ============================================================

describe('Federation onion path selection (ADR-010 stage-3++)', () => {
  const PA = 19950, PM = 19951, PT = 19952, PB = 19953;
  let rA: childProcess.ChildProcess; let rM: childProcess.ChildProcess;
  let rT: childProcess.ChildProcess; let rB: childProcess.ChildProcess;
  let dA: string; let dM: string; let dT: string; let dB: string;
  let pubB: string;

  beforeAll(async () => {
    dA = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-ps-a-'));
    dM = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-ps-m-'));
    dT = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-ps-t-'));
    dB = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-ps-b-'));
    generateFederationKeyFile(path.join(dA, 'fed-key.json'));
    const pubM = generateFederationKeyFile(path.join(dM, 'fed-key.json'));
    const pubT = generateFederationKeyFile(path.join(dT, 'fed-key.json'));
    pubB = generateFederationKeyFile(path.join(dB, 'fed-key.json'));

    // Links: A→M, A→T, M→T, B→T. A↔T keeps gossip convergence to one hop.
    fs.writeFileSync(path.join(dA, 'fed-peers.json'), JSON.stringify({ peers: [{ pubkey: pubM, url: `ws://127.0.0.1:${PM}` }, { pubkey: pubT, url: `ws://127.0.0.1:${PT}` }] }));
    fs.writeFileSync(path.join(dM, 'fed-peers.json'), JSON.stringify({ peers: [{ pubkey: pubT, url: `ws://127.0.0.1:${PT}` }] }));
    fs.writeFileSync(path.join(dT, 'fed-peers.json'), JSON.stringify({ peers: [] }));
    fs.writeFileSync(path.join(dB, 'fed-peers.json'), JSON.stringify({ peers: [{ pubkey: pubT, url: `ws://127.0.0.1:${PT}` }] }));

    const base = (dir: string) => ({
      FEDERATION_MODE: 'open',
      FEDERATION_KEY_FILE: path.join(dir, 'fed-key.json'),
      FEDERATION_PEERS_FILE: path.join(dir, 'fed-peers.json'),
    FEDERATION_GOSSIP_INTERVAL_MS: '2000',
    });
    // Start dial targets before dialers: T (dialed by all), then M (dialed by
    // A), then A and B. Every first dial then hits a relay that's already up.
    rT = await startRelay(PT, dT, { ...base(dT), FEDERATION_ADVERTISE_URL: `ws://127.0.0.1:${PT}` });
    rM = await startRelay(PM, dM, { ...base(dM), FEDERATION_ADVERTISE_URL: `ws://127.0.0.1:${PM}` });
    rB = await startRelay(PB, dB, { ...base(dB) }); // NAT'd
    // A originates onions, inserting exactly one intermediate privacy hop.
    rA = await startRelay(PA, dA, { ...base(dA), FEDERATION_ADVERTISE_URL: `ws://127.0.0.1:${PA}`, FEDERATION_ONION_TRANSIT: '1', FEDERATION_ONION_HOPS: '1' });
  }, 60000);

  afterAll(async () => {
    await stopRelays([rA, rM, rT, rB]);
    for (const d of [dA, dM, dT, dB]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  it('selects a multi-hop onion path so the intermediate never sees the destination', async () => {
    // A must learn all four relays (A, M, T, B) before it can build the path.
    await waitForMetric(PA, 'meshwhisper_federation_addr_records_known', 4, 45000, 'A learns the full topology');

    const destHash = nodeCrypto.randomBytes(8).toString('hex');
    const bob = await connectClient(PB, [destHash]);
    const gotPacket = new Promise<Buffer>((resolve) => {
      bob.on('message', (raw: Buffer, isBinary: boolean) => { if (isBinary) resolve(raw); });
    });

    const alice = await connectClient(PA, []);
    alice.send(JSON.stringify({ type: 'route', destHash, homeRelay: pubB }));
    const packet = buildPacket(destHash, new Uint8Array([1, 6, 1, 8, 0, 3, 3, 9]));
    alice.send(packet, { binary: true });

    const received = await Promise.race([
      gotPacket,
      new Promise<Buffer>((_, reject) => setTimeout(() => reject(new Error('packet never reached B via the selected onion path')), 20000)),
    ]);
    expect(Buffer.compare(received, packet)).toBe(0);

    expect(await scrapeMetric(PA, 'meshwhisper_federation_onion_forwards_sent_total')).toBeGreaterThan(0);

    // The intermediate M was on the path (peeled + forwarded an onion) but is
    // NOT the destination — it never delivered or stored a packet.
    expect(await scrapeMetric(PM, 'meshwhisper_federation_onion_frames_received_total')).toBeGreaterThan(0);
    expect(await scrapeMetric(PM, 'meshwhisper_federation_delivered_locally_total')).toBe(0);
    expect(await scrapeMetric(PM, 'meshwhisper_federation_stored_locally_total')).toBe(0);

    // The anchor T also only relayed.
    expect(await scrapeMetric(PT, 'meshwhisper_federation_onion_frames_received_total')).toBeGreaterThan(0);
    expect(await scrapeMetric(PT, 'meshwhisper_federation_delivered_locally_total')).toBe(0);

    // Only B opened the innermost layer and delivered.
    expect(await scrapeMetric(PB, 'meshwhisper_federation_onion_delivered_total')).toBeGreaterThan(0);

    alice.close();
    bob.close();
  }, 60000);
});

// ============================================================
// ADR-010 stage-3+++ — both-ends-NAT rendezvous (bridge routing)
//
// The hard residual case: the SENDER's relay A has restricted egress (it can
// hold only its one configured uplink — FEDERATION_TRANSIT_ONLY — and cannot
// dial arbitrary relays), and the RECIPIENT's home relay B is NAT'd. A cannot
// dial B's anchor T_B directly. Delivery must ride existing federation links,
// bridged through a common backbone relay R that both A's side and B's anchor
// connect to — discovered by BFS over the gossip topology.
//
//   A ──dials──▶ R ◀──dials── T_B ◀──dials── B     A: no-dial; B: NAT'd
//
// Path found: [R, T_B, B]. A hands the onion to its uplink R (established link,
// no dial); R bridges to T_B; T_B delivers to B. A never opens a new connection.
// ============================================================

describe('Federation both-ends-NAT rendezvous (ADR-010 stage-3+++)', () => {
  const PR = 19960, PTB = 19961, PB = 19962, PA = 19963;
  let rR: childProcess.ChildProcess; let rTB: childProcess.ChildProcess;
  let rB: childProcess.ChildProcess; let rA: childProcess.ChildProcess;
  let dR: string; let dTB: string; let dB: string; let dA: string;
  let pubB: string;

  beforeAll(async () => {
    dR = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-rv-r-'));
    dTB = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-rv-tb-'));
    dB = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-rv-b-'));
    dA = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-rv-a-'));
    const pubR = generateFederationKeyFile(path.join(dR, 'fed-key.json'));
    const pubTB = generateFederationKeyFile(path.join(dTB, 'fed-key.json'));
    pubB = generateFederationKeyFile(path.join(dB, 'fed-key.json'));
    generateFederationKeyFile(path.join(dA, 'fed-key.json'));

    // R: backbone (no peers). T_B and A both dial R. B dials T_B.
    fs.writeFileSync(path.join(dR, 'fed-peers.json'), JSON.stringify({ peers: [] }));
    fs.writeFileSync(path.join(dTB, 'fed-peers.json'), JSON.stringify({ peers: [{ pubkey: pubR, url: `ws://127.0.0.1:${PR}` }] }));
    fs.writeFileSync(path.join(dB, 'fed-peers.json'), JSON.stringify({ peers: [{ pubkey: pubTB, url: `ws://127.0.0.1:${PTB}` }] }));
    fs.writeFileSync(path.join(dA, 'fed-peers.json'), JSON.stringify({ peers: [{ pubkey: pubR, url: `ws://127.0.0.1:${PR}` }] }));

    const base = (dir: string) => ({
      FEDERATION_MODE: 'open',
      FEDERATION_KEY_FILE: path.join(dir, 'fed-key.json'),
      FEDERATION_PEERS_FILE: path.join(dir, 'fed-peers.json'),
      FEDERATION_GOSSIP_INTERVAL_MS: '2000',
    });
    // Targets before dialers: R, then T_B (dials R), then B (dials T_B), then A.
    rR = await startRelay(PR, dR, { ...base(dR), FEDERATION_ADVERTISE_URL: `ws://127.0.0.1:${PR}` });
    rTB = await startRelay(PTB, dTB, { ...base(dTB), FEDERATION_ADVERTISE_URL: `ws://127.0.0.1:${PTB}` });
    rB = await startRelay(PB, dB, { ...base(dB) }); // NAT'd recipient — no endpoint
    // A: restricted egress (no-dial) + onion transit. Routes only via its uplink R.
    rA = await startRelay(PA, dA, { ...base(dA), FEDERATION_ONION_TRANSIT: '1', FEDERATION_TRANSIT_ONLY: '1' });
  }, 60000);

  afterAll(async () => {
    await stopRelays([rR, rTB, rB, rA]);
    for (const d of [dR, dTB, dB, dA]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  it('bridges a no-dial sender to a NAT-bound recipient through a common backbone relay', async () => {
    // A must learn R, T_B and B (its own record + 3) before it can bridge.
    await waitForMetric(PA, 'meshwhisper_federation_addr_records_known', 4, 45000, 'A learns the topology');

    const destHash = nodeCrypto.randomBytes(8).toString('hex');
    const bob = await connectClient(PB, [destHash]);
    const gotPacket = new Promise<Buffer>((resolve) => {
      bob.on('message', (raw: Buffer, isBinary: boolean) => { if (isBinary) resolve(raw); });
    });

    const alice = await connectClient(PA, []);
    alice.send(JSON.stringify({ type: 'route', destHash, homeRelay: pubB }));
    const packet = buildPacket(destHash, new Uint8Array([4, 2, 4, 2, 4, 2]));
    alice.send(packet, { binary: true });

    const received = await Promise.race([
      gotPacket,
      new Promise<Buffer>((_, reject) => setTimeout(() => reject(new Error('packet never bridged to the NAT-bound recipient')), 20000)),
    ]);
    expect(Buffer.compare(received, packet)).toBe(0);

    // A originated the onion using ONLY its established uplink — it never dialed.
    expect(await scrapeMetric(PA, 'meshwhisper_federation_onion_forwards_sent_total')).toBeGreaterThan(0);
    expect(await scrapeMetric(PA, 'meshwhisper_federation_discovered_dials_total')).toBe(0);

    // The backbone relay R bridged (peeled + forwarded an opaque onion), as did
    // the anchor T_B — neither delivered/stored. Only B delivered.
    expect(await scrapeMetric(PR, 'meshwhisper_federation_onion_frames_received_total')).toBeGreaterThan(0);
    expect(await scrapeMetric(PR, 'meshwhisper_federation_delivered_locally_total')).toBe(0);
    expect(await scrapeMetric(PTB, 'meshwhisper_federation_onion_frames_received_total')).toBeGreaterThan(0);
    expect(await scrapeMetric(PB, 'meshwhisper_federation_onion_delivered_total')).toBeGreaterThan(0);

    alice.close();
    bob.close();
  }, 60000);
});
