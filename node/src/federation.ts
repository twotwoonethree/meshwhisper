// ============================================================
// MeshWhisper Node — Federation (node-to-node packet forwarding)
//
// Implements docs/federation.md v1:
//   - Pairwise peering between explicitly allow-listed nodes
//   - Mutual Ed25519 handshake over a WebSocket with the
//     `meshwhisper-federation.v1` subprotocol
//   - Length-prefixed binary frames: PacketForward + Heartbeat
//   - Loop prevention via a packet-id LRU
//   - TTL (hop-count) exhaustion
//   - Reconnect with exponential backoff for outbound peers
//
// The module is deliberately self-contained: index.ts hands it an
// allow-list + keypair + a single `classifyLocal` callback that
// answers "can this packet be delivered or stored locally?", and the
// module handles everything else. The relay's existing client-relay
// path is untouched.
// ============================================================

import { WebSocketServer, WebSocket, type RawData } from 'ws';
import * as nodeCrypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IncomingMessage } from 'node:http';

export const FEDERATION_SUBPROTOCOL = 'meshwhisper-federation.v1';

// ---- Wire constants (docs/federation.md "Forwarding wire format") ----

const WIRE_VERSION = 0x01;
const FRAME_PACKET_FORWARD = 0x01;
const FRAME_HEARTBEAT = 0x02;

const MAX_HOPS = parseInt(process.env.FEDERATION_MAX_HOPS ?? '3', 10);
const MAX_FRAME_BODY = 8192;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 90_000;
const PACKET_ID_CACHE_SIZE = 1024;
const PACKET_ID_TTL_MS = 60_000;
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000];

// DER wrappers so node:crypto can ingest raw Ed25519 key bytes.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// ---- Key management ----

export interface FederationKey {
  publicKeyHex: string;
  privateKey: nodeCrypto.KeyObject;
}

/**
 * Load the node's federation keypair from `keyPath`, generating and
 * persisting a fresh one if the file doesn't exist. Stored shape:
 * { publicKeyHex, privateKeyPkcs8Base64 }.
 */
