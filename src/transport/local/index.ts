// ============================================================
// MeshWhisper SDK — Local Network Transport (LAN)
// Bearer: local_net
//
// Uses UDP broadcast for peer discovery and TCP for reliable
// data transfer. Designed for device self-clustering on the
// same subnet (phone ↔ laptop in the same home).
// ============================================================

import * as dgram from 'node:dgram';
import * as net from 'node:net';
import type { Transport, Packet, PacketFlags } from '../../types.js';

// --- Constants ---

const MAGIC = 0x4d575350; // "MWSP"
const DEFAULT_UDP_PORT = 19205;
const DEFAULT_TCP_PORT = 19206;
const ANNOUNCE_INTERVAL_MS = 5_000;
const PEER_TTL_MS = 15_000;
const DEVICE_ID_LENGTH = 16;
const ANNOUNCEMENT_SIZE = 4 + DEVICE_ID_LENGTH + 2; // magic + id + port
const LENGTH_PREFIX_SIZE = 4; // uint32 big-endian frame header

// --- Discovered peer entry ---

interface DiscoveredPeer {
  id: string;
  address: string;
  port: number;
  lastSeen: number;
}

// --- TCP connection wrapper ---

interface PeerConnection {
  peerId: string;
  socket: net.Socket;
  recvBuffer: Buffer;
}

// --- Helpers ---

/** Encode a 16-byte device ID to a hex string. */
function deviceIdToHex(buf: Uint8Array): string {
  return Buffer.from(buf).toString('hex');
}

