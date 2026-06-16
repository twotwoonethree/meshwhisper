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
import { generateOnionKeypair, sealOnion, openOnion, type OnionHop } from './onion.js';

export const FEDERATION_SUBPROTOCOL = 'meshwhisper-federation.v1';

// ---- Wire constants (docs/federation.md "Forwarding wire format") ----

const WIRE_VERSION = 0x01;
const FRAME_PACKET_FORWARD = 0x01;
const FRAME_HEARTBEAT = 0x02;
const FRAME_ADDR_GOSSIP = 0x03; // ADR-010 stage-2: signed relay address records
const FRAME_PACKET_ROUTED = 0x04; // ADR-010 stage-3: "deliver to relay X" (one transit hop)
const FRAME_PACKET_ONION = 0x05;  // ADR-010 stage-3+: a layered onion (transit-hop privacy)

// ADR-010 stage-2 bounds. Address records are public relay infrastructure,
// so the only risk is resource exhaustion — keep the book and frames bounded.
const ADDR_PROTO = 'meshwhisper-addr.v3'; // v3 adds the optional `onionKey` (X25519)
const MAX_ADDR_BOOK = 4096;          // learned relay endpoints we retain
const MAX_PENDING_FORWARDS = 64;     // packets queued while an on-demand dial completes
const ADDR_RECORD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // ignore records older than a week
const MAX_VIA_ANCHORS = 16;          // transit anchors a record may advertise
// ADR-010 stage-3: cap transit hops so routed packets can't loop or amplify.
const MAX_TRANSIT_HOPS = parseInt(process.env.FEDERATION_MAX_TRANSIT_HOPS ?? '3', 10);
// ADR-010 stage-2: periodic anti-entropy. Event-driven gossip (on-establish +
// on-change) is the fast path; this backstop re-pushes the address book on a
// timer so the overlay still converges if any single propagation was delayed or
// missed (late link establishment, a dropped re-gossip under load). Tunable.
const GOSSIP_INTERVAL_MS = parseInt(process.env.FEDERATION_GOSSIP_INTERVAL_MS ?? '10000', 10);

const MAX_HOPS = parseInt(process.env.FEDERATION_MAX_HOPS ?? '3', 10);
const MAX_FRAME_BODY = 8192;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 90_000;
const PACKET_ID_CACHE_SIZE = 1024;
const PACKET_ID_TTL_MS = 60_000;
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000];

/** Admission policy. 'open' accepts any peer that completes the handshake
 *  (Tor-middle-node posture — the project's recommended setting once a
 *  mesh exists); 'allowlist' requires the pubkey to be pre-approved. */
export type FederationMode = 'allowlist' | 'open';

// DER wrappers so node:crypto can ingest raw Ed25519 key bytes.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// ---- Key management ----

export interface FederationKey {
  publicKeyHex: string;
  privateKey: nodeCrypto.KeyObject;
  /** ADR-010 stage-3+: X25519 onion keypair for peeling transit-onion layers. */
  onionPublicKeyHex: string;
  onionPrivatePkcs8Base64: string;
}

interface StoredFederationKey {
  publicKeyHex: string;
  privateKeyPkcs8Base64: string;
  onionPublicKeyHex?: string;
  onionPrivatePkcs8Base64?: string;
}

/**
 * Load the node's federation keypair from `keyPath`, generating and
 * persisting a fresh one if the file doesn't exist. Stored shape:
 * { publicKeyHex, privateKeyPkcs8Base64, onionPublicKeyHex, onionPrivatePkcs8Base64 }.
 * Existing files without onion keys are migrated in place (keys added, signed
 * identity preserved).
 */
export function loadOrCreateFederationKey(keyPath: string): FederationKey {
  let stored: StoredFederationKey;
  if (fs.existsSync(keyPath)) {
    stored = JSON.parse(fs.readFileSync(keyPath, 'utf8')) as StoredFederationKey;
  } else {
    const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
    const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
    stored = { publicKeyHex: spki.subarray(spki.length - 32).toString('hex'), privateKeyPkcs8Base64: pkcs8.toString('base64') };
  }

  // Add the onion keypair if missing (fresh key, or migrating a stage-1/2 file).
  if (!stored.onionPublicKeyHex || !stored.onionPrivatePkcs8Base64) {
    const onion = generateOnionKeypair();
    stored.onionPublicKeyHex = onion.publicKeyHex;
    stored.onionPrivatePkcs8Base64 = onion.privatePkcs8Base64;
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, JSON.stringify(stored, null, 2), { mode: 0o600 });
  }

  return {
    publicKeyHex: stored.publicKeyHex,
    privateKey: nodeCrypto.createPrivateKey({ key: Buffer.from(stored.privateKeyPkcs8Base64, 'base64'), format: 'der', type: 'pkcs8' }),
    onionPublicKeyHex: stored.onionPublicKeyHex,
    onionPrivatePkcs8Base64: stored.onionPrivatePkcs8Base64,
  };
}