export function loadOrCreateFederationKey(keyPath: string): FederationKey {
  if (fs.existsSync(keyPath)) {
    const raw = JSON.parse(fs.readFileSync(keyPath, 'utf8')) as {
      publicKeyHex: string;
      privateKeyPkcs8Base64: string;
    };
    const privateKey = nodeCrypto.createPrivateKey({
      key: Buffer.from(raw.privateKeyPkcs8Base64, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    return { publicKeyHex: raw.publicKeyHex, privateKey };
  }

  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const publicKeyHex = spki.subarray(spki.length - 32).toString('hex');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;

  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, JSON.stringify({
    publicKeyHex,
    privateKeyPkcs8Base64: pkcs8.toString('base64'),
  }, null, 2), { mode: 0o600 });

  return { publicKeyHex, privateKey };
}

// ---- Peers config ----

export interface PeerConfig {
  pubkey: string;
  /** Present = this node initiates outbound connections to the peer. */
  url?: string;
}

/** Load { peers: [...] } from `peersPath`. Missing file = no peers = federation dormant. */
export function loadPeersConfig(peersPath: string): PeerConfig[] {
  if (!fs.existsSync(peersPath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(peersPath, 'utf8')) as { peers?: PeerConfig[] };
    return (raw.peers ?? []).filter(
      (p): p is PeerConfig => typeof p?.pubkey === 'string' && /^[0-9a-f]{64}$/.test(p.pubkey),
    );
  } catch {
    console.error(`[federation] malformed peers file at ${peersPath} — federation dormant`);
    return [];
  }
}

// ---- Canonical handshake message ----

export function buildHandshakeCanonical(
  initiatorPubkeyHex: string,
  responderPubkeyHex: string,
  initiatorNonceHex: string,
  responderNonceHex: string,
): Buffer {
  return Buffer.from(
    [
      FEDERATION_SUBPROTOCOL,
      initiatorPubkeyHex,
      responderPubkeyHex,
      initiatorNonceHex,
      responderNonceHex,
    ].join('\n'),
    'utf8',
  );
}

function verifyWithRawPubkey(pubkeyHex: string, message: Buffer, signature: Buffer): boolean {
  if (signature.length !== 64) return false;
  let keyObj: nodeCrypto.KeyObject;
  try {
    keyObj = nodeCrypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pubkeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
  } catch { return false; }
  try {
    return nodeCrypto.verify(null, message, keyObj, signature);
  } catch { return false; }
}

// ---- Hello frame codec (53 bytes) ----

interface Hello {
  version: number;
  pubkeyHex: string;
  nonceHex: string;
  capabilities: number;
}

function encodeHello(h: Hello): Buffer {
  const buf = Buffer.alloc(1 + 32 + 16 + 4);
  buf.writeUInt8(h.version, 0);
  Buffer.from(h.pubkeyHex, 'hex').copy(buf, 1);
  Buffer.from(h.nonceHex, 'hex').copy(buf, 33);
  buf.writeUInt32BE(h.capabilities, 49);
  return buf;
}

function decodeHello(buf: Buffer): Hello | null {
  if (buf.length !== 53) return null;
  return {
    version: buf.readUInt8(0),
    pubkeyHex: buf.subarray(1, 33).toString('hex'),
    nonceHex: buf.subarray(33, 49).toString('hex'),
    capabilities: buf.readUInt32BE(49),
  };
}

// ---- Data frame codec ----

function encodeFrame(frameType: number, body: Buffer): Buffer {
  const out = Buffer.alloc(1 + 4 + body.length);
  out.writeUInt8(frameType, 0);
  out.writeUInt32BE(body.length, 1);
  body.copy(out, 5);
  return out;
}

interface DecodedFrame {
  frameType: number;
  body: Buffer;
}

function decodeFrame(buf: Buffer): DecodedFrame | null {
  if (buf.length < 5) return null;
  const frameType = buf.readUInt8(0);
  const length = buf.readUInt32BE(1);
  if (length > MAX_FRAME_BODY) return null;
  if (buf.length !== 5 + length) return null;
  return { frameType, body: buf.subarray(5) };
}

// ---- Packet-id LRU (loop prevention) ----

class PacketIdCache {
  private readonly entries = new Map<string, number>(); // id → insertedAt

  /** Returns true if the id was already present (within TTL). Inserts otherwise. */
  checkAndInsert(idHex: string): boolean {
    const now = Date.now();
    const existing = this.entries.get(idHex);
    if (existing !== undefined && now - existing < PACKET_ID_TTL_MS) {
      return true;
    }
    // Refresh / insert. Evict oldest beyond capacity (Map preserves insertion order).
    this.entries.delete(idHex);
    this.entries.set(idHex, now);
    while (this.entries.size > PACKET_ID_CACHE_SIZE) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
    return false;
  }
}

// ---- Peer connection state ----

type LocalOutcome = 'delivered' | 'stored' | 'unknown';

interface PeerState {
  config: PeerConfig;
  ws: WebSocket | null;
  established: boolean;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  lastFrameAt: number;
}

export interface FederationStats {
  peersConfigured: number;
  peersConnected: number;
  forwardsSentTotal: number;
  forwardsReceivedTotal: number;
  deliveredLocallyTotal: number;
  storedLocallyTotal: number;
  forwardedOnwardTotal: number;
  dropsDuplicateTotal: number;
  dropsTtlTotal: number;
  handshakeFailuresTotal: number;
}

// ---- Manager ----

export class FederationManager {
  private readonly key: FederationKey;
  private readonly allowedPubkeys: Set<string>;
  private readonly peers: Map<string, PeerState> = new Map(); // pubkeyHex → state
  private readonly cache = new PacketIdCache();
  private readonly classifyLocal: (packet: Uint8Array) => LocalOutcome;
  private readonly wss: WebSocketServer;
  private stopped = false;

  readonly stats: FederationStats = {
    peersConfigured: 0,
    peersConnected: 0,
    forwardsSentTotal: 0,
    forwardsReceivedTotal: 0,
    deliveredLocallyTotal: 0,
    storedLocallyTotal: 0,
    forwardedOnwardTotal: 0,
    dropsDuplicateTotal: 0,
    dropsTtlTotal: 0,
    handshakeFailuresTotal: 0,
  };

  constructor(opts: {
    key: FederationKey;
    peers: PeerConfig[];
    classifyLocal: (packet: Uint8Array) => LocalOutcome;
  }) {
    this.key = opts.key;
    this.classifyLocal = opts.classifyLocal;
    this.allowedPubkeys = new Set(opts.peers.map((p) => p.pubkey));
    for (const p of opts.peers) {
      this.peers.set(p.pubkey, {
        config: p,
        ws: null,
        established: false,
        reconnectAttempt: 0,
        reconnectTimer: null,
        heartbeatTimer: null,
        lastFrameAt: 0,
      });
    }
    this.stats.peersConfigured = opts.peers.length;
    this.wss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) =>
        protocols.has(FEDERATION_SUBPROTOCOL) ? FEDERATION_SUBPROTOCOL : false,
    });
  }

  /** Dial every peer that has a url. Inbound peers connect to us instead. */
  start(): void {
    for (const state of this.peers.values()) {
      if (state.config.url) this.dial(state);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const state of this.peers.values()) {
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
      state.ws?.close();
    }
  }

  connectedPeerCount(): number {
    let n = 0;
    for (const s of this.peers.values()) if (s.established) n++;
    return n;
  }

  /** Route an HTTP upgrade with the federation subprotocol into the manager. */
  handleUpgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.runResponderHandshake(ws).catch(() => {
        this.stats.handshakeFailuresTotal++;
        try { ws.close(); } catch { /* already closed */ }
      });
    });
  }

  /**
   * Forward a locally-received packet (from one of our own clients)
   * whose destHash we have no local knowledge of. Mints a fresh
   * packetId, forwardCount = 0, fans out to every established peer.
   */
  forwardFromLocal(packet: Uint8Array): void {
    if (packet.byteLength > MAX_FRAME_BODY - 17) return; // can't fit in a frame body
    const packetId = nodeCrypto.randomBytes(16);
    // Insert into our own cache so a loop back to us is dropped.
    this.cache.checkAndInsert(packetId.toString('hex'));
    this.fanOut(packetId, 0, Buffer.from(packet), null);
  }

  // ---- internals ----

  private fanOut(packetId: Buffer, forwardCount: number, packet: Buffer, excludePubkey: string | null): void {
    const body = Buffer.alloc(17 + packet.length);
    packetId.copy(body, 0);
    body.writeUInt8(forwardCount, 16);
    packet.copy(body, 17);
    const frame = encodeFrame(FRAME_PACKET_FORWARD, body);
    for (const [pubkey, state] of this.peers) {
      if (pubkey === excludePubkey) continue;
      if (!state.established || !state.ws || state.ws.readyState !== WebSocket.OPEN) continue;
      try {
        state.ws.send(frame, { binary: true });
        this.stats.forwardsSentTotal++;
      } catch { /* dead socket — heartbeat will reap */ }
    }
  }

  private dial(state: PeerState): void {
    if (this.stopped || !state.config.url) return;
    const ws = new WebSocket(state.config.url, FEDERATION_SUBPROTOCOL);
    state.ws = ws;
    ws.on('open', () => {
      this.runInitiatorHandshake(ws, state).catch(() => {
        this.stats.handshakeFailuresTotal++;
        try { ws.close(); } catch { /* already closed */ }
      });
    });
    ws.on('error', () => { /* close handler schedules reconnect */ });
    ws.on('close', () => {
      this.teardownPeer(state);
      this.scheduleReconnect(state);
    });
  }

  private scheduleReconnect(state: PeerState): void {
    if (this.stopped || !state.config.url || state.reconnectTimer) return;
    const delay = RECONNECT_BACKOFF_MS[Math.min(state.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
    state.reconnectAttempt++;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      this.dial(state);
    }, delay);
  }

  private teardownPeer(state: PeerState): void {
    state.established = false;
    state.ws = null;
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
    this.stats.peersConnected = this.connectedPeerCount();
  }

  /** One-shot wait for the next message on a socket (handshake phases). */
  private nextMessage(ws: WebSocket, timeoutMs = 10_000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('handshake timeout'));
      }, timeoutMs);
      const onMessage = (raw: RawData): void => {
        cleanup();
        resolve(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer));
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error('closed during handshake'));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        ws.off('message', onMessage);
        ws.off('close', onClose);
      };
      ws.once('message', onMessage);
      ws.once('close', onClose);
    });
  }

  private async runInitiatorHandshake(ws: WebSocket, state: PeerState): Promise<void> {
    const myNonce = nodeCrypto.randomBytes(16);
    ws.send(encodeHello({
      version: WIRE_VERSION,
      pubkeyHex: this.key.publicKeyHex,
      nonceHex: myNonce.toString('hex'),
      capabilities: 0,
    }), { binary: true });

    const serverHello = decodeHello(await this.nextMessage(ws));
    if (!serverHello) throw new Error('malformed ServerHello');
    if (serverHello.version !== WIRE_VERSION) throw new Error('peer rejected handshake');
    if (serverHello.pubkeyHex !== state.config.pubkey) throw new Error('peer pubkey mismatch');

    const canonical = buildHandshakeCanonical(
      this.key.publicKeyHex, serverHello.pubkeyHex,
      myNonce.toString('hex'), serverHello.nonceHex,
    );
    ws.send(nodeCrypto.sign(null, canonical, this.key.privateKey), { binary: true });

    const serverSig = await this.nextMessage(ws);
    if (!verifyWithRawPubkey(serverHello.pubkeyHex, canonical, serverSig)) {
      throw new Error('peer signature invalid');
    }

    state.reconnectAttempt = 0;
    this.establishPeer(state, ws);
  }

  private async runResponderHandshake(ws: WebSocket): Promise<void> {
    const clientHello = decodeHello(await this.nextMessage(ws));
    if (!clientHello) throw new Error('malformed ClientHello');

    const reject = (): never => {
      ws.send(encodeHello({
        version: 0x00,
        pubkeyHex: this.key.publicKeyHex,
        nonceHex: '0'.repeat(32),
        capabilities: 0,
      }), { binary: true });
      throw new Error('handshake rejected');
    };

    if (clientHello.version !== WIRE_VERSION) reject();
    if (!this.allowedPubkeys.has(clientHello.pubkeyHex)) reject();

    const myNonce = nodeCrypto.randomBytes(16);
    ws.send(encodeHello({
      version: WIRE_VERSION,
      pubkeyHex: this.key.publicKeyHex,
      nonceHex: myNonce.toString('hex'),
      capabilities: 0,
    }), { binary: true });

    const canonical = buildHandshakeCanonical(
      clientHello.pubkeyHex, this.key.publicKeyHex,
      clientHello.nonceHex, myNonce.toString('hex'),
    );

    const clientSig = await this.nextMessage(ws);
    if (!verifyWithRawPubkey(clientHello.pubkeyHex, canonical, clientSig)) {
      throw new Error('initiator signature invalid');
    }
    ws.send(nodeCrypto.sign(null, canonical, this.key.privateKey), { binary: true });

    const state = this.peers.get(clientHello.pubkeyHex);
    if (!state) throw new Error('peer state missing'); // unreachable given allow-list check
    // If a stale connection exists (e.g. both sides dialed), prefer the new one.
    if (state.ws && state.ws !== ws) { try { state.ws.close(); } catch { /* ignore */ } }
    this.establishPeer(state, ws);
  }

  private establishPeer(state: PeerState, ws: WebSocket): void {
    state.ws = ws;
    state.established = true;
    state.lastFrameAt = Date.now();
    this.stats.peersConnected = this.connectedPeerCount();
    console.log(`[federation] peer ${state.config.pubkey.slice(0, 12)}… connected`);

    ws.on('message', (raw: RawData) => {
      state.lastFrameAt = Date.now();
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      this.handleFrame(buf, state);
    });
    ws.on('close', () => {
      console.log(`[federation] peer ${state.config.pubkey.slice(0, 12)}… disconnected`);
      this.teardownPeer(state);
      this.scheduleReconnect(state);
    });

    state.heartbeatTimer = setInterval(() => {
      if (Date.now() - state.lastFrameAt > HEARTBEAT_TIMEOUT_MS) {
        try { ws.close(); } catch { /* close handler reaps */ }
        return;
      }
      const body = Buffer.alloc(8);
      body.writeBigInt64BE(BigInt(Date.now()), 0);
      try { ws.send(encodeFrame(FRAME_HEARTBEAT, body), { binary: true }); } catch { /* reaped on close */ }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private handleFrame(buf: Buffer, fromState: PeerState): void {
    const frame = decodeFrame(buf);
    if (!frame) {
      // Malformed or oversized — close per spec.
      try { fromState.ws?.close(); } catch { /* ignore */ }
      return;
    }
    if (frame.frameType === FRAME_HEARTBEAT) return; // lastFrameAt already updated

    if (frame.frameType !== FRAME_PACKET_FORWARD) return; // unknown type — ignore (forward-compat)
    if (frame.body.length < 17 + 31) return; // packetId + forwardCount + minimum packet header

    const packetIdHex = frame.body.subarray(0, 16).toString('hex');
    const forwardCount = frame.body.readUInt8(16);
    const packet = frame.body.subarray(17);

    this.stats.forwardsReceivedTotal++;

    if (this.cache.checkAndInsert(packetIdHex)) {
      this.stats.dropsDuplicateTotal++;
      return;
    }
    if (forwardCount >= MAX_HOPS) {
      this.stats.dropsTtlTotal++;
      return;
    }

    const outcome = this.classifyLocal(packet);
    if (outcome === 'delivered') {
      this.stats.deliveredLocallyTotal++;
      return;
    }
    if (outcome === 'stored') {
      this.stats.storedLocallyTotal++;
      return;
    }
    // Unknown locally — forward onward, excluding the peer it came from.
    this.stats.forwardedOnwardTotal++;
    this.fanOut(frame.body.subarray(0, 16), forwardCount + 1, Buffer.from(packet), fromState.config.pubkey);
  }
}
