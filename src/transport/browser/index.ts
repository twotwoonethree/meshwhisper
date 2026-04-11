// ============================================================
// MeshWhisper SDK — Browser Transport
// Connects the SDK to a MeshWhisper Node using the native
// browser WebSocket API. Drop-in replacement for NodeTransport
// when running in a browser or PWA context.
// ============================================================

import type { Transport, Packet, PushConfig } from '../../types.js';
import {
  serializePacket,
  deserializePacket,
  HEADER_SIZE,
} from '../websocket/serialize.js';

// ---- Constants ----

/** Foundation-hosted relay nodes. Used when node config is "mesh". */
export const FOUNDATION_RELAY_NODES = [
  'wss://relay.meshwhisper.io',
];

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

// ---- BrowserTransport ----

/**
 * Transport that connects to a MeshWhisper Node using the native browser
 * WebSocket API. Functionally identical to NodeTransport but uses
 * `globalThis.WebSocket` instead of the `ws` npm package, so it bundles
 * cleanly for browsers and PWAs.
 */
export class BrowserTransport implements Transport {
  readonly type = 'internet' as const;

  private ws: WebSocket | null = null;
  private receiveCallbacks: Array<(packet: Packet, source: string) => void> = [];
  private running = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private onStatusChange?: (status: 'connected' | 'disconnected') => void;

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
      this.ws.close(1000, 'shutdown');
      this.ws = null;
    }
  }

  async isAvailable(): Promise<boolean> {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async send(packet: Packet, _destination: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('BrowserTransport: not connected to Node');
    }
    const binary = serializePacket(packet);
    this.ws.send(binary);
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

      ws.addEventListener('open', () => {
        this.ws = ws;
        this.reconnectAttempt = 0;
        resolved = true;
        ws.send(JSON.stringify(this.buildHello()));
        this.onStatusChange?.('connected');
        resolve();
      });

      ws.addEventListener('message', (event: MessageEvent) => {
        this.handleMessage(event.data);
      });

      ws.addEventListener('close', () => {
        this.ws = null;
        this.onStatusChange?.('disconnected');
        if (this.running) this.scheduleReconnect();
      });

      ws.addEventListener('error', () => {
        if (!resolved) {
          resolved = true;
          reject(new Error(`BrowserTransport: failed to connect to ${url}`));
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

  private handleMessage(data: unknown): void {
    if (data instanceof ArrayBuffer && data.byteLength >= HEADER_SIZE) {
      try {
        const packet = deserializePacket(new Uint8Array(data));
        const source = this.resolveUrl();
        for (const cb of this.receiveCallbacks) {
          try { cb(packet, source); } catch { /* swallow */ }
        }
      } catch {
        // Malformed packet — discard
      }
      return;
    }

    if (typeof data === 'string') {
      try {
        JSON.parse(data);
        // Reserved for future Node→client control messages
      } catch { /* not JSON */ }
    }
  }

  // ---- Dest hash / push token refresh ----

  refreshDestHashes(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(this.buildHello()));
  }

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
      if (this.pushConfig.platform === 'webpush') {
        msg['pushSubscription'] = JSON.stringify(this.pushConfig.subscription);
        msg['pushPlatform'] = 'webpush';
      } else {
        msg['pushToken'] = this.pushConfig.token;
        msg['pushPlatform'] = this.pushConfig.platform;
        if ('topic' in this.pushConfig && this.pushConfig.topic) {
          msg['pushTopic'] = this.pushConfig.topic;
        }
      }
    }
    return msg;
  }
}
