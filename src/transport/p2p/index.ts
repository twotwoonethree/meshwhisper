// ============================================================
// MeshWhisper SDK — Platform P2P Transport
// Abstract bridge for native P2P (Apple Multipeer Connectivity,
// Google Nearby Connections) with TypeScript-side Transport
// wrapper.  Native SDKs implement PlatformP2PBridge; this module
// provides the Transport adapter and a no-op fallback for
// environments where native P2P is unavailable.
// ============================================================

import type { Packet, Transport, PacketFlags } from '../../types.js';

// ---- Bridge Interfaces ----

/**
 * Metadata about a discovered P2P peer.
 * Provided by the native layer during discovery.
 */
export interface PeerInfo {
  /** Human-readable name for the peer device. */
  displayName: string;
  /** The service identifier under which this peer was discovered. */
  serviceId: string;
  /** Advertised capabilities (e.g. "relay", "store-forward"). */
  capabilities: string[];
}

/**
 * Abstract interface that native platform code (Swift / Kotlin)
 * must implement to provide P2P connectivity to the TypeScript SDK.
 *
 * - iOS: backed by Apple Multipeer Connectivity Framework
 *        (BLE discovery + Wi-Fi Direct data transfer).
 * - Android: backed by Google Nearby Connections API
 *            (Bluetooth + Wi-Fi).
 *
 * All methods are designed to be thin wrappers around the native
 * APIs so the bridge implementation stays minimal.
 */
export interface PlatformP2PBridge {
  /** Begin advertising this device for the given service. */
  startAdvertising(serviceId: string): Promise<void>;

  /** Begin scanning for peers advertising the given service. */
  startDiscovery(serviceId: string): Promise<void>;

  /** Stop advertising. */
  stopAdvertising(): Promise<void>;

  /** Stop discovery scanning. */
  stopDiscovery(): Promise<void>;

  /** Send raw bytes to a connected peer. */
  sendData(peerId: string, data: Uint8Array): Promise<void>;

  /** Register a callback invoked when a new peer is discovered. */
  onPeerDiscovered(callback: (peerId: string, info: PeerInfo) => void): void;

  /** Register a callback invoked when a previously discovered peer is lost. */
  onPeerLost(callback: (peerId: string) => void): void;

  /** Register a callback invoked when data is received from a peer. */
  onDataReceived(callback: (peerId: string, data: Uint8Array) => void): void;

  /** Returns the IDs of all currently connected peers. */
  getConnectedPeers(): string[];

  /**
   * Returns true if the underlying native P2P framework is
   * available on this device / OS version.
   */
  isSupported(): boolean;
}

// ---- Packet Serialization ----

/**
 * Minimum header size in bytes:
 *   version (1) + flags (1) + destHash (8) + senderEphemeralId (16)
 *   + ttl (1) + payloadLength (4) = 31
 */
const HEADER_SIZE = 31;

/**
 * Serializes a Packet into a compact binary format for transmission
 * over the native P2P bridge.
 *
 * Wire format (big-endian):
 *   [0]      u8   version
 *   [1]      u8   flags
 *   [2..9]   8B   destHash
 *   [10..25] 16B  senderEphemeralId
 *   [26]     u8   ttl
 *   [27..30] u32  payloadLength
 *   [31..]   var  encryptedPayload
 */
function serializePacket(packet: Packet): Uint8Array {
  const totalLength = HEADER_SIZE + packet.encryptedPayload.length;
  const buffer = new Uint8Array(totalLength);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  let offset = 0;

  // version (u8)
  view.setUint8(offset, packet.version);
  offset += 1;

  // flags (u8)
  view.setUint8(offset, packet.flags as number);
  offset += 1;

  // destHash (8 bytes)
  buffer.set(packet.destHash, offset);
  offset += 8;

  // senderEphemeralId (16 bytes)
  buffer.set(packet.senderEphemeralId, offset);
  offset += 16;

  // ttl (u8)
  view.setUint8(offset, packet.ttl);
  offset += 1;

  // payloadLength (u32 big-endian)
  view.setUint32(offset, packet.payloadLength, false);
  offset += 4;

  // encryptedPayload
  buffer.set(packet.encryptedPayload, offset);

  return buffer;
}

/**
 * Deserializes a Uint8Array back into a Packet.
 * Throws if the data is too short or the payload length mismatches.
 */
