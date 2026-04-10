// ============================================================
// MeshWhisper SDK — WebSocket Transport
// Primary internet transport over HTTPS port 443.
// Connectable devices run a WS server; non-connectable devices
// maintain outbound WS connections to connectable peers.
// ============================================================

import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { IncomingMessage } from 'node:http';
import type {
  Transport,
  Packet,
} from '../../types.js';
import {
  serializePacket,
  deserializePacket,
  HEADER_SIZE,
} from './serialize.js';

// ---- Constants ----

const DEFAULT_PORT = 443;
const DEV_FALLBACK_PORT = 8443;
const HEARTBEAT_INTERVAL_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;

// ---- Transport Events ----

export type WebSocketTransportEventType =
  | 'peer_connected'
  | 'peer_disconnected'
  | 'error';

export interface PeerConnectedEvent {
  peerId: string;
  address: string;
  direction: 'inbound' | 'outbound';
}

export interface PeerDisconnectedEvent {
  peerId: string;
  code: number;
  reason: string;
}

export interface TransportErrorEvent {
  peerId?: string;
  error: Error;
  context: string;
}

export type WebSocketTransportEvent =
  | { type: 'peer_connected'; data: PeerConnectedEvent }
  | { type: 'peer_disconnected'; data: PeerDisconnectedEvent }
  | { type: 'error'; data: TransportErrorEvent };

type EventHandler = (event: WebSocketTransportEvent) => void;

// ---- Peer Connection State ----

interface PeerConnection {
  peerId: string;
  socket: WebSocket;
  direction: 'inbound' | 'outbound';
  address: string;
  connectedAt: number;
  lastActivity: number;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  pongTimer?: ReturnType<typeof setTimeout>;
  alive: boolean;
}

// ---- Reconnect State (outbound only) ----

interface ReconnectState {
  address: string;
  attempt: number;
  timer?: ReturnType<typeof setTimeout>;
  cancelled: boolean;
}

// ---- WebSocketTransport ----

export class WebSocketTransport implements Transport {
  readonly type = 'internet' as const;

  private server: WebSocketServer | null = null;
  private serverPort: number | null = null;
  private peers: Map<string, PeerConnection> = new Map();
  private reconnectStates: Map<string, ReconnectState> = new Map();
  private receiveCallbacks: Array<(packet: Packet, source: string) => void> = [];
  private eventHandlers: Set<EventHandler> = new Set();
  private running = false;

  // ---- Transport interface ----

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;

    // Cancel all reconnect timers
    for (const state of this.reconnectStates.values()) {
      state.cancelled = true;
      if (state.timer) clearTimeout(state.timer);
    }
    this.reconnectStates.clear();

    // Close all peer connections
    const peerIds = [...this.peers.keys()];
    for (const peerId of peerIds) {
      this.disconnectPeer(peerId);
    }

