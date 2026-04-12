// ============================================================
// MeshWhisper SDK — Node Transport
// Connects the SDK to a MeshWhisper Node (relay + directory).
// All traffic flows through the Node WebSocket endpoint; the
// Node routes packets by destination hash and buffers blobs
// for offline recipients.
// ============================================================

import { WebSocket, type RawData } from 'ws';
import type { Transport, Packet, PushConfig } from '../../types.js';
import {
  serializePacket,
  deserializePacket,
  HEADER_SIZE,
} from '../websocket/serialize.js';

// ---- Constants ----

/** Foundation-hosted relay nodes. Used when node config is "mesh". */
export const FOUNDATION_RELAY_NODES = [
  'wss://relay.meshwhisper.io', // TODO: deploy actual Foundation nodes
];

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

// ---- NodeTransport ----

/**
 * Transport that connects to a MeshWhisper Node for relay and
 * store-and-forward delivery.
 *
 * Sends a `hello` control message on connect to register the device's
 * current destination hashes. The Node then routes incoming packets
 * to the registered hashes and delivers any queued blobs.
 *
 * All outbound packets are forwarded to the Node regardless of the
 * `destination` argument — the packet's destHash header field is what
 * the Node uses for routing.
 */
export class NodeTransport implements Transport {
  readonly type = 'internet' as const;

  private ws: WebSocket | null = null;
  private receiveCallbacks: Array<(packet: Packet, source: string) => void> = [];
  private running = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private onStatusChange?: (status: 'connected' | 'disconnected') => void;

  /**
   * @param nodeUrl - The WebSocket URL of the Node, or "mesh" for Foundation nodes.
   * @param getDestHashes - Callback returning the device's current dest hashes
   *   as hex strings. Called on every (re)connect so the Node always has
   *   up-to-date hashes.
   * @param pushConfig - Optional push token to register with the Node so it can
   *   wake the device via APNs/FCM when a message arrives while offline.
   * @param onStatusChange - Called when connection to the Node changes.
   */
  constructor(
    private readonly nodeUrl: string,
    private readonly getDestHashes: () => string[],
    private pushConfig?: PushConfig,
    onStatusChange?: (status: 'connected' | 'disconnected') => void,
  ) {
    this.onStatusChange = onStatusChange;
  }

  // ---- Transport interface ----

  async start(): Promise<void> {
    this.running = true;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      // Use terminate() rather than close() so the TCP connection drops
      // immediately.  close() initiates a graceful WebSocket close handshake
      // that completes asynchronously — the relay keeps the client registered
      // until the handshake finishes, causing a race where the relay forwards
      // packets to a "shutting down" socket instead of storing them.
      this.ws.terminate();
      this.ws = null;
    }
  }

  async isAvailable(): Promise<boolean> {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async send(packet: Packet, _destination: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('NodeTransport: not connected to Node');
    }
    const binary = serializePacket(packet);
    return new Promise<void>((resolve, reject) => {
      this.ws!.send(binary, { binary: true }, (err) => {
        if (err) reject(new Error(`NodeTransport send failed: ${err.message}`));
        else resolve();
      });
    });
  }

  onReceive(callback: (packet: Packet, source: string) => void): void {
    this.receiveCallbacks.push(callback);
  }

  // ---- Connection management ----

  private resolveUrl(): string {
    if (this.nodeUrl === 'mesh') {
      return FOUNDATION_RELAY_NODES[0];
    }
    return this.nodeUrl;
  }

  private connect(): Promise<void> {
    const url = this.resolveUrl();

    return new Promise<void>((resolve, reject) => {
      let resolved = false;

      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';

      ws.on('open', () => {
        this.ws = ws;
        this.reconnectAttempt = 0;
        resolved = true;
        ws.send(JSON.stringify(this.buildHello()));
        this.onStatusChange?.('connected');
        resolve();
      });

      ws.on('message', (raw: RawData) => {
        this.handleMessage(raw);
      });

      ws.on('close', () => {
        this.ws = null;
        this.onStatusChange?.('disconnected');
        if (this.running) this.scheduleReconnect();
      });

      ws.on('error', (err: Error) => {
        if (!resolved) {
          resolved = true;
          reject(new Error(`NodeTransport: failed to connect to ${url}: ${err.message}`));
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(async () => {
      if (!this.running) return;
      try {
        await this.connect();
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  // ---- Message handling ----

  private handleMessage(raw: RawData): void {
    // Binary messages are relay packets
    if (raw instanceof ArrayBuffer && raw.byteLength >= HEADER_SIZE) {
      try {
        const packet = deserializePacket(new Uint8Array(raw));
        const source = this.resolveUrl();
        for (const cb of this.receiveCallbacks) {
          try { cb(packet, source); } catch { /* swallow */ }
        }
      } catch {
        // Malformed packet — discard
      }
      return;
    }

    // JSON messages from the Node (informational; no action needed in v1)
    if (typeof raw === 'string' || raw instanceof Buffer) {
      try {
        JSON.parse(raw.toString());
        // Reserved for future Node→client control messages
      } catch { /* not JSON */ }
    }
  }

  // ---- Dest hash refresh ----

  /**
   * Re-registers the device's destination hashes with the Node.
   * Call this when the epoch hour rolls over and hashes rotate.
   */
  refreshDestHashes(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(this.buildHello()));
  }

  /**
   * Update the push token (e.g. after APNs/FCM issues a new token).
   * Re-registers with the Node immediately if connected.
   */
  setPushConfig(pushConfig: PushConfig | undefined): void {
    this.pushConfig = pushConfig;
    this.refreshDestHashes();
  }

  // ---- Private helpers ----

  private buildHello(): object {
    const msg: Record<string, unknown> = {
      type: 'hello',
      destHashes: this.getDestHashes(),
    };
    if (this.pushConfig) {
      msg['pushPlatform'] = this.pushConfig.platform;
      if (this.pushConfig.platform === 'webpush') {
        msg['pushSubscription'] = JSON.stringify(this.pushConfig.subscription);
      } else {
        msg['pushToken'] = this.pushConfig.token;
        if (this.pushConfig.platform === 'apns' && this.pushConfig.topic) {
          msg['pushTopic'] = this.pushConfig.topic;
        }
      }
    }
    return msg;
  }
}
