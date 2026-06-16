// ============================================================
// Onion layer crypto — ADR-010 stage-3+ (transit-hop privacy)
//
// Proves the core property directly on the sealing primitives: each relay on
// the path peels EXACTLY its own layer and learns ONLY the next hop — never the
// final destination or the packet. A middle hop's view is provably blind to the
// last hop's identity and to the payload.
// ============================================================

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { generateOnionKeypair, sealOnion, openOnion, type OnionHop } from '../node/src/onion.js';

function mkRelay() {
  const onion = generateOnionKeypair();
  // A relay's routing id (federation pubkey) is independent of its onion key.
  const pubkey = randomBytes(32).toString('hex');
  return { hop: { pubkey, onionKey: onion.publicKeyHex } as OnionHop, priv: onion.privatePkcs8Base64 };
}

describe('Onion layer crypto (ADR-010 transit privacy)', () => {
  it('peels one layer per hop, each seeing only the next hop, packet recovered at the end', () => {
    const r1 = mkRelay(); const r2 = mkRelay(); const dest = mkRelay();
    const packet = Buffer.from('the opaque ciphertext packet with a destHash header');

    const onion = sealOnion([r1.hop, r2.hop, dest.hop], packet);

    // Hop 1 peels its layer → learns only r2, gets an opaque inner.
    const l1 = openOnion(r1.priv, onion);
    expect(l1?.type).toBe('forward');
    if (l1?.type !== 'forward') throw new Error('unreachable');
    expect(l1.next).toBe(r2.hop.pubkey);

    // Hop 2 peels → learns only dest.
    const l2 = openOnion(r2.priv, l1.inner);
    expect(l2?.type).toBe('forward');
    if (l2?.type !== 'forward') throw new Error('unreachable');
    expect(l2.next).toBe(dest.hop.pubkey);

    // Destination peels the final layer → recovers the packet exactly.
    const l3 = openOnion(dest.priv, l2.inner);
    expect(l3?.type).toBe('deliver');
    expect(Buffer.compare(l3!.inner, packet)).toBe(0);
  });

  it("a middle hop is blind to the final destination and the packet", () => {
    const r1 = mkRelay(); const r2 = mkRelay(); const dest = mkRelay();
    const packet = Buffer.from('SECRET-PAYLOAD-AABBCCDD');
    const onion = sealOnion([r1.hop, r2.hop, dest.hop], packet);

    const l1 = openOnion(r1.priv, onion);
    if (l1?.type !== 'forward') throw new Error('expected forward');

    // Everything r1 can see: the next hop (r2) and an opaque blob. Prove that
    // blob contains neither the destination's id nor the packet in the clear.
    const visible = Buffer.concat([Buffer.from(l1.next, 'hex'), l1.inner]);
    expect(visible.includes(Buffer.from(dest.hop.pubkey, 'hex'))).toBe(false);
    expect(visible.includes(packet)).toBe(false);
    expect(visible.includes(Buffer.from('SECRET-PAYLOAD'))).toBe(false);
  });

  it("a hop cannot open a layer that isn't addressed to it", () => {
    const r1 = mkRelay(); const dest = mkRelay(); const stranger = mkRelay();
    const onion = sealOnion([r1.hop, dest.hop], Buffer.from('x'));
    // The outer layer is sealed to r1; a stranger's key cannot open it.
    expect(openOnion(stranger.priv, onion)).toBeNull();
  });

  it('a single-hop onion delivers directly', () => {
    const dest = mkRelay();
    const packet = Buffer.from('direct');
    const out = openOnion(dest.priv, sealOnion([dest.hop], packet));
    expect(out?.type).toBe('deliver');
    expect(Buffer.compare(out!.inner, packet)).toBe(0);
  });
});
