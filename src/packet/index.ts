// ============================================================
// MeshWhisper SDK — Binary Packet Codec
// Encodes/decodes the wire format defined in PRD section 9.
// ============================================================

import { Packet, PacketFlags } from '../types.js';
import lz4 from 'lz4js';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Current protocol wire version. */
export const PROTOCOL_VERSION = 0x01;

/** Fixed header size in bytes (version + flags + dest_hash + sender_eph_id + ttl + payload_length). */
export const HEADER_SIZE = 29;

/** Maximum hop count. */
export const MAX_TTL = 7;

/** Maximum encrypted payload size (uint16 max). */
export const MAX_PAYLOAD_SIZE = 65535;

// Internal field offsets within the header.
const OFF_VERSION = 0;
const OFF_FLAGS = 1;
const OFF_DEST_HASH = 2;
const OFF_SENDER_EPH_ID = 10; // 2 + 8
const OFF_TTL = 26;           // 10 + 16
const OFF_PAYLOAD_LEN = 27;   // 26 + 1

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function assertUint8Array(value: Uint8Array, expectedLen: number, name: string): void {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${name} must be a Uint8Array`);
  }
  if (value.length !== expectedLen) {
    throw new RangeError(`${name} must be exactly ${expectedLen} bytes, got ${value.length}`);
  }
}

function assertValidFlags(flags: number): asserts flags is PacketFlags {
  const valid: number[] = [
    PacketFlags.DATA,
    PacketFlags.ACK,
    PacketFlags.CHAFF,
    PacketFlags.HANDSHAKE,
    PacketFlags.ROUTE_REQUEST,
    PacketFlags.ROUTE_OFFER,
  ];
  if (!valid.includes(flags)) {
    throw new RangeError(`Invalid packet flags: 0x${flags.toString(16).padStart(2, '0')}`);
  }
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/**
 * Serialize a {@link Packet} into its binary wire representation.
 *
 * Layout (29-byte header + variable payload):
 * | version (1) | flags (1) | dest_hash (8) | sender_ephemeral_id (16) | ttl (1) | payload_length (2 BE) | encrypted_payload (N) |
 */
export function encodePacket(packet: Packet): Uint8Array {
  // --- Field validation ---
  if (packet.version !== PROTOCOL_VERSION) {
    throw new RangeError(`Unsupported protocol version: ${packet.version}`);
  }

  assertValidFlags(packet.flags);
  assertUint8Array(packet.destHash, 8, 'destHash');
  assertUint8Array(packet.senderEphemeralId, 16, 'senderEphemeralId');

  if (!Number.isInteger(packet.ttl) || packet.ttl < 0 || packet.ttl > MAX_TTL) {
    throw new RangeError(`ttl must be an integer between 0 and ${MAX_TTL}, got ${packet.ttl}`);
  }

  if (!(packet.encryptedPayload instanceof Uint8Array)) {
    throw new TypeError('encryptedPayload must be a Uint8Array');
  }

  if (packet.encryptedPayload.length > MAX_PAYLOAD_SIZE) {
    throw new RangeError(
      `encryptedPayload exceeds maximum size of ${MAX_PAYLOAD_SIZE} bytes (got ${packet.encryptedPayload.length})`,
    );
  }

  // --- Serialise ---
  const payloadLen = packet.encryptedPayload.length;
  const buf = new Uint8Array(HEADER_SIZE + payloadLen);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  buf[OFF_VERSION] = packet.version;
  buf[OFF_FLAGS] = packet.flags;
  buf.set(packet.destHash, OFF_DEST_HASH);
  buf.set(packet.senderEphemeralId, OFF_SENDER_EPH_ID);
  buf[OFF_TTL] = packet.ttl;
  view.setUint16(OFF_PAYLOAD_LEN, payloadLen, false); // big-endian
  buf.set(packet.encryptedPayload, HEADER_SIZE);

  return buf;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * Deserialize a binary buffer into a {@link Packet}.
 *
 * @throws on malformed input (too short, wrong version, invalid flags, length mismatch).
 */
export function decodePacket(data: Uint8Array): Packet {
  if (!(data instanceof Uint8Array)) {
    throw new TypeError('data must be a Uint8Array');
  }

  if (data.length < HEADER_SIZE) {
    throw new RangeError(
      `Packet too short: expected at least ${HEADER_SIZE} bytes, got ${data.length}`,
    );
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const version = data[OFF_VERSION];
  if (version !== PROTOCOL_VERSION) {
    throw new RangeError(`Unsupported protocol version: ${version}`);
  }

  const flags = data[OFF_FLAGS];
  assertValidFlags(flags);

  const destHash = data.slice(OFF_DEST_HASH, OFF_DEST_HASH + 8);
  const senderEphemeralId = data.slice(OFF_SENDER_EPH_ID, OFF_SENDER_EPH_ID + 16);
  const ttl = data[OFF_TTL];

  if (ttl > MAX_TTL) {
    throw new RangeError(`ttl exceeds maximum of ${MAX_TTL}: got ${ttl}`);
  }

  const payloadLength = view.getUint16(OFF_PAYLOAD_LEN, false); // big-endian

  if (data.length < HEADER_SIZE + payloadLength) {
    throw new RangeError(
      `Packet truncated: header declares ${payloadLength} payload bytes, but only ${data.length - HEADER_SIZE} available`,
    );
  }

  const encryptedPayload = data.slice(HEADER_SIZE, HEADER_SIZE + payloadLength);

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

// ---------------------------------------------------------------------------
// LZ4 Compression (applied to plaintext BEFORE encryption)
// ---------------------------------------------------------------------------

/**
 * Compress a plaintext payload with LZ4 (frame format).
 */
export function compressPayload(plaintext: Uint8Array): Uint8Array {
  if (!(plaintext instanceof Uint8Array)) {
    throw new TypeError('plaintext must be a Uint8Array');
  }
  // lz4js.compress returns a Buffer/Uint8Array of the compressed frame.
  const compressed: Uint8Array = lz4.compress(plaintext);
  return new Uint8Array(compressed);
}

/**
 * Decompress an LZ4 compressed payload back to plaintext.
 */
export function decompressPayload(compressed: Uint8Array): Uint8Array {
  if (!(compressed instanceof Uint8Array)) {
    throw new TypeError('compressed must be a Uint8Array');
  }
  const decompressed: Uint8Array = lz4.decompress(compressed);
  return new Uint8Array(decompressed);
}

// ---------------------------------------------------------------------------
// Packet builders
// ---------------------------------------------------------------------------

/**
 * Build a DATA packet.
 *
 * @param destHash          8-byte truncated BLAKE3 destination hash
 * @param senderEphId       16-byte rotating ephemeral sender identifier
 * @param payload           Encrypted payload bytes
 * @param ttl               Hop count (0-7, defaults to {@link MAX_TTL})
 */
export function createDataPacket(
  destHash: Uint8Array,
  senderEphId: Uint8Array,
  payload: Uint8Array,
  ttl: number = MAX_TTL,
): Packet {
  return buildPacket(PacketFlags.DATA, destHash, senderEphId, payload, ttl);
}

/**
 * Build an ACK packet (ttl fixed at 0 since ACKs are single-hop).
 */
export function createAckPacket(
  destHash: Uint8Array,
  senderEphId: Uint8Array,
  ackPayload: Uint8Array,
): Packet {
  return buildPacket(PacketFlags.ACK, destHash, senderEphId, ackPayload, 0);
}

/**
 * Build a CHAFF (cover-traffic) packet with random destination and payload.
 *
 * The payload length is randomly chosen between 32 and 256 bytes to mimic
 * realistic traffic without being trivially distinguishable.
 */
export function createChaffPacket(senderEphId: Uint8Array): Packet {
  const destHash = randomUint8Array(8);
  const payloadLen = 32 + (randomUint8Array(1)[0] % 225); // 32..256
  const payload = randomUint8Array(payloadLen);
  return buildPacket(PacketFlags.CHAFF, destHash, senderEphId, payload, 0);
}

/**
 * Build a ROUTE_REQUEST packet.
 */
export function createRouteRequestPacket(
  destHash: Uint8Array,
  senderEphId: Uint8Array,
  requestPayload: Uint8Array,
): Packet {
  return buildPacket(PacketFlags.ROUTE_REQUEST, destHash, senderEphId, requestPayload, MAX_TTL);
}

/**
 * Build a ROUTE_OFFER packet.
 */
export function createRouteOfferPacket(
  destHash: Uint8Array,
  senderEphId: Uint8Array,
  offerPayload: Uint8Array,
): Packet {
  return buildPacket(PacketFlags.ROUTE_OFFER, destHash, senderEphId, offerPayload, MAX_TTL);
}

/**
 * Build a HANDSHAKE packet.
 */
export function createHandshakePacket(
  destHash: Uint8Array,
  senderEphId: Uint8Array,
  handshakePayload: Uint8Array,
): Packet {
  return buildPacket(PacketFlags.HANDSHAKE, destHash, senderEphId, handshakePayload, MAX_TTL);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildPacket(
  flags: PacketFlags,
  destHash: Uint8Array,
  senderEphId: Uint8Array,
  encryptedPayload: Uint8Array,
  ttl: number,
): Packet {
  assertUint8Array(destHash, 8, 'destHash');
  assertUint8Array(senderEphId, 16, 'senderEphemeralId');

  if (!Number.isInteger(ttl) || ttl < 0 || ttl > MAX_TTL) {
    throw new RangeError(`ttl must be an integer between 0 and ${MAX_TTL}, got ${ttl}`);
  }

  if (!(encryptedPayload instanceof Uint8Array)) {
    throw new TypeError('payload must be a Uint8Array');
  }

  if (encryptedPayload.length > MAX_PAYLOAD_SIZE) {
    throw new RangeError(
      `Payload exceeds maximum size of ${MAX_PAYLOAD_SIZE} bytes (got ${encryptedPayload.length})`,
    );
  }

  return {
    version: PROTOCOL_VERSION,
    flags,
    destHash,
    senderEphemeralId: senderEphId,
    ttl,
    payloadLength: encryptedPayload.length,
    encryptedPayload,
  };
}

/**
 * Generate a Uint8Array filled with cryptographically secure random bytes.
 */
function randomUint8Array(length: number): Uint8Array {
  // Works in both Node.js and browser contexts.
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.getRandomValues === 'function') {
    const buf = new Uint8Array(length);
    globalThis.crypto.getRandomValues(buf);
    return buf;
  }
  // Fallback: Node.js crypto module (already imported).
  return new Uint8Array(randomBytes(length));
}
