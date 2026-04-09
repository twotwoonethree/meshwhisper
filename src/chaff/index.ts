// ============================================================
// MeshWhisper SDK — Chaff Generator & Traffic Analysis Defense
// Emits a constant stream of encrypted chaff packets that are
// byte-for-byte indistinguishable from real encrypted messages,
// defeating traffic analysis as described in PRD section 8.4.
// ============================================================

import { Packet, PacketFlags, ChaffRate, RelayWillingness } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Destination hash length in bytes (truncated BLAKE3). */
const DEST_HASH_LENGTH = 8;

/** Sender ephemeral ID length in bytes. */
const SENDER_EPHEMERAL_ID_LENGTH = 16;

/** Packet version used across the SDK. */
const PACKET_VERSION = 1;

/** Default minimum chaff payload size in bytes. */
const DEFAULT_MIN_PACKET_SIZE = 32;

/** Default maximum chaff payload size in bytes. */
const DEFAULT_MAX_PACKET_SIZE = 256;

/** Default burst variance (0.0-1.0). */
const DEFAULT_BURST_VARIANCE = 0.3;

/** Base emission intervals per rate, in milliseconds. */
const RATE_INTERVALS: Record<ChaffRate, number> = {
  low: 60_000,    // ~1 packet / 60 s  → ~1 KB/h
  normal: 30_000, // ~1 packet / 30 s  → ~2 KB/h
  high: 10_000,   // ~1 packet / 10 s  → ~6 KB/h
};