    // Shut down server
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      this.server = null;
      this.serverPort = null;
    }
  }

  async isAvailable(): Promise<boolean> {
    return this.running;
  }

  async send(packet: Packet, destination: string): Promise<void> {
    const peer = this.peers.get(destination);
    if (!peer) {
      throw new Error(`No connection to peer: ${destination}`);
    }
    if (peer.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`Connection to peer ${destination} is not open (state=${peer.socket.readyState})`);
    }

    const binary = serializePacket(packet);

    return new Promise<void>((resolve, reject) => {
      peer.socket.send(binary, { binary: true }, (err) => {
        if (err) {
          reject(new Error(`Failed to send to ${destination}: ${err.message}`));
        } else {
          peer.lastActivity = Date.now();
          resolve();
        }
      });
    });
  }

  onReceive(callback: (packet: Packet, source: string) => void): void {
    this.receiveCallbacks.push(callback);
  }

  // ---- Event system ----

  on(handler: EventHandler): void {
    this.eventHandlers.add(handler);
  }

  off(handler: EventHandler): void {
    this.eventHandlers.delete(handler);
  }

  private emit(event: WebSocketTransportEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        // Swallow listener errors to protect transport stability
      }
    }
  }

  // ---- Server mode (connectable) ----

  async startServer(port?: number): Promise<void> {
    if (this.server) {
      throw new Error('WebSocket server already running');
    }

    const targetPort = port ?? DEFAULT_PORT;

    try {
      await this.listenOnPort(targetPort);
    } catch (err) {
      // If default port 443 fails (permission / in-use), fall back to 8443
      if (!port && targetPort === DEFAULT_PORT) {
        await this.listenOnPort(DEV_FALLBACK_PORT);
      } else {
        throw err;
      }
    }

    this.running = true;
  }

  private listenOnPort(port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const wss = new WebSocketServer({ port }, () => {
        this.server = wss;
        this.serverPort = port;
        resolve();
      });

      wss.on('error', (err) => {
        // If we haven't assigned this.server yet, this is a startup error
        if (!this.server) {
          reject(err);
          return;
        }
        this.emit({
          type: 'error',
          data: { error: err instanceof Error ? err : new Error(String(err)), context: 'server' },
        });
      });

      wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
        this.handleInboundConnection(socket, req);
      });
    });
  }

  private handleInboundConnection(socket: WebSocket, req: IncomingMessage): void {
    const remoteAddr =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
      req.socket.remoteAddress ??
      'unknown';
    const remotePort = req.socket.remotePort ?? 0;
    const address = `${remoteAddr}:${remotePort}`;

    // Derive a peer ID from the first message (protocol-level peer identification)
    // For now, use address as temporary ID until a proper handshake message arrives.
    // The caller can re-map peer IDs after handshake.
    const peerId = address;

    const conn: PeerConnection = {
      peerId,
      socket,
      direction: 'inbound',
      address,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      alive: true,
    };

    this.peers.set(peerId, conn);
    this.startHeartbeat(conn);

    socket.binaryType = 'arraybuffer';

    socket.on('message', (raw: RawData) => {
      this.handleMessage(raw, peerId);
    });

    socket.on('close', (code: number, reason: Buffer) => {
      this.cleanupPeer(peerId, code, reason.toString('utf-8'));
    });

    socket.on('error', (err: Error) => {
      this.emit({
        type: 'error',
        data: { peerId, error: err, context: 'inbound_connection' },
      });
    });

    socket.on('pong', () => {
      conn.alive = true;
      conn.lastActivity = Date.now();
      if (conn.pongTimer) {
        clearTimeout(conn.pongTimer);
        conn.pongTimer = undefined;
      }
    });

    this.emit({
      type: 'peer_connected',
      data: { peerId, address, direction: 'inbound' },
    });
  }

  // ---- Client mode (non-connectable) ----

  async connectToPeer(address: string): Promise<void> {
    // Normalize address to a ws:// URL if not already
    const url = this.normalizeAddress(address);
    const peerId = address;

    if (this.peers.has(peerId)) {
      throw new Error(`Already connected to peer: ${peerId}`);
    }

    // Cancel any existing reconnect for this peer
    this.cancelReconnect(peerId);

    await this.establishConnection(peerId, url);
  }

  private normalizeAddress(address: string): string {
    if (address.startsWith('ws://') || address.startsWith('wss://')) {
      return address;
    }
    // Default to wss:// (port 443)
    return `wss://${address}`;
  }

  private establishConnection(peerId: string, url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.binaryType = 'arraybuffer';

      let resolved = false;

      socket.on('open', () => {
        resolved = true;

        const conn: PeerConnection = {
          peerId,
          socket,
          direction: 'outbound',
          address: url,
          connectedAt: Date.now(),
          lastActivity: Date.now(),
          alive: true,
        };

        this.peers.set(peerId, conn);
        this.startHeartbeat(conn);

        // Reset reconnect state on successful connect
        this.cancelReconnect(peerId);

        socket.on('message', (raw: RawData) => {
          this.handleMessage(raw, peerId);
        });

        socket.on('close', (code: number, reason: Buffer) => {
          this.cleanupPeer(peerId, code, reason.toString('utf-8'));
          this.scheduleReconnect(peerId, url);
        });

        socket.on('error', (err: Error) => {
          this.emit({
            type: 'error',
            data: { peerId, error: err, context: 'outbound_connection' },
          });
        });

        socket.on('pong', () => {
          const c = this.peers.get(peerId);
          if (c) {
            c.alive = true;
            c.lastActivity = Date.now();
            if (c.pongTimer) {
              clearTimeout(c.pongTimer);
              c.pongTimer = undefined;
            }
          }
        });

        this.emit({
          type: 'peer_connected',
          data: { peerId, address: url, direction: 'outbound' },
        });

        resolve();
      });

      socket.on('error', (err: Error) => {
        if (!resolved) {
          resolved = true;
          reject(new Error(`Failed to connect to ${url}: ${err.message}`));
        }
      });
    });
  }

  // ---- Reconnect with exponential backoff ----

  private scheduleReconnect(peerId: string, url: string): void {
    if (!this.running) return;

    let state = this.reconnectStates.get(peerId);
    if (!state) {
      state = { address: url, attempt: 0, cancelled: false };
      this.reconnectStates.set(peerId, state);
    }

    if (state.cancelled) return;

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, state.attempt),
      RECONNECT_MAX_MS,
    );
    state.attempt++;

    state.timer = setTimeout(async () => {
      if (state!.cancelled || !this.running) return;

      try {
        await this.establishConnection(peerId, url);
      } catch {
        // establishConnection failed — schedule another attempt
        this.scheduleReconnect(peerId, url);
      }
    }, delay);
  }

  private cancelReconnect(peerId: string): void {
    const state = this.reconnectStates.get(peerId);
    if (state) {
      state.cancelled = true;
      if (state.timer) clearTimeout(state.timer);
      this.reconnectStates.delete(peerId);
    }
  }

  // ---- Heartbeat / keepalive ----

  private startHeartbeat(conn: PeerConnection): void {
    conn.heartbeatTimer = setInterval(() => {
      if (!conn.alive) {
        // Previous ping was not answered — terminate
        conn.socket.terminate();
        return;
      }
      conn.alive = false;
      conn.socket.ping();

      // Set a pong timeout — if no pong within PONG_TIMEOUT_MS, terminate
      conn.pongTimer = setTimeout(() => {
        if (!conn.alive) {
          conn.socket.terminate();
        }
      }, PONG_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(conn: PeerConnection): void {
    if (conn.heartbeatTimer) {
      clearInterval(conn.heartbeatTimer);
      conn.heartbeatTimer = undefined;
    }
    if (conn.pongTimer) {
      clearTimeout(conn.pongTimer);
      conn.pongTimer = undefined;
    }
  }

  // ---- Message handling ----

  private handleMessage(raw: RawData, source: string): void {
    const peer = this.peers.get(source);
    if (peer) {
      peer.lastActivity = Date.now();
    }

    let data: Uint8Array;
    if (raw instanceof ArrayBuffer) {
      data = new Uint8Array(raw);
    } else if (raw instanceof Buffer) {
      data = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    } else if (Array.isArray(raw)) {
      data = new Uint8Array(Buffer.concat(raw));
    } else {
      this.emit({
        type: 'error',
        data: {
          peerId: source,
          error: new Error('Received non-binary message'),
          context: 'message_handling',
        },
      });
      return;
    }

    let packet: Packet;
    try {
      packet = deserializePacket(data);
    } catch (err) {
      this.emit({
        type: 'error',
        data: {
          peerId: source,
          error: err instanceof Error ? err : new Error(String(err)),
          context: 'deserialization',
        },
      });
      return;
    }

    for (const callback of this.receiveCallbacks) {
      try {
        callback(packet, source);
      } catch {
        // Swallow callback errors
      }
    }
  }

  // ---- Peer management ----

  getPeers(): string[] {
    return [...this.peers.keys()];
  }

  isConnected(peerId: string): boolean {
    const peer = this.peers.get(peerId);
    return peer !== undefined && peer.socket.readyState === WebSocket.OPEN;
  }

  disconnect(peerId: string): void {
    this.disconnectPeer(peerId);
  }

  private disconnectPeer(peerId: string): void {
    this.cancelReconnect(peerId);

    const peer = this.peers.get(peerId);
    if (!peer) return;

    this.stopHeartbeat(peer);

    if (
      peer.socket.readyState === WebSocket.OPEN ||
      peer.socket.readyState === WebSocket.CONNECTING
    ) {
      peer.socket.close(1000, 'disconnect');
    }

    this.peers.delete(peerId);

    this.emit({
      type: 'peer_disconnected',
      data: { peerId, code: 1000, reason: 'local_disconnect' },
    });
  }

  private cleanupPeer(peerId: string, code: number, reason: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    this.stopHeartbeat(peer);
    this.peers.delete(peerId);

    this.emit({
      type: 'peer_disconnected',
      data: { peerId, code, reason },
    });
  }

  // ---- Broadcast ----

  async broadcast(packet: Packet): Promise<void> {
    const binary = serializePacket(packet);
    const errors: Error[] = [];

    const promises = [...this.peers.entries()].map(
      ([peerId, peer]) =>
        new Promise<void>((resolve) => {
          if (peer.socket.readyState !== WebSocket.OPEN) {
            resolve();
            return;
          }
          peer.socket.send(binary, { binary: true }, (err) => {
            if (err) {
              errors.push(
                new Error(`Broadcast to ${peerId} failed: ${err.message}`),
              );
            } else {
              peer.lastActivity = Date.now();
            }
            resolve();
          });
        }),
    );

    await Promise.all(promises);

    if (errors.length > 0 && errors.length === this.peers.size) {
      throw new AggregateError(errors, 'Broadcast failed to all peers');
    }
  }

  // ---- Connectability detection ----

  async detectConnectability(port?: number): Promise<boolean> {
    const testPort = port ?? DEFAULT_PORT;

    return new Promise<boolean>((resolve) => {
      let testServer: WebSocketServer | null = null;

      const cleanup = () => {
        if (testServer) {
          testServer.close();
          testServer = null;
        }
      };

      try {
        testServer = new WebSocketServer({ port: testPort }, () => {
          // We were able to bind — port is available locally.
          // A full connectability check would also verify external
          // reachability (e.g., via a coordination server or self-connect),
          // but binding success is the necessary first condition.
          cleanup();
          resolve(true);
        });

        testServer.on('error', () => {
          cleanup();
          resolve(false);
        });
      } catch {
        cleanup();
        resolve(false);
      }
    });
  }

  // ---- Accessors ----

  getServerPort(): number | null {
    return this.serverPort;
  }

  isServerRunning(): boolean {
    return this.server !== null;
  }

  getPeerInfo(peerId: string): Readonly<Omit<PeerConnection, 'socket' | 'heartbeatTimer' | 'pongTimer'>> | null {
    const peer = this.peers.get(peerId);
    if (!peer) return null;
    return {
      peerId: peer.peerId,
      direction: peer.direction,
      address: peer.address,
      connectedAt: peer.connectedAt,
      lastActivity: peer.lastActivity,
      alive: peer.alive,
    };
  }
}

// ---- Exports ----

export { serializePacket, deserializePacket, HEADER_SIZE };

export type {
  PeerConnection,
  ReconnectState,
};
