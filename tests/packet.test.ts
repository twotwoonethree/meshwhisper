import { describe, it, expect } from 'vitest';
import {
  encodePacket,
  decodePacket,
  createDataPacket,
  createAckPacket,
  createChaffPacket,
  createRouteRequestPacket,
  createRouteOfferPacket,
  createHandshakePacket,
  compressPayload,
  decompressPayload,
  PROTOCOL_VERSION,
  HEADER_SIZE,
  MAX_TTL,
  MAX_PAYLOAD_SIZE,
} from '../src/packet/index.js';
import { PacketFlags } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDestHash(): Uint8Array {
  return new Uint8Array(8).fill(0xab);
}

function makeSenderEph(): Uint8Array {
  return new Uint8Array(16).fill(0xcd);
}

function makePayload(len = 5): Uint8Array {
  const buf = new Uint8Array(len);
  for (let i = 0; i < len; i++) buf[i] = i & 0xff;
  return buf;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('Constants', () => {
  it('has correct protocol version', () => {
    expect(PROTOCOL_VERSION).toBe(0x01);
  });

  it('has correct header size', () => {
    expect(HEADER_SIZE).toBe(29);
  });

  it('has correct max TTL', () => {
    expect(MAX_TTL).toBe(7);
  });

  it('has correct max payload size', () => {
    expect(MAX_PAYLOAD_SIZE).toBe(65535);
  });
});

// ---------------------------------------------------------------------------
// Encode / Decode roundtrip
// ---------------------------------------------------------------------------

describe('encodePacket / decodePacket', () => {
  it('roundtrips a DATA packet', () => {
    const destHash = makeDestHash();
    const senderEph = makeSenderEph();
    const payload = makePayload(10);

    const pkt = createDataPacket(destHash, senderEph, payload, 5);
    const encoded = encodePacket(pkt);

    expect(encoded.length).toBe(HEADER_SIZE + payload.length);

    const decoded = decodePacket(encoded);
    expect(decoded.version).toBe(PROTOCOL_VERSION);
    expect(decoded.flags).toBe(PacketFlags.DATA);
    expect(decoded.destHash).toEqual(destHash);
    expect(decoded.senderEphemeralId).toEqual(senderEph);
    expect(decoded.ttl).toBe(5);
    expect(decoded.payloadLength).toBe(payload.length);
    expect(decoded.encryptedPayload).toEqual(payload);
  });

  it('roundtrips an empty-payload packet', () => {
    const pkt = createDataPacket(makeDestHash(), makeSenderEph(), new Uint8Array(0), 0);
    const decoded = decodePacket(encodePacket(pkt));
    expect(decoded.payloadLength).toBe(0);
    expect(decoded.encryptedPayload.length).toBe(0);
  });

  it('encodes payload_length as big-endian uint16', () => {
    const payload = makePayload(300);
    const pkt = createDataPacket(makeDestHash(), makeSenderEph(), payload, 3);
    const encoded = encodePacket(pkt);
    // Payload length bytes at offset 27-28 (big-endian)
    expect(encoded[27]).toBe(Math.floor(300 / 256)); // 0x01
    expect(encoded[28]).toBe(300 % 256);              // 0x2C
  });

  it('roundtrips all packet flag types', () => {
    const dh = makeDestHash();
    const se = makeSenderEph();
    const pl = makePayload();

    for (const builder of [
      () => createDataPacket(dh, se, pl),
      () => createAckPacket(dh, se, pl),
      () => createChaffPacket(se),
      () => createRouteRequestPacket(dh, se, pl),
      () => createRouteOfferPacket(dh, se, pl),
      () => createHandshakePacket(dh, se, pl),
    ]) {
      const pkt = builder();
      const decoded = decodePacket(encodePacket(pkt));
      expect(decoded.version).toBe(PROTOCOL_VERSION);
      expect(decoded.flags).toBe(pkt.flags);
    }
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('Validation', () => {
  it('rejects packets shorter than HEADER_SIZE', () => {
    expect(() => decodePacket(new Uint8Array(10))).toThrow(/too short/i);
  });

  it('rejects unknown protocol version on decode', () => {
    const buf = new Uint8Array(29);
    buf[0] = 0xff; // bad version
    buf[1] = PacketFlags.DATA;
    expect(() => decodePacket(buf)).toThrow(/version/i);
  });

  it('rejects invalid flags on decode', () => {
    const buf = new Uint8Array(29);
    buf[0] = PROTOCOL_VERSION;
    buf[1] = 0xff; // invalid flag
    expect(() => decodePacket(buf)).toThrow(/flags/i);
  });

  it('rejects truncated payload', () => {
    const pkt = createDataPacket(makeDestHash(), makeSenderEph(), makePayload(10));
    const encoded = encodePacket(pkt);
    const truncated = encoded.slice(0, HEADER_SIZE + 5); // only 5 of 10 payload bytes
    expect(() => decodePacket(truncated)).toThrow(/truncated/i);
  });

  it('rejects TTL > MAX_TTL in encoder', () => {
    expect(() =>
      createDataPacket(makeDestHash(), makeSenderEph(), makePayload(), 8),
    ).toThrow(/ttl/i);
  });

  it('rejects wrong destHash size', () => {
    expect(() =>
      createDataPacket(new Uint8Array(4), makeSenderEph(), makePayload()),
    ).toThrow(/8 bytes/i);
  });

  it('rejects wrong senderEphemeralId size', () => {
    expect(() =>
      createDataPacket(makeDestHash(), new Uint8Array(4), makePayload()),
    ).toThrow(/16 bytes/i);
  });
});

// ---------------------------------------------------------------------------
// Packet builders
// ---------------------------------------------------------------------------

describe('Packet builders', () => {
  it('createDataPacket defaults ttl to MAX_TTL', () => {
    const pkt = createDataPacket(makeDestHash(), makeSenderEph(), makePayload());
    expect(pkt.ttl).toBe(MAX_TTL);
  });

  it('createAckPacket sets ttl to 0', () => {
    const pkt = createAckPacket(makeDestHash(), makeSenderEph(), makePayload());
    expect(pkt.ttl).toBe(0);
    expect(pkt.flags).toBe(PacketFlags.ACK);
  });

  it('createChaffPacket produces random dest and payload', () => {
    const a = createChaffPacket(makeSenderEph());
    const b = createChaffPacket(makeSenderEph());
    expect(a.flags).toBe(PacketFlags.CHAFF);
    // Random content should differ (vanishingly small collision probability)
    const aEnc = encodePacket(a);
    const bEnc = encodePacket(b);
    expect(aEnc).not.toEqual(bEnc);
  });

  it('createRouteRequestPacket has ROUTE_REQUEST flag', () => {
    const pkt = createRouteRequestPacket(makeDestHash(), makeSenderEph(), makePayload());
    expect(pkt.flags).toBe(PacketFlags.ROUTE_REQUEST);
  });

  it('createRouteOfferPacket has ROUTE_OFFER flag', () => {
    const pkt = createRouteOfferPacket(makeDestHash(), makeSenderEph(), makePayload());
    expect(pkt.flags).toBe(PacketFlags.ROUTE_OFFER);
  });

  it('createHandshakePacket has HANDSHAKE flag', () => {
    const pkt = createHandshakePacket(makeDestHash(), makeSenderEph(), makePayload());
    expect(pkt.flags).toBe(PacketFlags.HANDSHAKE);
  });
});

// ---------------------------------------------------------------------------
// LZ4 compression
// ---------------------------------------------------------------------------

describe('LZ4 compression', () => {
  it('roundtrips data through compress/decompress', () => {
    const original = new Uint8Array(1000);
    for (let i = 0; i < original.length; i++) original[i] = i % 256;
    const compressed = compressPayload(original);
    const decompressed = decompressPayload(compressed);
    expect(decompressed).toEqual(original);
  });

  it('compresses repetitive data smaller than input', () => {
    const original = new Uint8Array(1000).fill(0x42);
    const compressed = compressPayload(original);
    expect(compressed.length).toBeLessThan(original.length);
  });

  it('handles empty input', () => {
    const compressed = compressPayload(new Uint8Array(0));
    const decompressed = decompressPayload(compressed);
    expect(decompressed).toEqual(new Uint8Array(0));
  });
});
