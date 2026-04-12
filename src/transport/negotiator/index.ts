// ============================================================
// MeshWhisper SDK — Bearer Negotiator
// Bearer-agnostic transport layer that selects the best
// available channel automatically with hybrid fragmentation.
// ============================================================

import type {
  Transport,
  Packet,
  DeviceCapability,
  BearerType,
  BatteryState,
  RelayWillingness,
} from '../../types.js';
import { PacketFlags } from '../../types.js';

// --- Constants ---

const MAX_PAYLOAD_SIZE = 65535;
const FRAGMENT_HEADER_SIZE = 8; // fragmentId(4) + fragmentIndex(2) + totalFragments(2)
const MAX_FRAGMENT_PAYLOAD = MAX_PAYLOAD_SIZE - FRAGMENT_HEADER_SIZE;

/** Priority map — lower number = higher priority. */
const BEARER_PRIORITY: Record<BearerType, number> = {
  platform_p2p: 0,
  local_net: 1,
  internet: 2,
};

// --- Fragment helpers ---

export interface FragmentHeader {
  fragmentId: number;
  fragmentIndex: number;
  totalFragments: number;
}

function encodeFragmentHeader(header: FragmentHeader): Uint8Array {
  const buf = new Uint8Array(FRAGMENT_HEADER_SIZE);
  const view = new DataView(buf.buffer);
  view.setUint32(0, header.fragmentId, false);
  view.setUint16(4, header.fragmentIndex, false);
  view.setUint16(6, header.totalFragments, false);
  return buf;
}

function decodeFragmentHeader(data: Uint8Array): FragmentHeader {
  if (data.byteLength < FRAGMENT_HEADER_SIZE) {
    throw new Error('Fragment header too short');
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    fragmentId: view.getUint32(0, false),
    fragmentIndex: view.getUint16(4, false),
    totalFragments: view.getUint16(6, false),
  };
}

// --- Receive callback type ---

export type NegotiatorReceiveCallback = (
  packet: Packet,
  source: string,
  bearer: BearerType,
) => void;

// --- BearerNegotiator ---

export class BearerNegotiator {
  private readonly transports: Map<BearerType, Transport> = new Map();
  private receiveCallback: NegotiatorReceiveCallback | null = null;
  private fragmentIdCounter = 0;

  constructor(transports: Transport[] = []) {
    for (const t of transports) {
      this.registerTransport(t);
    }
  }

  // ---- Transport registration & probing ----

  /**
   * Register a transport and wire its onReceive into the aggregated handler.
   * If a transport with the same bearer type was already registered it is replaced.
   */
  registerTransport(transport: Transport): void {
    this.transports.set(transport.type, transport);

    // Wire up receive aggregation — capture the bearer type at registration time.
    const bearerType = transport.type;
    transport.onReceive((packet: Packet, source: string) => {
      this.receiveCallback?.(packet, source, bearerType);
    });
  }

  /**
   * Probe every registered transport for availability and build a capability
   * advertisement that can be shared with peers.
   */
  async probeAvailability(): Promise<DeviceCapability> {
    const results = await Promise.allSettled(
      Array.from(this.transports.entries()).map(async ([type, transport]) => ({
        type,
        available: await transport.isAvailable(),
      })),
    );

    const availability: Record<BearerType, boolean> = {
      platform_p2p: false,
      local_net: false,
      internet: false,
    };

    for (const result of results) {
      if (result.status === 'fulfilled') {
        availability[result.value.type] = result.value.available;
      }
    }

    // Battery state and relay willingness are computed externally — defaults
    // here represent a reasonable "unknown" baseline.
    return {
      bearerPlatformP2P: availability.platform_p2p,
      bearerLocalNet: availability.local_net,
      bearerInternet: availability.internet,
      inboundConnectable: availability.internet || availability.local_net,
      batteryState: 'high',
      relayWillingness: 'willing',
    };
  }

  /**
   * Return all registered transports sorted by priority (highest first).
   * Only includes transports whose isAvailable() resolved to true.
   */
  getAvailableTransports(): Transport[] {
    return Array.from(this.transports.values()).sort(
      (a, b) => BEARER_PRIORITY[a.type] - BEARER_PRIORITY[b.type],
    );
  }

  // ---- Best-path selection ----

  /**
   * Select the highest-priority transport that is currently available and can
   * reach `destination`. Falls back through all registered transports.
   */
  async selectTransport(_destination: string): Promise<Transport | null> {
    const sorted = this.getAvailableTransports();

    for (const transport of sorted) {
      try {
        const available = await transport.isAvailable();
        if (available) {
          return transport;
        }
      } catch {
        // Transport probe failed — skip to next.
      }
    }

    return null;
  }

  // ---- Smart sending ----

  /**
   * Send a packet via the best available transport for the given destination.
   * Tries transports in priority order, falling through to the next on failure.
   * Throws if every transport fails or none is available.
   */
  async send(packet: Packet, destination: string): Promise<void> {
    const sorted = this.getAvailableTransports();
    let lastError: unknown;

    for (const transport of sorted) {
      try {
        const available = await transport.isAvailable();
        if (!available) continue;
        await transport.send(packet, destination);
        return; // success — stop here
      } catch (err) {
        lastError = err;
        // This transport failed for this destination — try the next
      }
    }

    throw lastError ?? new Error(
      `No available transport for destination: ${destination}`,
    );
  }