/** Decode a hex string back to a 16-byte Uint8Array. */
function hexToDeviceId(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

/** Serialize a Packet to a binary buffer. */
function serializePacket(packet: Packet): Buffer {
  const headerSize =
    1 + // version
    1 + // flags
    8 + // destHash
    16 + // senderEphemeralId
    1 + // ttl
    4; // payloadLength (uint32)
  const buf = Buffer.alloc(headerSize + packet.encryptedPayload.length);
  let offset = 0;

  buf.writeUInt8(packet.version, offset);
  offset += 1;
  buf.writeUInt8(packet.flags, offset);
  offset += 1;
  Buffer.from(packet.destHash).copy(buf, offset, 0, 8);
  offset += 8;
  Buffer.from(packet.senderEphemeralId).copy(buf, offset, 0, 16);
  offset += 16;
  buf.writeUInt8(packet.ttl, offset);
  offset += 1;
  buf.writeUInt32BE(packet.encryptedPayload.length, offset);
  offset += 4;
  Buffer.from(packet.encryptedPayload).copy(buf, offset);

  return buf;
}

/** Deserialize a binary buffer back into a Packet. */
function deserializePacket(buf: Buffer): Packet {
  let offset = 0;

  const version = buf.readUInt8(offset);
  offset += 1;
  const flags = buf.readUInt8(offset) as PacketFlags;
  offset += 1;
  const destHash = new Uint8Array(buf.subarray(offset, offset + 8));
  offset += 8;
  const senderEphemeralId = new Uint8Array(buf.subarray(offset, offset + 16));
  offset += 16;
  const ttl = buf.readUInt8(offset);
  offset += 1;
  const payloadLength = buf.readUInt32BE(offset);
  offset += 4;
  const encryptedPayload = new Uint8Array(buf.subarray(offset, offset + payloadLength));

  return { version, flags, destHash, senderEphemeralId, ttl, payloadLength, encryptedPayload };
}

// ============================================================
// LocalTransport
// ============================================================

export class LocalTransport implements Transport {
  readonly type = 'local_net' as const;

  // --- Configuration ---
  private readonly deviceId: Uint8Array;
  private readonly deviceIdHex: string;
  private readonly udpPort: number;
  private readonly tcpPort: number;

  // --- Networking ---
  private udpSocket: dgram.Socket | null = null;
  private tcpServer: net.Server | null = null;
  private announceTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  // --- State ---
  private readonly discoveredPeers = new Map<string, DiscoveredPeer>();
  private readonly connections = new Map<string, PeerConnection>();
  private readonly pendingConnections = new Set<string>(); // addresses currently being connected to
  private receiveCallback: ((packet: Packet, source: string) => void) | null = null;
  private running = false;

  constructor(
    deviceId: Uint8Array,
    options?: { udpPort?: number; tcpPort?: number },
  ) {
    if (deviceId.length !== DEVICE_ID_LENGTH) {
      throw new Error(`deviceId must be ${DEVICE_ID_LENGTH} bytes, got ${deviceId.length}`);
    }
    this.deviceId = deviceId;
    this.deviceIdHex = deviceIdToHex(deviceId);
    this.udpPort = options?.udpPort ?? DEFAULT_UDP_PORT;
    this.tcpPort = options?.tcpPort ?? DEFAULT_TCP_PORT;
  }

  // --------------------------------------------------------
  // Transport interface — lifecycle
  // --------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await Promise.all([
      this.startDiscovery(),
      this.startListener(this.tcpPort),
    ]);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    // Clear timers
    if (this.announceTimer) {
      clearInterval(this.announceTimer);
      this.announceTimer = null;
    }
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }

    // Close all TCP peer connections
    for (const [, conn] of this.connections) {
      conn.socket.destroy();
    }
    this.connections.clear();
    this.pendingConnections.clear();

    // Close TCP server
    await new Promise<void>((resolve) => {
      if (this.tcpServer) {
        this.tcpServer.close(() => resolve());
      } else {
        resolve();
      }
    });
    this.tcpServer = null;

    // Close UDP socket
    await new Promise<void>((resolve) => {
      if (this.udpSocket) {
        this.udpSocket.close(() => resolve());
      } else {
        resolve();
      }
    });
    this.udpSocket = null;

    this.discoveredPeers.clear();
  }

  async isAvailable(): Promise<boolean> {
    // Local network is available if we can bind a UDP socket.
    // In practice this checks whether the OS networking stack is usable.
    return new Promise<boolean>((resolve) => {
      const probe = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      probe.on('error', () => {
        probe.close();
        resolve(false);
      });
      probe.bind(0, () => {
        probe.close();
        resolve(true);
      });
    });
  }

  // --------------------------------------------------------
  // Transport interface — messaging
  // --------------------------------------------------------

  async send(packet: Packet, destination: string): Promise<void> {
    const conn = this.connections.get(destination);
    if (!conn) {
      throw new Error(`No active connection to peer ${destination}`);
    }

    const payload = serializePacket(packet);
    const frame = Buffer.alloc(LENGTH_PREFIX_SIZE + payload.length);
    frame.writeUInt32BE(payload.length, 0);
    payload.copy(frame, LENGTH_PREFIX_SIZE);

    await new Promise<void>((resolve, reject) => {
      conn.socket.write(frame, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  onReceive(callback: (packet: Packet, source: string) => void): void {
    this.receiveCallback = callback;
  }

  // --------------------------------------------------------
  // UDP Discovery
  // --------------------------------------------------------

  async startDiscovery(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      this.udpSocket.on('error', (err) => {
        if (!this.running) return;
        // Non-fatal in steady state; during bind it rejects the promise.
        reject(err);
      });

      this.udpSocket.on('message', (msg, rinfo) => {
        this.handleAnnouncement(msg, rinfo.address);
      });

      this.udpSocket.bind(this.udpPort, () => {
        this.udpSocket!.setBroadcast(true);

        // Send first announcement immediately, then on interval
        this.broadcastAnnouncement();
        this.announceTimer = setInterval(
          () => this.broadcastAnnouncement(),
          ANNOUNCE_INTERVAL_MS,
        );

        // Periodically prune stale peers
        this.pruneTimer = setInterval(
          () => this.pruneStalePeers(),
          ANNOUNCE_INTERVAL_MS,
        );

        resolve();
      });
    });
  }

  /** Build and broadcast a MWSP announcement datagram. */
  private broadcastAnnouncement(): void {
    if (!this.udpSocket) return;

    const buf = Buffer.alloc(ANNOUNCEMENT_SIZE);
    let offset = 0;

    buf.writeUInt32BE(MAGIC, offset);
    offset += 4;
    Buffer.from(this.deviceId).copy(buf, offset, 0, DEVICE_ID_LENGTH);
    offset += DEVICE_ID_LENGTH;
    buf.writeUInt16BE(this.tcpPort, offset);

    this.udpSocket.send(buf, 0, buf.length, this.udpPort, '255.255.255.255', (err) => {
      if (err && this.running) {
        // Best-effort; swallow transient send errors.
      }
    });
  }

  /** Process an incoming UDP announcement. */
  private handleAnnouncement(msg: Buffer, senderAddress: string): void {
    if (msg.length < ANNOUNCEMENT_SIZE) return;

    const magic = msg.readUInt32BE(0);
    if (magic !== MAGIC) return;

    const peerIdBytes = msg.subarray(4, 4 + DEVICE_ID_LENGTH);
    const peerId = deviceIdToHex(peerIdBytes);

    // Ignore our own announcements
    if (peerId === this.deviceIdHex) return;

    const tcpPort = msg.readUInt16BE(4 + DEVICE_ID_LENGTH);

    const existing = this.discoveredPeers.get(peerId);
    if (existing) {
      existing.lastSeen = Date.now();
      existing.address = senderAddress;
      existing.port = tcpPort;
    } else {
      this.discoveredPeers.set(peerId, {
        id: peerId,
        address: senderAddress,
        port: tcpPort,
        lastSeen: Date.now(),
      });
    }

    // Auto-connect if we don't already have a TCP connection
    if (!this.connections.has(peerId) && !this.pendingConnections.has(peerId)) {
      this.connectToPeer(senderAddress, tcpPort).catch(() => {
        // Connection failed; will retry on next announcement.
      });
    }
  }

  /** Remove peers whose last announcement is older than PEER_TTL_MS. */
  private pruneStalePeers(): void {
    const now = Date.now();
    for (const [id, peer] of this.discoveredPeers) {
      if (now - peer.lastSeen > PEER_TTL_MS) {
        this.discoveredPeers.delete(id);
        // Also tear down stale TCP connections
        const conn = this.connections.get(id);
        if (conn) {
          conn.socket.destroy();
          this.connections.delete(id);
        }
      }
    }
  }

  // --------------------------------------------------------
  // TCP Data Channel
  // --------------------------------------------------------

  async startListener(port?: number): Promise<void> {
    const listenPort = port ?? this.tcpPort;

    await new Promise<void>((resolve, reject) => {
      this.tcpServer = net.createServer((socket) => {
        this.handleIncomingConnection(socket);
      });

      this.tcpServer.on('error', (err) => {
        reject(err);
      });

      this.tcpServer.listen(listenPort, () => {
        resolve();
      });
    });
  }

  async connectToPeer(address: string, port: number): Promise<void> {
    // Derive a temporary key until the peer identifies itself via handshake.
    const addrKey = `${address}:${port}`;
    this.pendingConnections.add(addrKey);

    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: address, port }, () => {
        // Send our device ID so the remote side knows who connected
        const idFrame = Buffer.alloc(LENGTH_PREFIX_SIZE + DEVICE_ID_LENGTH);
        idFrame.writeUInt32BE(DEVICE_ID_LENGTH, 0);
        Buffer.from(this.deviceId).copy(idFrame, LENGTH_PREFIX_SIZE);
        socket.write(idFrame);

        // We don't yet know the peer ID. We'll register the connection
        // once we receive the peer's ID frame back.
        const conn: PeerConnection = {
          peerId: '', // will be populated
          socket,
          recvBuffer: Buffer.alloc(0),
        };
        this.setupTcpFraming(conn, true);
        this.pendingConnections.delete(addrKey);
        resolve();
      });

      socket.on('error', (err) => {
        this.pendingConnections.delete(addrKey);
        reject(err);
      });
    });
  }

  /** Handle an incoming TCP connection from a remote peer. */
  private handleIncomingConnection(socket: net.Socket): void {
    const conn: PeerConnection = {
      peerId: '', // unknown until the peer sends its ID frame
      socket,
      recvBuffer: Buffer.alloc(0),
    };

    // The first framed message from the connecting side is the device ID.
    this.setupTcpFraming(conn, false);

    // Send our own ID back so the remote side can register us.
    const idFrame = Buffer.alloc(LENGTH_PREFIX_SIZE + DEVICE_ID_LENGTH);
    idFrame.writeUInt32BE(DEVICE_ID_LENGTH, 0);
    Buffer.from(this.deviceId).copy(idFrame, LENGTH_PREFIX_SIZE);
    socket.write(idFrame);
  }

  /**
   * Attach length-prefixed framing to a TCP connection.
   *
   * The first message on every connection is a 16-byte device ID used to
   * register the peer. All subsequent messages are serialized Packets.
   *
   * @param conn   The peer connection wrapper (mutated in place).
   * @param isInitiator  True if we initiated the connection.
   */
  private setupTcpFraming(conn: PeerConnection, isInitiator: boolean): void {
    let identified = false;

    conn.socket.on('data', (chunk: Buffer) => {
      conn.recvBuffer = Buffer.concat([conn.recvBuffer, chunk]);

      // Process as many complete frames as available
      while (conn.recvBuffer.length >= LENGTH_PREFIX_SIZE) {
        const frameLen = conn.recvBuffer.readUInt32BE(0);

        // Guard against absurdly large frames (16 MiB limit)
        if (frameLen > 16 * 1024 * 1024) {
          conn.socket.destroy(new Error('Frame too large'));
          return;
        }

        if (conn.recvBuffer.length < LENGTH_PREFIX_SIZE + frameLen) {
          break; // wait for more data
        }

        const frameData = conn.recvBuffer.subarray(
          LENGTH_PREFIX_SIZE,
          LENGTH_PREFIX_SIZE + frameLen,
        );
        conn.recvBuffer = Buffer.from(
          conn.recvBuffer.subarray(LENGTH_PREFIX_SIZE + frameLen),
        );

        if (!identified) {
          // First frame: device ID
          if (frameData.length !== DEVICE_ID_LENGTH) {
            conn.socket.destroy(new Error('Invalid identification frame'));
            return;
          }
          const peerId = deviceIdToHex(frameData);

          // Don't connect to ourselves
          if (peerId === this.deviceIdHex) {
            conn.socket.destroy();
            return;
          }

          // If we already have a connection to this peer, keep only one.
          // The tie-breaker: the side with the lexicographically smaller ID
          // keeps its *initiated* connection.
          const existingConn = this.connections.get(peerId);
          if (existingConn) {
            const weAreSmaller = this.deviceIdHex < peerId;
            if (isInitiator === weAreSmaller) {
              // We keep this connection; destroy the old one.
              existingConn.socket.destroy();
            } else {
              // We keep the existing connection; destroy this one.
              conn.socket.destroy();
              return;
            }
          }

          conn.peerId = peerId;
          this.connections.set(peerId, conn);
          identified = true;
        } else {
          // Subsequent frames: Packets
          try {
            const packet = deserializePacket(Buffer.from(frameData));
            this.receiveCallback?.(packet, conn.peerId);
          } catch {
            // Malformed packet — drop silently.
          }
        }
      }
    });

    conn.socket.on('close', () => {
      if (conn.peerId && this.connections.get(conn.peerId) === conn) {
        this.connections.delete(conn.peerId);
      }
    });

    conn.socket.on('error', () => {
      // Error is followed by close; cleanup happens there.
    });
  }

  // --------------------------------------------------------
  // Peer Queries
  // --------------------------------------------------------

  /** Return the list of peers discovered via UDP announcements. */
  getDiscoveredPeers(): Array<{ id: string; address: string; port: number }> {
    return Array.from(this.discoveredPeers.values()).map(({ id, address, port }) => ({
      id,
      address,
      port,
    }));
  }

  /** Return the IDs of peers with an active TCP connection. */
  getConnectedPeers(): string[] {
    return Array.from(this.connections.keys());
  }
}

export default LocalTransport;
