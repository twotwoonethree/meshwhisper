// ============================================================
// Multi-device phase B — device announcement wire format
//
// Tests the signed announcement primitive that propagates a new
// (or revoked) device for an account. The SDK's inbound handler
// applies these to PermissionManager; here we exercise the
// signature contract directly without spinning up the full SDK.
// ============================================================

import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import {
  buildCanonicalDeviceAddedMessage,
  buildCanonicalDeviceRevokedMessage,
  verifyDeviceAnnouncementSignature,
} from '../src/sdk/index.js';

function mintKey(): { sk: Uint8Array; pk: Uint8Array; pkHex: string } {
  const sk = ed25519.utils.randomPrivateKey();
  const pk = ed25519.getPublicKey(sk);
  return { sk, pk, pkHex: Buffer.from(pk).toString('hex') };
}

function signAdded(
  signer: { sk: Uint8Array; pkHex: string },
  newDeviceKeyHex: string,
  eventAt = Date.now(),
) {
  const msg = buildCanonicalDeviceAddedMessage(signer.pkHex, newDeviceKeyHex, eventAt);
  const sig = ed25519.sign(msg, signer.sk);
  return {
    accountKey: signer.pkHex,
    deviceKey: newDeviceKeyHex,
    eventAt,
    signature: Buffer.from(sig).toString('base64'),
  };
}

function signRevoked(
  signer: { sk: Uint8Array; pkHex: string },
  revokedDeviceKeyHex: string,
  eventAt = Date.now(),
) {
  const msg = buildCanonicalDeviceRevokedMessage(signer.pkHex, revokedDeviceKeyHex, eventAt);
  const sig = ed25519.sign(msg, signer.sk);
  return {
    accountKey: signer.pkHex,
    deviceKey: revokedDeviceKeyHex,
    eventAt,
    signature: Buffer.from(sig).toString('base64'),
  };
}

describe('Canonical message bytes', () => {
  it('device_added canonical bytes are stable and version-tagged', () => {
    const got = buildCanonicalDeviceAddedMessage('acc1', 'dev1', 12345);
    expect(new TextDecoder().decode(got)).toBe(
      'meshwhisper.device-added.v1\nacc1\ndev1\n12345',
    );
  });

  it('device_revoked canonical bytes are stable and version-tagged', () => {
    const got = buildCanonicalDeviceRevokedMessage('acc1', 'dev1', 12345);
    expect(new TextDecoder().decode(got)).toBe(
      'meshwhisper.device-revoked.v1\nacc1\ndev1\n12345',
    );
  });

  it('different parameters produce different bytes', () => {
    const a = buildCanonicalDeviceAddedMessage('acc1', 'dev1', 100);
    const b = buildCanonicalDeviceAddedMessage('acc1', 'dev2', 100);
    const c = buildCanonicalDeviceAddedMessage('acc1', 'dev1', 101);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(false);
  });

  it('added and revoked variants are not interchangeable', () => {
    const a = buildCanonicalDeviceAddedMessage('acc1', 'dev1', 100);
    const r = buildCanonicalDeviceRevokedMessage('acc1', 'dev1', 100);
    expect(Buffer.from(a).equals(Buffer.from(r))).toBe(false);
  });
});

describe('verifyDeviceAnnouncementSignature', () => {
  it('accepts a valid device_added announcement', () => {
    const alice = mintKey();
    const newDevice = mintKey();
    const ann = signAdded(alice, newDevice.pkHex);
    expect(verifyDeviceAnnouncementSignature('device_added', ann)).toBe(true);
  });

  it('accepts a valid device_revoked announcement', () => {
    const alice = mintKey();
    const revoked = mintKey();
    const ann = signRevoked(alice, revoked.pkHex);
    expect(verifyDeviceAnnouncementSignature('device_revoked', ann)).toBe(true);
  });

  it('rejects when signed by a different key', () => {
    const alice = mintKey();
    const eve = mintKey();
    const newDevice = mintKey();
    // Eve signs, but claims to be alice — verification against
    // ann.accountKey (alice) fails because eve's signature doesn't
    // verify against alice's public key.
    const msg = buildCanonicalDeviceAddedMessage(alice.pkHex, newDevice.pkHex, Date.now());
    const sig = ed25519.sign(msg, eve.sk);
    const ann = {
      accountKey: alice.pkHex,
      deviceKey: newDevice.pkHex,
      eventAt: Date.now(),
      signature: Buffer.from(sig).toString('base64'),
    };
    expect(verifyDeviceAnnouncementSignature('device_added', ann)).toBe(false);
  });

  it('rejects when the kind flips between sign and verify', () => {
    // Alice signs an `added` announcement; receiver tries to verify as `revoked`.
    // Canonical bytes differ across kinds, so verification fails.
    const alice = mintKey();
    const dev = mintKey();
    const ann = signAdded(alice, dev.pkHex);
    expect(verifyDeviceAnnouncementSignature('device_revoked', ann)).toBe(false);
  });

  it('rejects a tampered deviceKey field', () => {
    const alice = mintKey();
    const dev = mintKey();
    const other = mintKey();
    const ann = signAdded(alice, dev.pkHex);
    const tampered = { ...ann, deviceKey: other.pkHex };
    expect(verifyDeviceAnnouncementSignature('device_added', tampered)).toBe(false);
  });

  it('rejects a tampered eventAt field', () => {
    const alice = mintKey();
    const dev = mintKey();
    const ann = signAdded(alice, dev.pkHex, 1000);
    const tampered = { ...ann, eventAt: 2000 };
    expect(verifyDeviceAnnouncementSignature('device_added', tampered)).toBe(false);
  });

  it('rejects malformed signature bytes', () => {
    const alice = mintKey();
    const dev = mintKey();
    const ann = signAdded(alice, dev.pkHex);
    const tampered = { ...ann, signature: 'not-base64-zzz!!!' };
    expect(verifyDeviceAnnouncementSignature('device_added', tampered)).toBe(false);
  });

  it('rejects wrong-length signature bytes', () => {
    const alice = mintKey();
    const dev = mintKey();
    const ann = signAdded(alice, dev.pkHex);
    const tampered = { ...ann, signature: Buffer.from([1, 2, 3]).toString('base64') };
    expect(verifyDeviceAnnouncementSignature('device_added', tampered)).toBe(false);
  });

  it('rejects non-numeric eventAt', () => {
    const alice = mintKey();
    const dev = mintKey();
    const ann = signAdded(alice, dev.pkHex);
    const tampered = { ...ann, eventAt: NaN };
    expect(verifyDeviceAnnouncementSignature('device_added', tampered)).toBe(false);
  });
});
