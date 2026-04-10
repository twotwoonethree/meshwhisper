// ============================================================
// MeshWhisper SDK — Packet Wire Serialization
// Pure functions with no platform-specific dependencies.
// Shared by WebSocketTransport (Node.js) and BrowserTransport.
//
// Binary layout (all big-endian):
//   [0]       version       u8
//   [1]       flags         u8
//   [2..9]    destHash      8 bytes
//   [10..25]  senderEphId   16 bytes
//   [26]      ttl           u8
//   [27..30]  payloadLen    u32
//   [31..]    encrypted payload
//
// Total header = 31 bytes.
// ============================================================

import type { Packet, PacketFlags } from '../../types.js';

export const HEADER_SIZE = 31;

export function serializePacket(packet: Packet): Uint8Array {
  const buf = new Uint8Array(HEADER_SIZE + packet.encryptedPayload.length);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  buf[0] = packet.version;
  buf[1] = packet.flags;
  buf.set(packet.destHash.subarray(0, 8), 2);
  buf.set(packet.senderEphemeralId.subarray(0, 16), 10);
  buf[26] = packet.ttl;
  view.setUint32(27, packet.payloadLength, false);
  buf.set(packet.encryptedPayload, HEADER_SIZE);

  return buf;
}

export function deserializePacket(data: Uint8Array): Packet {
  if (data.length < HEADER_SIZE) {
    throw new Error(`Packet too small: ${data.length} bytes (min ${HEADER_SIZE})`);
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const version = data[0];
  const flags = data[1] as PacketFlags;
  const destHash = data.slice(2, 10);
  const senderEphemeralId = data.slice(10, 26);
  const ttl = data[26];
  const payloadLength = view.getUint32(27, false);

  const encryptedPayload = data.slice(HEADER_SIZE, HEADER_SIZE + payloadLength);

  if (encryptedPayload.length !== payloadLength) {
    throw new Error(
      `Payload length mismatch: header says ${payloadLength}, got ${encryptedPayload.length}`,
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