// ---- Peers config ----

export interface PeerConfig {
  pubkey: string;
  /** Present = this node initiates outbound connections to the peer. */
  url?: string;
}

/**
 * ADR-010 stage-2: a self-certifying relay address record. A relay signs
 * {pubkey, endpoint, ts} with its federation key and gossips it; peers verify
 * the signature (so it can't be forged for another relay), keep the
 * newest-by-ts (LWW, handling address changes), and re-gossip changes onward.
 * Carries only public infrastructure — never user data or homings — so it is
 * safe to spread freely across the federation.
 */
export interface AddrRecord {
  pubkey: string;    // hex ed25519 federation pubkey
  endpoint?: string; // ws:// URL the relay is directly reachable at — absent if NAT'd
  via?: string[];    // ADR-010 stage-3: transit-anchor pubkeys this relay holds a
                     // persistent outbound link to; how to reach it when endpoint-less
  onionKey?: string; // ADR-010 stage-3+: hex X25519 onion key — seal transit layers to it
  ts: number;        // ms epoch — LWW tiebreak
  sig: string;       // hex ed25519 signature over the canonical bytes
}

function buildAddrCanonical(pubkeyHex: string, endpoint: string, ts: number, via: string[] = [], onionKey = ''): Buffer {
  // `via` is sorted so signer and verifier agree regardless of array order.
  return Buffer.from([ADDR_PROTO, pubkeyHex, endpoint, String(ts), [...via].sort().join(','), onionKey].join('\n'), 'utf8');
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

/**
 * Load the reactive blocklist: { "blocked": ["<pubkeyhex>", ...] }.
 * Checked at handshake time — a blocked pubkey is rejected regardless of
 * mode. Evicting an already-connected peer requires a restart in v1.
 */
export function loadBlocklist(blocklistPath: string): Set<string> {
  if (!fs.existsSync(blocklistPath)) return new Set();
  try {
    const raw = JSON.parse(fs.readFileSync(blocklistPath, 'utf8')) as { blocked?: string[] };
    return new Set((raw.blocked ?? []).filter((p) => /^[0-9a-f]{64}$/.test(p)));
  } catch {
    console.error(`[federation] malformed blocklist at ${blocklistPath} — ignoring`);
    return new Set();
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
  /** True for peers admitted dynamically in open mode (not in the config
   *  file). Removed from the peer map on disconnect so the open-mode cap
   *  frees up; we hold no reconnect responsibility for them. */
  dynamic: boolean;
  /** Per-peer PacketForward rate limiting (sliding 60s window). */
  frameWindow: { count: number; windowStart: number };
  /** ADR-010 stage-2/3: forwards queued while an on-demand dial to a learned
   *  relay completes; flushed once the link establishes. A `routedTarget` marks
   *  the entry as a transit hop (send a PACKET_ROUTED for that target) rather
   *  than a direct delivery to this peer. */
  pendingForwards?: PendingForward[];
}

interface PendingForward {
  packet: Buffer;
  /** When set, send a routed (transit) frame for this final target via this peer. */
  routedTarget?: string;
  /** When set, send this pre-built onion blob to this peer (ADR-010 stage-3+). */
  onionBlob?: Buffer;
  hops: number;
}

export interface FederationStats {
  peersConfigured: number;
  peersConnected: number;
  forwardsSentTotal: number;
  /** Subset of forwardsSentTotal sent via direct home-relay routing (ADR-010). */
  routedForwardsSentTotal: number;
  forwardsReceivedTotal: number;
  deliveredLocallyTotal: number;
  storedLocallyTotal: number;
  forwardedOnwardTotal: number;
  dropsDuplicateTotal: number;
  dropsTtlTotal: number;
  dropsRateLimitedTotal: number;
  handshakeFailuresTotal: number;
  handshakeRejectionsBlockedTotal: number;
  /** ADR-010 stage-2: address records currently held in the gossip book. */
  addrRecordsKnown: number;
  /** ADR-010 stage-2: address-gossip records accepted (verified + LWW-newer). */
  addrRecordsLearnedTotal: number;
  /** ADR-010 stage-2: forwards delivered to a relay reached via an on-demand
   *  dial to a gossip-learned endpoint (no static config for it). */
  discoveredDialsTotal: number;
  /** ADR-010 stage-3: routed (transit) frames we sent toward a NAT'd relay
   *  through one of its transit anchors. */
  transitForwardsSentTotal: number;
  /** ADR-010 stage-3: routed (transit) frames we received and re-dispatched as
   *  the transit relay. */
  transitFramesReceivedTotal: number;
  /** ADR-010 stage-3+: onion frames we originated toward a destination. */
  onionForwardsSentTotal: number;
  /** ADR-010 stage-3+: onion frames we peeled one layer of and re-dispatched. */
  onionFramesReceivedTotal: number;
  /** ADR-010 stage-3+: onion frames whose innermost layer we delivered locally. */
  onionDeliveredTotal: number;
}

// ---- Manager ----

export class FederationManager {
  private readonly key: FederationKey;
  private readonly mode: FederationMode;
  private readonly allowedPubkeys: Set<string>;
  private readonly blockedPubkeys: Set<string>;
  private readonly maxPeers: number;
  private readonly rateLimitPerMin: number;
  private readonly peers: Map<string, PeerState> = new Map(); // pubkeyHex → state
  private readonly cache = new PacketIdCache();
  private readonly classifyLocal: (packet: Uint8Array) => LocalOutcome;
  private readonly wss: WebSocketServer;
  private stopped = false;

  // ADR-010 stage-2: our own reachable endpoint (signed + advertised), and the
  // gossip address book mapping relay pubkey → newest known signed record.
  private readonly advertiseUrl: string | null;
  private readonly addrBook = new Map<string, AddrRecord>();
  private gossipTimer: ReturnType<typeof setInterval> | null = null;
  // ADR-010 stage-3+: when true, transit through an anchor is wrapped in an
  // onion so the anchor sees only "deliver to B", never the packet/destHash.
  private readonly onionTransit: boolean;
  // ADR-010 stage-3++: how many extra intermediate relay hops to insert before
  // the anchor when building an onion path, so a non-adjacent intermediate
  // never learns the destination relay. 0 = minimal [anchor, target] path.
  private readonly onionHops: number;
  // ADR-010 stage-3+++: restricted-egress mode. When true, this relay never
  // dials on demand for forwarding — it routes only over its already-established
  // links (its configured uplink). Models a relay behind a firewall that permits
  // just one persistent outbound connection; forces rendezvous/bridge routing.
  private readonly noDial: boolean;

  readonly stats: FederationStats = {
    peersConfigured: 0,
    peersConnected: 0,
    forwardsSentTotal: 0,
    routedForwardsSentTotal: 0,
    forwardsReceivedTotal: 0,
    deliveredLocallyTotal: 0,
    storedLocallyTotal: 0,
    forwardedOnwardTotal: 0,
    dropsDuplicateTotal: 0,
    dropsTtlTotal: 0,
    dropsRateLimitedTotal: 0,
    handshakeFailuresTotal: 0,
    handshakeRejectionsBlockedTotal: 0,
    addrRecordsKnown: 0,
    addrRecordsLearnedTotal: 0,
    discoveredDialsTotal: 0,
    transitForwardsSentTotal: 0,
    transitFramesReceivedTotal: 0,
    onionForwardsSentTotal: 0,
    onionFramesReceivedTotal: 0,
    onionDeliveredTotal: 0,
  };

  constructor(opts: {
    key: FederationKey;
    peers: PeerConfig[];
    classifyLocal: (packet: Uint8Array) => LocalOutcome;
    /** Admission policy. Default 'allowlist' (v1 behavior). */
    mode?: FederationMode;
    /** Pubkeys rejected at handshake regardless of mode. */
    blockedPubkeys?: Set<string>;
    /** Open-mode cap on total simultaneously-tracked peers (configured +
     *  dynamically admitted). Handshakes beyond the cap are rejected. */
    maxPeers?: number;
    /** Per-peer PacketForward frames accepted per minute; excess dropped. */
    rateLimitPerMin?: number;
    /** ADR-010 stage-2: this relay's own reachable ws:// endpoint. When set,
     *  it is signed + gossiped so peers can route to us by key, and lets us
     *  dial gossip-learned relays on demand. Omit to stay gossip-passive. */
    advertiseUrl?: string;
    /** ADR-010 stage-3+: onion-wrap transit hops so the transit relay never
     *  sees the packet/destHash, only the next hop. Default off. */
    onionTransit?: boolean;
    /** ADR-010 stage-3++: extra intermediate hops to insert before the anchor
     *  when building an onion path (hides the destination relay from
     *  non-adjacent intermediates). Default 1; clamped to [0, 4]. */
    onionHops?: number;
    /** ADR-010 stage-3+++: restricted egress — never dial on demand for
     *  forwarding; route only over established links. Default false. */
    noDial?: boolean;
  }) {
    this.key = opts.key;
    this.classifyLocal = opts.classifyLocal;
    this.mode = opts.mode ?? 'allowlist';
    this.blockedPubkeys = opts.blockedPubkeys ?? new Set();
    this.maxPeers = opts.maxPeers ?? 64;
    this.rateLimitPerMin = opts.rateLimitPerMin ?? 6000; // ≈100 frames/sec
    this.advertiseUrl = opts.advertiseUrl ?? null;
    this.onionTransit = opts.onionTransit ?? false;
    this.onionHops = Math.max(0, Math.min(4, opts.onionHops ?? 1));
    this.noDial = opts.noDial ?? false;
    this.allowedPubkeys = new Set(opts.peers.map((p) => p.pubkey));
    for (const p of opts.peers) {
      this.peers.set(p.pubkey, this.newPeerState(p, false));
    }
    this.stats.peersConfigured = opts.peers.length;
    this.wss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) =>
        protocols.has(FEDERATION_SUBPROTOCOL) ? FEDERATION_SUBPROTOCOL : false,
    });
  }

  private newPeerState(config: PeerConfig, dynamic: boolean): PeerState {
    return {
      config,
      ws: null,
      established: false,
      reconnectAttempt: 0,
      reconnectTimer: null,
      heartbeatTimer: null,
      lastFrameAt: 0,
      dynamic,
      frameWindow: { count: 0, windowStart: 0 },
    };
  }

  /** Dial every peer that has a url. Inbound peers connect to us instead. */
  start(): void {
    // ADR-010 stage-2/3: seed the address book with our own signed record so it
    // gossips out. `endpoint` advertises a directly-dialable address (public
    // relays); `via` lists the transit anchors we hold persistent outbound links
    // to (the configured peers we dial) — how to reach us when we're NAT'd and
    // have no public endpoint.
    const via = [...this.peers.values()].filter((s) => s.config.url).map((s) => s.config.pubkey);
    if (this.advertiseUrl || via.length > 0) {
      const ts = Date.now();
      const endpoint = this.advertiseUrl ?? '';
      const onionKey = this.key.onionPublicKeyHex;
      const sig = nodeCrypto.sign(null, buildAddrCanonical(this.key.publicKeyHex, endpoint, ts, via, onionKey), this.key.privateKey);
      this.addrBook.set(this.key.publicKeyHex, {
        pubkey: this.key.publicKeyHex,
        ...(this.advertiseUrl ? { endpoint: this.advertiseUrl } : {}),
        ...(via.length > 0 ? { via } : {}),
        onionKey,
        ts, sig: sig.toString('hex'),
      });
      this.stats.addrRecordsKnown = this.addrBook.size;
    }
    for (const state of this.peers.values()) {
      if (state.config.url) this.dial(state);
    }
    // Periodic anti-entropy backstop (see GOSSIP_INTERVAL_MS): re-push our book
    // to every established peer so the overlay converges even if an event-driven
    // gossip was delayed or missed.
    this.gossipTimer = setInterval(() => this.periodicGossip(), GOSSIP_INTERVAL_MS);
    if (typeof this.gossipTimer.unref === 'function') this.gossipTimer.unref();
  }

  private periodicGossip(): void {
    const records = [...this.addrBook.values()];
    if (records.length === 0) return;
    for (const peer of this.peers.values()) {
      if (peer.established && peer.ws && peer.ws.readyState === WebSocket.OPEN) {
        this.sendAddrGossip(peer, records);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.gossipTimer) { clearInterval(this.gossipTimer); this.gossipTimer = null; }
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

  /**
   * ADR-010: route a locally-received packet *directly* to the one federated
   * peer that homes the recipient (identified by federation pubkey), instead
   * of flooding every peer.
   *
   * Stage 1: if the target is a connected peer, send now.
   * Stage 2: if it isn't connected but we know its endpoint from the gossip
   * address book, dial it on demand, queue the packet, and send once the link
   * is up. Returns false only when the target is wholly unknown (no connection,
   * no learned address) — the caller then falls back to the flood so delivery
   * still happens. The peer handles the resulting PacketForward frame
   * identically to a flooded one — no peer-side change.
   */
  forwardToRelay(targetPubkeyHex: string, packet: Uint8Array, hops = 0): boolean {
    if (packet.byteLength > MAX_FRAME_BODY - 33) return false; // room for the routed header too
    if (targetPubkeyHex === this.key.publicKeyHex) return false;

    // 1. Connected peer — send now (stage 1).
    const state = this.peers.get(targetPubkeyHex);
    if (state?.established && state.ws && state.ws.readyState === WebSocket.OPEN) {
      return this.sendForwardFrame(state, packet);
    }
    if (hops >= MAX_TRANSIT_HOPS) return false; // transit loop/amplification guard

    const addr = this.addrBook.get(targetPubkeyHex);
    if (!addr) return false; // wholly unknown — caller floods

    // 2. Directly dialable endpoint — on-demand dial (stage 2). Skipped under
    //    restricted egress (we route only over established links).
    if (addr.endpoint && !this.noDial) {
      this.queueAndDial(targetPubkeyHex, addr.endpoint, { packet: Buffer.from(packet), hops });
      return true;
    }

    // 3a. Onion transit (stage 3++): select a multi-hop path over the gossip
    // topology — [intermediates…, anchor, target] — and seal one layer per hop.
    // Each hop peels only its own layer (learns just the next hop), so a
    // non-adjacent intermediate never sees the destination, and no hop but the
    // target sees the packet/destHash.
    if (this.onionTransit) {
      const path = this.selectOnionPath(targetPubkeyHex);
      if (path && path.length >= 2) {
        const onion = sealOnion(path, Buffer.from(packet));
        if (onion.byteLength <= MAX_FRAME_BODY && this.sendOnionTo(path[0].pubkey, onion)) {
          this.stats.onionForwardsSentTotal++;
          return true;
        }
      }
      // fall through to cleartext routed transit if no usable onion path
    }

    // 3b. Cleartext routed transit (stage 3): ask an anchor to forwardToRelay
    // onward, which bottoms out at a plain forward over its link to the target.
    for (const transitHex of addr.via ?? []) {
      if (transitHex === this.key.publicKeyHex) continue;
      const tAddr = this.addrBook.get(transitHex);
      const tState = this.peers.get(transitHex);
      if (tState?.established && tState.ws && tState.ws.readyState === WebSocket.OPEN) {
        if (this.sendRouted(tState, targetPubkeyHex, packet, hops + 1)) return true;
        continue;
      }
      if (tAddr?.endpoint && !this.noDial) {
        this.queueAndDial(transitHex, tAddr.endpoint, { packet: Buffer.from(packet), routedTarget: targetPubkeyHex, hops: hops + 1 });
        return true;
      }
    }
    return false; // no reachable path — caller floods
  }

  /**
   * ADR-010 stage-3++: choose an onion path to a NAT'd target from the gossip
   * topology — `[intermediate…, anchor, target]`. The anchor is a relay in the
   * target's `via` (it holds the target's inbound link); intermediates are
   * public relays (dialable + onion-capable) inserted to hide the destination
   * from non-adjacent hops. Returns null if no usable anchor is known.
   */
  private selectOnionPath(targetPubkeyHex: string): OnionHop[] | null {
    const target = this.addrBook.get(targetPubkeyHex);
    if (!target?.onionKey) return null;
    const toHop = (r: AddrRecord): OnionHop => ({ pubkey: r.pubkey, onionKey: r.onionKey! });

    // Onion-capable anchors that hold the target's inbound link.
    const anchors = (target.via ?? [])
      .map((v) => this.addrBook.get(v))
      .filter((r): r is AddrRecord => !!r?.onionKey && r.pubkey !== this.key.publicKeyHex);
    if (anchors.length === 0) return null;

    // Case A — an anchor we can reach directly: insert optional random privacy
    // hops, then [anchor, target]. (Hides the destination from intermediaries.)
    const directAnchor = anchors.find((a) => this.canReachDirectly(a.pubkey));
    if (directAnchor) {
      const exclude = new Set([this.key.publicKeyHex, targetPubkeyHex, directAnchor.pubkey]);
      const candidates = [...this.addrBook.values()].filter((r) => r.onionKey && this.canReachDirectly(r.pubkey) && !exclude.has(r.pubkey));
      const path: OnionHop[] = this.pickRandom(candidates, this.onionHops).map(toHop);
      path.push(toHop(directAnchor), { pubkey: targetPubkeyHex, onionKey: target.onionKey });
      return path;
    }

    // Case B — both-ends-NAT / restricted egress: we can't reach any anchor
    // directly, so BFS the gossip topology for a bridge of relays we CAN reach,
    // ending at an anchor. The bridge rides existing federation links to a
    // common backbone relay (the rendezvous) that bridges to the target's anchor.
    for (const anchor of anchors) {
      const bridge = this.findBridge(anchor.pubkey);
      if (bridge) {
        const path = bridge.map((h) => toHop(this.addrBook.get(h)!));
        path.push({ pubkey: targetPubkeyHex, onionKey: target.onionKey });
        return path;
      }
    }
    return null;
  }

  /** Can we hand a frame to this relay right now? Connected, or (unless egress
   *  is restricted) dialable via a known endpoint. */
  private canReachDirectly(pubkeyHex: string): boolean {
    if (this.peers.get(pubkeyHex)?.established) return true;
    return !this.noDial && !!this.addrBook.get(pubkeyHex)?.endpoint;
  }

  /** Topology edge: can relay `from` forward to relay `to`? True if they share a
   *  link (either dials the other) or `to` is publicly dialable. */
  private canReach(fromHex: string, toHex: string): boolean {
    const fromRec = this.addrBook.get(fromHex);
    const toRec = this.addrBook.get(toHex);
    if (!toRec) return false;
    return !!toRec.endpoint || !!fromRec?.via?.includes(toHex) || !!toRec.via?.includes(fromHex);
  }

  /**
   * ADR-010 stage-3+++: BFS the gossip topology for a chain of onion-capable
   * relays from one we can reach directly to `anchorHex`, bounded by
   * MAX_TRANSIT_HOPS. Returns the chain of pubkeys [reachable…, anchor], or null.
   */
  private findBridge(anchorHex: string): string[] | null {
    const onionRelays = [...this.addrBook.values()].filter((r) => r.onionKey && r.pubkey !== this.key.publicKeyHex);
    const queue: string[][] = onionRelays.filter((r) => this.canReachDirectly(r.pubkey)).map((r) => [r.pubkey]);
    const visited = new Set<string>(queue.map((p) => p[0]));
    while (queue.length > 0) {
      const path = queue.shift()!;
      const head = path[path.length - 1];
      if (head === anchorHex) return path;
      if (path.length >= MAX_TRANSIT_HOPS) continue;
      for (const cand of onionRelays) {
        if (visited.has(cand.pubkey)) continue;
        if (this.canReach(head, cand.pubkey)) {
          visited.add(cand.pubkey);
          queue.push([...path, cand.pubkey]);
        }
      }
    }
    return null;
  }

  /** Pick up to n distinct random elements (Fisher-Yates partial draw). */
  private pickRandom<T>(arr: T[], n: number): T[] {
    const pool = arr.slice();
    const out: T[] = [];
    while (out.length < n && pool.length > 0) {
      out.push(pool.splice(nodeCrypto.randomInt(pool.length), 1)[0]);
    }
    return out;
  }

  /** Send a pre-built onion to its first hop — connected peer now, else (unless
   *  egress is restricted) dial it on demand. */
  private sendOnionTo(nextHex: string, onionBlob: Buffer): boolean {
    const st = this.peers.get(nextHex);
    if (st?.established && st.ws && st.ws.readyState === WebSocket.OPEN) {
      try { st.ws.send(encodeFrame(FRAME_PACKET_ONION, onionBlob), { binary: true }); return true; }
      catch { return false; }
    }
    if (this.noDial) return false; // restricted egress — established links only
    const addr = this.addrBook.get(nextHex);
    if (addr?.endpoint) {
      this.queueAndDial(nextHex, addr.endpoint, { packet: Buffer.alloc(0), onionBlob, hops: 0 });
      return true;
    }
    return false;
  }

  /** Ensure a peer state exists with a dial URL, queue a pending forward, and
   *  kick off a dial if one isn't already in flight. */
  private queueAndDial(pubkeyHex: string, endpoint: string, entry: PendingForward): void {
    let st = this.peers.get(pubkeyHex);
    if (!st) {
      st = this.newPeerState({ pubkey: pubkeyHex, url: endpoint }, false);
      this.peers.set(pubkeyHex, st);
    } else if (!st.config.url) {
      st.config = { ...st.config, url: endpoint };
    }
    (st.pendingForwards ??= []).push(entry);
    if (st.pendingForwards.length > MAX_PENDING_FORWARDS) st.pendingForwards.shift();
    if (!st.ws && !st.reconnectTimer) {
      this.stats.discoveredDialsTotal++;
      this.dial(st);
    }
  }

  /** Send a PACKET_ROUTED frame ("deliver to targetHex") to a transit relay. */
  private sendRouted(state: PeerState, targetHex: string, packet: Uint8Array, hops: number): boolean {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
    const body = Buffer.alloc(1 + 32 + packet.length);
    body.writeUInt8(hops, 0);
    Buffer.from(targetHex, 'hex').copy(body, 1);
    Buffer.from(packet).copy(body, 33);
    try {
      state.ws.send(encodeFrame(FRAME_PACKET_ROUTED, body), { binary: true });
      this.stats.transitForwardsSentTotal++;
      return true;
    } catch {
      return false;
    }
  }

  /** Encode + send a single PacketForward frame to an established peer. */
  private sendForwardFrame(state: PeerState, packet: Uint8Array): boolean {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
    const packetId = nodeCrypto.randomBytes(16);
    this.cache.checkAndInsert(packetId.toString('hex'));
    const body = Buffer.alloc(17 + packet.length);
    packetId.copy(body, 0);
    body.writeUInt8(0, 16);
    Buffer.from(packet).copy(body, 17);
    const frame = encodeFrame(FRAME_PACKET_FORWARD, body);
    try {
      state.ws.send(frame, { binary: true });
      this.stats.forwardsSentTotal++;
      this.stats.routedForwardsSentTotal++;
      return true;
    } catch {
      return false;
    }
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
    // Dynamically-admitted peers leave the map entirely on disconnect so
    // the open-mode cap frees up. We hold no reconnect duty for them —
    // they dial us again whenever they want back in.
    if (state.dynamic) {
      this.peers.delete(state.config.pubkey);
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
    if (this.blockedPubkeys.has(clientHello.pubkeyHex)) {
      this.stats.handshakeRejectionsBlockedTotal++;
      reject();
    }
    if (this.mode === 'allowlist' && !this.allowedPubkeys.has(clientHello.pubkeyHex)) reject();
    if (
      this.mode === 'open' &&
      !this.peers.has(clientHello.pubkeyHex) &&
      this.peers.size >= this.maxPeers
    ) reject();

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

    let state = this.peers.get(clientHello.pubkeyHex);
    if (!state) {
      // Open mode: dynamically admit. (Unreachable under allowlist —
      // the admission check above would have rejected.)
      state = this.newPeerState({ pubkey: clientHello.pubkeyHex }, true);
      this.peers.set(clientHello.pubkeyHex, state);
    }
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

    // ADR-010 stage-2: share what we know about relay endpoints, then flush any
    // packets that were queued waiting for this (on-demand-dialed) link.
    this.sendAddrGossip(state, [...this.addrBook.values()]);
    this.flushPending(state);
  }

  /** Send a batch of address records to a peer (as many as fit one frame). */
  private sendAddrGossip(state: PeerState, records: AddrRecord[]): void {
    if (records.length === 0 || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    // Greedily pack records until the JSON would exceed a frame body.
    const fit: AddrRecord[] = [];
    for (const r of records) {
      fit.push(r);
      if (Buffer.byteLength(JSON.stringify(fit)) > MAX_FRAME_BODY - 16) { fit.pop(); break; }
    }
    if (fit.length === 0) return;
    try {
      state.ws.send(encodeFrame(FRAME_ADDR_GOSSIP, Buffer.from(JSON.stringify(fit), 'utf8')), { binary: true });
    } catch { /* reaped on close */ }
  }

  /** Flush forwards queued while an on-demand dial completed. */
  private flushPending(state: PeerState): void {
    const queued = state.pendingForwards;
    if (!queued || queued.length === 0) return;
    state.pendingForwards = [];
    for (const e of queued) {
      if (e.onionBlob) {
        try { state.ws?.send(encodeFrame(FRAME_PACKET_ONION, e.onionBlob), { binary: true }); } catch { /* reaped */ }
      } else if (e.routedTarget) {
        this.sendRouted(state, e.routedTarget, e.packet, e.hops);
      } else {
        this.sendForwardFrame(state, e.packet);
      }
    }
  }

  private handleFrame(buf: Buffer, fromState: PeerState): void {
    const frame = decodeFrame(buf);
    if (!frame) {
      // Malformed or oversized — close per spec.
      try { fromState.ws?.close(); } catch { /* ignore */ }
      return;
    }
    if (frame.frameType === FRAME_HEARTBEAT) return; // lastFrameAt already updated

    if (frame.frameType === FRAME_ADDR_GOSSIP) { this.handleAddrGossip(frame.body, fromState); return; }

    if (frame.frameType === FRAME_PACKET_ROUTED) { this.handleRoutedForward(frame.body, fromState); return; }

    if (frame.frameType === FRAME_PACKET_ONION) { this.handleOnion(frame.body, fromState); return; }

    if (frame.frameType !== FRAME_PACKET_FORWARD) return; // unknown type — ignore (forward-compat)
    if (frame.body.length < 17 + 31) return; // packetId + forwardCount + minimum packet header

    // Per-peer rate limiting — the abuse boundary in open mode.
    if (this.overRateLimit(fromState)) return;

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

  /** Per-peer sliding-window rate limit (the open-mode abuse boundary). Returns
   *  true (and counts a drop) when the peer is over its budget this minute. */
  private overRateLimit(fromState: PeerState): boolean {
    const now = Date.now();
    if (now - fromState.frameWindow.windowStart >= 60_000) {
      fromState.frameWindow = { count: 0, windowStart: now };
    }
    fromState.frameWindow.count++;
    if (fromState.frameWindow.count > this.rateLimitPerMin) {
      this.stats.dropsRateLimitedTotal++;
      return true;
    }
    return false;
  }

  /**
   * ADR-010 stage-3: a transit relay received "deliver to relay X". We simply
   * run forwardToRelay for that target on our side — which, since the target
   * holds a persistent outbound link to us, sends a plain forward down it (one
   * hop). The hop counter (carried in the frame, capped at MAX_TRANSIT_HOPS)
   * bounds the path so routed frames can't loop or amplify across the mesh.
   */
  private handleRoutedForward(body: Buffer, fromState: PeerState): void {
    if (body.length < 1 + 32 + 31) return; // hops + target + minimum packet header
    if (this.overRateLimit(fromState)) return;
    this.stats.transitFramesReceivedTotal++;
    const hops = body.readUInt8(0);
    if (hops >= MAX_TRANSIT_HOPS) { this.stats.dropsTtlTotal++; return; }
    const targetHex = body.subarray(1, 33).toString('hex');
    const packet = body.subarray(33);
    this.forwardToRelay(targetHex, Buffer.from(packet), hops);
  }

  /**
   * ADR-010 stage-3+: peel one onion layer with our X25519 onion key. A
   * `forward` layer names only the next hop (the inner remains sealed to it, so
   * we — a transit relay — never see the packet or its destHash); we send the
   * inner onion onward. A `deliver` layer is the innermost, openable only by the
   * destination relay, and carries the actual packet for local delivery. A layer
   * that isn't ours fails to open and is dropped.
   */
  private handleOnion(body: Buffer, fromState: PeerState): void {
    if (this.overRateLimit(fromState)) return;
    this.stats.onionFramesReceivedTotal++;
    const opened = openOnion(this.key.onionPrivatePkcs8Base64, body);
    if (!opened) return; // not addressed to us / malformed — drop
    if (opened.type === 'deliver') {
      this.stats.onionDeliveredTotal++;
      const outcome = this.classifyLocal(opened.inner);
      if (outcome === 'delivered') this.stats.deliveredLocallyTotal++;
      else if (outcome === 'stored') this.stats.storedLocallyTotal++;
      return;
    }
    // forward: re-dispatch the inner onion to the next hop (no plaintext target).
    this.sendOnionTo(opened.next, opened.inner);
  }

  /**
   * ADR-010 stage-2: ingest gossiped address records. Each is verified against
   * the claimed pubkey's signature (un-forgeable for another relay), merged
   * LWW by timestamp, and — if genuinely new/newer — re-gossiped to our other
   * peers (excluding the sender), so endpoints propagate transitively across
   * the federation. Records carry only public infrastructure, never user data.
   */
  private handleAddrGossip(body: Buffer, fromState: PeerState): void {
    let records: AddrRecord[];
    try {
      const parsed = JSON.parse(body.toString('utf8')) as unknown;
      if (!Array.isArray(parsed)) return;
      records = parsed as AddrRecord[];
    } catch { return; }

    const now = Date.now();
    const changed: AddrRecord[] = [];
    for (const r of records) {
      if (!r || typeof r.pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(r.pubkey)) continue;
      // endpoint is optional (NAT'd relays have none) — validate when present.
      if (r.endpoint !== undefined &&
          (typeof r.endpoint !== 'string' || !/^wss?:\/\//.test(r.endpoint) || r.endpoint.length > 256)) continue;
      // via (transit anchors) is optional — must be well-formed when present.
      let via: string[] | undefined;
      if (r.via !== undefined) {
        if (!Array.isArray(r.via) || r.via.length > MAX_VIA_ANCHORS ||
            r.via.some((v) => typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v))) continue;
        via = r.via;
      }
      if (!r.endpoint && (!via || via.length === 0)) continue; // record offers no way to reach the relay
      // onionKey (X25519) is optional — validate when present.
      if (r.onionKey !== undefined && (typeof r.onionKey !== 'string' || !/^[0-9a-f]{64}$/.test(r.onionKey))) continue;
      if (typeof r.ts !== 'number' || !Number.isFinite(r.ts)) continue;
      if (typeof r.sig !== 'string' || !/^[0-9a-f]{128}$/.test(r.sig)) continue;
      if (r.pubkey === this.key.publicKeyHex) continue;       // never let a peer overwrite our own record
      if (now - r.ts > ADDR_RECORD_MAX_AGE_MS || r.ts > now + 60_000) continue; // stale or implausibly future

      // Signature must verify against the claimed pubkey — this is what makes
      // the record self-certifying and un-spoofable for another relay.
      if (!verifyWithRawPubkey(r.pubkey, buildAddrCanonical(r.pubkey, r.endpoint ?? '', r.ts, via ?? [], r.onionKey ?? ''), Buffer.from(r.sig, 'hex'))) continue;

      const existing = this.addrBook.get(r.pubkey);
      if (existing && existing.ts >= r.ts) continue;          // LWW: keep the newest
      if (!existing && this.addrBook.size >= MAX_ADDR_BOOK) continue; // bounded
      const rec: AddrRecord = {
        pubkey: r.pubkey, ts: r.ts, sig: r.sig,
        ...(r.endpoint ? { endpoint: r.endpoint } : {}),
        ...(via ? { via } : {}),
        ...(r.onionKey ? { onionKey: r.onionKey } : {}),
      };
      this.addrBook.set(r.pubkey, rec);
      this.stats.addrRecordsLearnedTotal++;
      changed.push(rec);
    }
    this.stats.addrRecordsKnown = this.addrBook.size;

    // Re-gossip only the records that actually changed, to peers other than
    // the one we heard them from. Unchanged records aren't re-sent, so the
    // gossip converges instead of looping.
    if (changed.length > 0) {
      for (const [pubkey, peer] of this.peers) {
        if (pubkey === fromState.config.pubkey) continue;
        if (peer.established && peer.ws && peer.ws.readyState === WebSocket.OPEN) {
          this.sendAddrGossip(peer, changed);
        }
      }
    }
  }
}