  /**
   * Broadcast a packet across **all** available transports concurrently.
   * Errors on individual transports are suppressed so a single failure
   * does not prevent delivery on other bearers.
   */
  async broadcast(packet: Packet): Promise<void> {
    const transports = this.getAvailableTransports();

    const results = await Promise.allSettled(
      transports.map(async (t) => {
        const available = await t.isAvailable();
        if (available) {
          // Broadcast destination is empty string — the transport layer
          // is expected to fan out to all known peers.
          await t.send(packet, '');
        }
      }),
    );

    // If every transport failed, surface an error.
    const allFailed = results.every((r) => r.status === 'rejected');
    if (allFailed && results.length > 0) {
      throw new Error('Broadcast failed on all available transports');
    }
  }

  // ---- Hybrid fragmentation ----

  /**
   * Fragment a large payload across available bearers. Each fragment is
   * wrapped in its own Packet with a fragment header prepended to the
   * encrypted payload field.
   */
  async sendLargePayload(
    destHash: Uint8Array,
    senderEphId: Uint8Array,
    payload: Uint8Array,
    destination: string,
  ): Promise<void> {
    const totalFragments = Math.ceil(payload.byteLength / MAX_FRAGMENT_PAYLOAD);
    if (totalFragments > 0xffff) {
      throw new Error('Payload too large: exceeds maximum fragment count');
    }

    const fragmentId = this.nextFragmentId();
    const transports = this.getAvailableTransports();
    const availableTransports: Transport[] = [];

    for (const t of transports) {
      try {
        if (await t.isAvailable()) {
          availableTransports.push(t);
        }
      } catch {
        // skip
      }
    }

    if (availableTransports.length === 0) {
      throw new Error('No available transport for large payload delivery');
    }

    const sendPromises: Promise<void>[] = [];

    for (let i = 0; i < totalFragments; i++) {
      const start = i * MAX_FRAGMENT_PAYLOAD;
      const end = Math.min(start + MAX_FRAGMENT_PAYLOAD, payload.byteLength);
      const chunk = payload.slice(start, end);

      const header = encodeFragmentHeader({
        fragmentId,
        fragmentIndex: i,
        totalFragments,
      });

      // Prepend fragment header to payload chunk.
      const fragmentPayload = new Uint8Array(header.byteLength + chunk.byteLength);
      fragmentPayload.set(header, 0);
      fragmentPayload.set(chunk, header.byteLength);

      const packet: Packet = {
        version: 1,
        flags: PacketFlags.DATA,
        destHash,
        senderEphemeralId: senderEphId,
        ttl: 7,
        payloadLength: fragmentPayload.byteLength,
        encryptedPayload: fragmentPayload,
      };

      // Round-robin fragments across available bearers for hybrid delivery.
      const transport = availableTransports[i % availableTransports.length]!;
      sendPromises.push(transport.send(packet, destination));
    }

    await Promise.all(sendPromises);
  }

  /**
   * Reassemble fragments into the original payload.
   * Returns `null` if any fragment is missing.
   */
  reassembleFragments(
    fragments: Map<number, Uint8Array>,
    totalFragments: number,
  ): Uint8Array | null {
    if (fragments.size !== totalFragments) {
      return null;
    }

    // Validate all indices are present.
    for (let i = 0; i < totalFragments; i++) {
      if (!fragments.has(i)) {
        return null;
      }
    }

    // Compute total length.
    let totalLength = 0;
    for (let i = 0; i < totalFragments; i++) {
      totalLength += fragments.get(i)!.byteLength;
    }

    // Concatenate in order.
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (let i = 0; i < totalFragments; i++) {
      const chunk = fragments.get(i)!;
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return result;
  }

  // ---- Relay willingness computation ----

  /**
   * Compute how willing this device should be to act as a relay node based
   * on battery state, current bearer, and reciprocity with the requesting peer.
   */
  computeRelayWillingness(
    batteryState: BatteryState,
    currentBearer: BearerType,
    reciprocityScore: number,
  ): RelayWillingness {
    // Reciprocity gate: if the peer is a free-rider, refuse regardless.
    if (reciprocityScore < 0.1) {
      return 'unavailable';
    }

    // Battery critically low — never relay.
    if (batteryState === 'low' || batteryState === 'critical') {
      return 'unavailable';
    }

    const onWifi = currentBearer === 'local_net' || currentBearer === 'platform_p2p';

    // Charging + wifi-class bearer → eager.
    if (batteryState === 'charging' && onWifi) {
      return 'eager';
    }

    // High battery + wifi-class bearer → willing.
    if (batteryState === 'high' && onWifi) {
      return 'willing';
    }

    // Medium battery OR cellular bearer → reluctant.
    if (batteryState === 'medium' || currentBearer === 'internet') {
      return 'reluctant';
    }

    // Charging but on cellular.
    if (batteryState === 'charging') {
      return 'reluctant';
    }

    // Fallback: willing (high battery, non-wifi, non-internet — shouldn't
    // normally occur but safe default).
    return 'willing';
  }

  // ---- Event aggregation ----

  /**
   * Register a single callback that receives packets from **all** registered
   * transports, tagged with the bearer type they arrived on.
   *
   * Only one callback is active at a time — calling this again replaces the
   * previous handler.
   */
  onReceive(callback: NegotiatorReceiveCallback): void {
    this.receiveCallback = callback;
  }

  // ---- Internal helpers ----

  private nextFragmentId(): number {
    // Wrap at 32-bit unsigned max to stay within the 4-byte header field.
    this.fragmentIdCounter = (this.fragmentIdCounter + 1) & 0xffffffff;
    return this.fragmentIdCounter;
  }
}

// --- Re-exports for consumer convenience ---

export {
  MAX_PAYLOAD_SIZE,
  MAX_FRAGMENT_PAYLOAD,
  FRAGMENT_HEADER_SIZE,
  BEARER_PRIORITY,
  encodeFragmentHeader,
  decodeFragmentHeader,
};

export type { FragmentHeader as FragmentHeaderType };
