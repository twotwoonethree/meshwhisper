import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import {
  generatePreKeyBundle,
  generateOneTimePreKeys,
  initiateKeyExchange,
  completeKeyExchange,
  verifyPreKeyBundle,
  serializePreKeyBundle,
  deserializePreKeyBundle,
} from '../src/x3dh/index.js';

function makeIdentity() {
  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

describe('generatePreKeyBundle', () => {
  it('returns a bundle with correct key lengths', () => {
    const id = makeIdentity();
    const { bundle } = generatePreKeyBundle(id);
    expect(bundle.identityKey.length).toBe(32);
    expect(bundle.signedPreKey.length).toBe(32);
    expect(bundle.signedPreKeySignature.length).toBe(64);
    expect(bundle.oneTimePreKey?.length).toBe(32);
  });

  it('returns signedPreKeyPair with matching public key', () => {
    const id = makeIdentity();
    const { bundle, signedPreKeyPair } = generatePreKeyBundle(id);
    expect(signedPreKeyPair.publicKey).toEqual(bundle.signedPreKey);
    expect(signedPreKeyPair.privateKey.length).toBe(32);
  });

  it('returns oneTimePreKeyPair with matching public key', () => {
    const id = makeIdentity();
    const { bundle, oneTimePreKeyPair } = generatePreKeyBundle(id);
    expect(oneTimePreKeyPair.publicKey).toEqual(bundle.oneTimePreKey);
    expect(oneTimePreKeyPair.privateKey.length).toBe(32);
  });

  it('bundle identity key matches the provided identity key', () => {
    const id = makeIdentity();
    const { bundle } = generatePreKeyBundle(id);
    expect(bundle.identityKey).toEqual(id.publicKey);
  });

  it('different calls produce different pre-keys', () => {
    const id = makeIdentity();
    const a = generatePreKeyBundle(id);
    const b = generatePreKeyBundle(id);
    expect(a.bundle.signedPreKey).not.toEqual(b.bundle.signedPreKey);
    expect(a.bundle.oneTimePreKey).not.toEqual(b.bundle.oneTimePreKey);
  });
});

describe('generateOneTimePreKeys', () => {
  it('returns the requested count', () => {
    const id = makeIdentity();
    const keys = generateOneTimePreKeys(id, 5);
    expect(keys.length).toBe(5);
  });

  it('each entry has a 32-byte public and private key', () => {
    const id = makeIdentity();
    const keys = generateOneTimePreKeys(id, 3);
    for (const kp of keys) {
      expect(kp.publicKey.length).toBe(32);
      expect(kp.privateKey.length).toBe(32);
    }
  });

  it('all keys are unique', () => {
    const id = makeIdentity();
    const keys = generateOneTimePreKeys(id, 10);
    const hexes = keys.map((k) => Buffer.from(k.publicKey).toString('hex'));
    const unique = new Set(hexes);
    expect(unique.size).toBe(10);
  });

  it('throws on negative count', () => {
    expect(() => generateOneTimePreKeys(makeIdentity(), -1)).toThrow();
  });

  it('returns empty array for count = 0', () => {
    expect(generateOneTimePreKeys(makeIdentity(), 0)).toEqual([]);
  });
});

describe('verifyPreKeyBundle', () => {
  it('returns true for a valid bundle', () => {
    const id = makeIdentity();
    const { bundle } = generatePreKeyBundle(id);
    expect(verifyPreKeyBundle(bundle)).toBe(true);
  });

  it('returns false when the signature is tampered', () => {
    const id = makeIdentity();
    const { bundle } = generatePreKeyBundle(id);
    const tampered = {
      ...bundle,
      signedPreKeySignature: new Uint8Array(64),
    };
    expect(verifyPreKeyBundle(tampered)).toBe(false);
  });

  it('returns false when the signed pre-key is tampered', () => {
    const id = makeIdentity();
    const { bundle } = generatePreKeyBundle(id);
    const tampered = { ...bundle, signedPreKey: new Uint8Array(32) };
    expect(verifyPreKeyBundle(tampered)).toBe(false);
  });
});

describe('X3DH key exchange (full round-trip)', () => {
  it('Alice and Bob derive the same shared secret', () => {
    const aliceId = makeIdentity();
    const bobId = makeIdentity();
    const { bundle: bobBundle, signedPreKeyPair: bobSPK, oneTimePreKeyPair: bobOPK } =
      generatePreKeyBundle(bobId);

    // Alice initiates
    const { sharedSecret: aliceSecret, ephemeralPublicKey } = initiateKeyExchange(
      aliceId,
      bobBundle,
    );

    // Bob completes
    const bobSecret = completeKeyExchange(
      bobId,
      bobSPK,
      bobOPK,
      aliceId.publicKey,
      ephemeralPublicKey,
    );

    expect(aliceSecret).toEqual(bobSecret);
  });

  it('produces different secrets for different sessions', () => {
    const aliceId = makeIdentity();
    const bobId = makeIdentity();
    const { bundle: bobBundle, signedPreKeyPair: bobSPK, oneTimePreKeyPair: bobOPK } =
      generatePreKeyBundle(bobId);

    const session1 = initiateKeyExchange(aliceId, bobBundle).sharedSecret;

    // Regenerate bundle for a fresh session
    const { bundle: bobBundle2, signedPreKeyPair: bobSPK2, oneTimePreKeyPair: bobOPK2 } =
      generatePreKeyBundle(bobId);
    const session2 = initiateKeyExchange(aliceId, bobBundle2).sharedSecret;

    expect(session1).not.toEqual(session2);
  });

  it('works without a one-time pre-key', () => {
    const aliceId = makeIdentity();
    const bobId = makeIdentity();
    const { bundle: bobBundle, signedPreKeyPair: bobSPK } = generatePreKeyBundle(bobId);

    const bundleNoOPK = { ...bobBundle, oneTimePreKey: undefined };
    const { sharedSecret: aliceSecret, ephemeralPublicKey } = initiateKeyExchange(
      aliceId,
      bundleNoOPK,
    );

    const bobSecret = completeKeyExchange(
      bobId,
      bobSPK,
      null,
      aliceId.publicKey,
      ephemeralPublicKey,
    );

    expect(aliceSecret).toEqual(bobSecret);
  });

  it('throws when the bundle signature is invalid', () => {
    const aliceId = makeIdentity();
    const bobId = makeIdentity();
    const { bundle } = generatePreKeyBundle(bobId);
    const tampered = { ...bundle, signedPreKeySignature: new Uint8Array(64) };
    expect(() => initiateKeyExchange(aliceId, tampered)).toThrow();
  });
});

describe('serializePreKeyBundle / deserializePreKeyBundle', () => {
  it('roundtrip without OPK', () => {
    const id = makeIdentity();
    const { bundle } = generatePreKeyBundle(id);
    const noOpk = { ...bundle, oneTimePreKey: undefined };
    const serialized = serializePreKeyBundle(noOpk);
    const deserialized = deserializePreKeyBundle(serialized);
    expect(deserialized.identityKey).toEqual(noOpk.identityKey);
    expect(deserialized.signedPreKey).toEqual(noOpk.signedPreKey);
    expect(deserialized.signedPreKeySignature).toEqual(noOpk.signedPreKeySignature);
    expect(deserialized.oneTimePreKey).toBeUndefined();
  });

  it('roundtrip with OPK', () => {
    const id = makeIdentity();
    const { bundle } = generatePreKeyBundle(id);
    const serialized = serializePreKeyBundle(bundle);
    const deserialized = deserializePreKeyBundle(serialized);
    expect(deserialized.identityKey).toEqual(bundle.identityKey);
    expect(deserialized.signedPreKey).toEqual(bundle.signedPreKey);
    expect(deserialized.signedPreKeySignature).toEqual(bundle.signedPreKeySignature);
    expect(deserialized.oneTimePreKey).toEqual(bundle.oneTimePreKey);
  });

  it('throws on truncated data', () => {
    const id = makeIdentity();
    const { bundle } = generatePreKeyBundle(id);
    const serialized = serializePreKeyBundle(bundle).slice(0, 10);
    expect(() => deserializePreKeyBundle(serialized)).toThrow();
  });

  it('throws on unsupported version', () => {
    const id = makeIdentity();
    const { bundle } = generatePreKeyBundle(id);
    const serialized = serializePreKeyBundle(bundle);
    serialized[0] = 0xff; // corrupt version byte
    expect(() => deserializePreKeyBundle(serialized)).toThrow();
  });

  it('serialized bundle passes signature verification', () => {
    const id = makeIdentity();
    const { bundle } = generatePreKeyBundle(id);
    const serialized = serializePreKeyBundle(bundle);
    const deserialized = deserializePreKeyBundle(serialized);
    expect(verifyPreKeyBundle(deserialized)).toBe(true);
  });
});