/** Maps relay willingness to the appropriate chaff rate. */
const WILLINGNESS_TO_RATE: Record<RelayWillingness, ChaffRate | null> = {
  eager: 'high',
  willing: 'normal',
  reluctant: 'low',
  unavailable: null,
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ChaffOptions {
  /** Emission rate preset. */
  rate: ChaffRate;
  /** Maximum chaff payload size in bytes. Defaults to 256. */
  maxPacketSize?: number;
  /** Minimum chaff payload size in bytes. Defaults to 32. */
  minPacketSize?: number;
  /** Randomness applied to inter-packet timing (0.0-1.0). Defaults to 0.3. */
  burstVariance?: number;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export interface ChaffStats {
  packetsGenerated: number;
  bytesGenerated: number;
  /** Elapsed time since start() was first called, in milliseconds. */
  uptime: number;
  currentRate: ChaffRate;
}

// ---------------------------------------------------------------------------
// Crypto helpers (isomorphic: works in Node.js and browsers)
// ---------------------------------------------------------------------------

/**
 * Fill a Uint8Array with cryptographically secure random bytes.
 * Uses globalThis.crypto (Web Crypto) when available, otherwise
 * falls back to Node.js crypto module.
 */
function secureRandomBytes(length: number): Uint8Array {
  const buf = new Uint8Array(length);

  if (typeof globalThis !== 'undefined' && globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(buf);
  } else {
    // Node.js environments where globalThis.crypto may not exist (older Node)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeCrypto = require('node:crypto') as typeof import('node:crypto');
    nodeCrypto.randomFillSync(buf);
  }

  return buf;
}

/**
 * Return a uniformly distributed random integer in [min, max] (inclusive).
 */
function randomInt(min: number, max: number): number {
  const range = max - min + 1;
  const bytes = secureRandomBytes(4);
  const value = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  return min + (value % range);
}

/**
 * Return a random floating-point value in [0, 1).
 */
function randomFloat(): number {
  const bytes = secureRandomBytes(4);
  const value = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  return value / 0x1_0000_0000;
}

// ---------------------------------------------------------------------------
// ChaffGenerator
// ---------------------------------------------------------------------------

export class ChaffGenerator {
  private readonly minPacketSize: number;
  private readonly maxPacketSize: number;
  private readonly burstVariance: number;

  private rate: ChaffRate;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private startedAt: number | null = null;

  private packetsGenerated = 0;
  private bytesGenerated = 0;

  private emitCallback: ((packet: Packet) => void) | null = null;

  constructor(options?: ChaffOptions) {
    this.rate = options?.rate ?? 'normal';
    this.minPacketSize = options?.minPacketSize ?? DEFAULT_MIN_PACKET_SIZE;
    this.maxPacketSize = options?.maxPacketSize ?? DEFAULT_MAX_PACKET_SIZE;
    this.burstVariance = Math.max(0, Math.min(1, options?.burstVariance ?? DEFAULT_BURST_VARIANCE));
  }

  // -----------------------------------------------------------------------
  // Packet generation
  // -----------------------------------------------------------------------

  /**
   * Generate a single chaff packet.
   *
   * The packet is constructed to be byte-for-byte indistinguishable from
   * a real encrypted message to any external observer: all variable-length
   * fields are filled with cryptographically random data, the flags field
   * is set to CHAFF (which the local node recognises but a relay treats
   * identically to DATA), and the TTL is kept low so chaff doesn't
   * propagate far.
   */
  generateChaffPacket(): Packet {
    const payloadSize = randomInt(this.minPacketSize, this.maxPacketSize);
    return this.buildChaffPacket(payloadSize);
  }

  // -----------------------------------------------------------------------
  // Emission scheduling
  // -----------------------------------------------------------------------

  /** Begin emitting chaff on a jittered schedule. */
  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.startedAt === null) {
      this.startedAt = Date.now();
    }
    this.scheduleNext();
  }

  /** Stop chaff emission. */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Whether the generator is currently emitting. */
  isRunning(): boolean {
    return this.running;
  }

  // -----------------------------------------------------------------------
  // Rate control
  // -----------------------------------------------------------------------

  /** Change the emission rate. Takes effect on the next scheduling cycle. */
  setRate(rate: ChaffRate): void {
    this.rate = rate;
  }

  /**
   * Automatically adjust the chaff rate based on the device's relay
   * willingness setting.
   *
   * - eager       → high
   * - willing     → normal
   * - reluctant   → low
   * - unavailable → stop entirely
   */
  adaptToRelayWillingness(willingness: RelayWillingness): void {
    const mapped = WILLINGNESS_TO_RATE[willingness];
    if (mapped === null) {
      this.stop();
      return;
    }
    this.rate = mapped;
    // If already running, let the current timer expire naturally — the
    // new rate will be picked up on the next scheduling cycle.
  }

  // -----------------------------------------------------------------------
  // Real message camouflage
  // -----------------------------------------------------------------------

  /**
   * Surround a real packet with 0-2 chaff packets whose payload sizes
   * approximate the real packet's size, making it harder for an observer
   * to distinguish the real message in a burst.
   *
   * Returns an array of 1-3 packets with the real packet placed at a
   * random position.
   */
  camouflageRealMessage(realPacket: Packet): Packet[] {
    const chaffCount = randomInt(0, 2);
    if (chaffCount === 0) return [realPacket];

    const realSize = realPacket.encryptedPayload.length;

    // Build chaff with sizes close (±20%) to the real payload.
    const sizeFloor = Math.max(1, Math.round(realSize * 0.8));
    const sizeCeil = Math.round(realSize * 1.2);
    const chaffPackets: Packet[] = [];
    for (let i = 0; i < chaffCount; i++) {
      const size = randomInt(sizeFloor, sizeCeil);
      chaffPackets.push(this.buildChaffPacket(size));
    }

    // Insert the real packet at a random position in the burst.
    const insertionIndex = randomInt(0, chaffPackets.length);
    chaffPackets.splice(insertionIndex, 0, realPacket);

    return chaffPackets;
  }

  // -----------------------------------------------------------------------
  // Callback registration
  // -----------------------------------------------------------------------

  /**
   * Register a callback that receives each generated chaff packet.
   * The transport layer will call this to enqueue chaff for sending.
   */
  onChaffGenerated(callback: (packet: Packet) => void): void {
    this.emitCallback = callback;
  }

  // -----------------------------------------------------------------------
  // Statistics
  // -----------------------------------------------------------------------

  /** Return runtime statistics for monitoring / diagnostics. */
  getStats(): ChaffStats {
    return {
      packetsGenerated: this.packetsGenerated,
      bytesGenerated: this.bytesGenerated,
      uptime: this.startedAt !== null ? Date.now() - this.startedAt : 0,
      currentRate: this.rate,
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Build a chaff packet with the given payload size.
   */
  private buildChaffPacket(payloadSize: number): Packet {
    const encryptedPayload = secureRandomBytes(payloadSize);
    const packet: Packet = {
      version: PACKET_VERSION,
      flags: PacketFlags.CHAFF,
      destHash: secureRandomBytes(DEST_HASH_LENGTH),
      senderEphemeralId: secureRandomBytes(SENDER_EPHEMERAL_ID_LENGTH),
      ttl: randomInt(1, 3),
      payloadLength: payloadSize,
      encryptedPayload,
    };

    this.packetsGenerated++;
    this.bytesGenerated += payloadSize;

    return packet;
  }

  /**
   * Compute the next emission delay in milliseconds, adding jitter
   * proportional to burstVariance so inter-packet timing is not
   * predictable.
   */
  private computeNextDelay(): number {
    const base = RATE_INTERVALS[this.rate];
    const jitterRange = base * this.burstVariance;
    // Uniform jitter in [-jitterRange, +jitterRange]
    const jitter = (randomFloat() * 2 - 1) * jitterRange;
    return Math.max(1, Math.round(base + jitter));
  }

  /**
   * Schedule the next chaff emission.
   */
  private scheduleNext(): void {
    if (!this.running) return;

    const delay = this.computeNextDelay();
    this.timer = setTimeout(() => {
      if (!this.running) return;

      const packet = this.generateChaffPacket();
      if (this.emitCallback) {
        this.emitCallback(packet);
      }

      this.scheduleNext();
    }, delay);

    // Prevent the timer from keeping the process alive in Node.js.
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      (this.timer as NodeJS.Timeout).unref();
    }
  }
}