function deserializePacket(data: Uint8Array): Packet {
  if (data.length < HEADER_SIZE) {
    throw new Error(
      `P2P: packet too short (${data.length} bytes, need at least ${HEADER_SIZE})`,
    );
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  const version = view.getUint8(offset);
  offset += 1;

  const flags = view.getUint8(offset) as PacketFlags;
  offset += 1;

  const destHash = data.slice(offset, offset + 8);
  offset += 8;

  const senderEphemeralId = data.slice(offset, offset + 16);
  offset += 16;

  const ttl = view.getUint8(offset);
  offset += 1;

  const payloadLength = view.getUint32(offset, false);
  offset += 4;

  const encryptedPayload = data.slice(offset, offset + payloadLength);
  if (encryptedPayload.length !== payloadLength) {
    throw new Error(
      `P2P: payload length mismatch (header says ${payloadLength}, got ${encryptedPayload.length})`,
    );
  }

  return {
    version,
    flags,
    destHash,
    senderEphemeralId,
    ttl,
    payloadLength,
    encryptedPayload,
  };
}

// ---- No-Op Bridge ----

/**
 * Default bridge used when no native implementation is registered.
 * All methods are safe no-ops.  isSupported() returns false so the
 * transport layer knows to skip this bearer.
 */
class NoOpBridge implements PlatformP2PBridge {
  async startAdvertising(_serviceId: string): Promise<void> {}
  async startDiscovery(_serviceId: string): Promise<void> {}
  async stopAdvertising(): Promise<void> {}
  async stopDiscovery(): Promise<void> {}
  async sendData(_peerId: string, _data: Uint8Array): Promise<void> {}
  onPeerDiscovered(_callback: (peerId: string, info: PeerInfo) => void): void {}
  onPeerLost(_callback: (peerId: string) => void): void {}
  onDataReceived(_callback: (peerId: string, data: Uint8Array) => void): void {}
  getConnectedPeers(): string[] {
    return [];
  }
  isSupported(): boolean {
    return false;
  }
}

// ---- Bridge Registry ----

/** The currently registered bridge (defaults to NoOpBridge). */
let activeBridge: PlatformP2PBridge = new NoOpBridge();

/**
 * Registers a platform-specific P2P bridge implementation.
 *
 * Called by native code (via JSI on React Native, or similar
 * interop layers) to inject the real Multipeer / Nearby
 * Connections wrapper at runtime.
 *
 * @param bridge - The native bridge implementation.
 */
export function registerPlatformBridge(bridge: PlatformP2PBridge): void {
  activeBridge = bridge;
}

// ---- Service ID Generation ----

/** Max length for Bonjour / NSD service types. */
const MAX_SERVICE_ID_LENGTH = 15;

/**
 * Generates a platform-appropriate service identifier from an
 * application namespace string.
 *
 * Both Apple Multipeer Connectivity and Android NSD impose
 * restrictions on service type identifiers (length, allowed
 * characters).  This function produces a short, deterministic,
 * lowercase-alphanumeric ID derived from the namespace.
 *
 * @param namespace - The application namespace (e.g. "com.example.chat").
 * @returns A service ID string safe for both iOS and Android.
 */
export function generateServiceId(namespace: string): string {
  // Simple FNV-1a 32-bit hash for determinism without heavy deps.
  let h = 0x811c9dc5;
  for (let i = 0; i < namespace.length; i++) {
    h ^= namespace.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Unsigned conversion then base-36 for compact alphanumeric output.
  const hashStr = (h >>> 0).toString(36);
  // Prefix with "mw-" (MeshWhisper) for readability, truncate to limit.
  const serviceId = `mw-${hashStr}`;
  return serviceId.slice(0, MAX_SERVICE_ID_LENGTH);
}

// ---- Transport Implementation ----

/**
 * PlatformP2PTransport adapts a PlatformP2PBridge into the
 * SDK's Transport interface.
 *
 * When a native bridge has been registered via
 * `registerPlatformBridge()`, this transport serializes Packets
 * to wire bytes, sends them through the bridge, and
 * deserializes incoming bytes back into Packets for the mesh
 * router.
 *
 * When no bridge is registered, the transport reports itself
 * as unavailable and all operations are safe no-ops.
 */
export class PlatformP2PTransport implements Transport {
  readonly type = 'platform_p2p' as const;

  private readonly serviceId: string;
  private receiveCallback: ((packet: Packet, source: string) => void) | null = null;
  private running = false;

  /**
   * @param namespace - Application namespace used to derive
   *   the P2P service identifier.
   */
  constructor(namespace: string) {
    this.serviceId = generateServiceId(namespace);
  }

  /**
   * Returns the bridge currently in use.  Reads from the
   * module-level registry so that bridges registered after
   * construction are picked up automatically.
   */
  private get bridge(): PlatformP2PBridge {
    return activeBridge;
  }

  // ---- Transport interface ----

  async isAvailable(): Promise<boolean> {
    return this.bridge.isSupported();
  }

  async start(): Promise<void> {
    if (this.running) return;

    if (!this.bridge.isSupported()) {
      // Silently skip — the transport negotiator will use
      // the next bearer in priority order.
      return;
    }

    // Wire up data reception.
    this.bridge.onDataReceived((peerId: string, data: Uint8Array) => {
      if (!this.receiveCallback) return;
      try {
        const packet = deserializePacket(data);
        this.receiveCallback(packet, peerId);
      } catch {
        // Malformed packet — drop silently.  A production build
        // may want to emit a diagnostic event here.
      }
    });

    await this.bridge.startAdvertising(this.serviceId);
    await this.bridge.startDiscovery(this.serviceId);
    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    await this.bridge.stopAdvertising();
    await this.bridge.stopDiscovery();
    this.running = false;
  }

  async send(packet: Packet, destination: string): Promise<void> {
    if (!this.running || !this.bridge.isSupported()) return;

    const data = serializePacket(packet);
    await this.bridge.sendData(destination, data);
  }

  onReceive(callback: (packet: Packet, source: string) => void): void {
    this.receiveCallback = callback;
  }
}
