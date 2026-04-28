import { describe, it, expect } from 'vitest';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import {
  generatePreKeyBundle,
  generateOneTimePreKeys,
  initiateKeyExchange,
  completeKeyExchange,
  verifyPreKeyBundle,
  serializePreKeyBundle,
  deserializePreKeyBundle,
  PQ_CIPHERTEXT_LENGTH,
} from '../src/x3dh/index.js';

function makeIdentity() {
  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

// ---- generatePreKeyBundle ----

describe('generatePreKeyBundle', () => {
  it('returns a bundle with correct classical key lengths', () => {
    const id = makeIdentity();
    const { bundle } = generatePreKeyBundle(id);
    expect(bundle.identityKey.length).toBe(32);
    expect(bundle.signedPreKey.length).toBe(32);
    expect(bundle.signedPreKeySignature.length).toBe(64);
    expect(bundle.oneTimePreKey?.length).toBe(32);
  });

  it('returns a bundle with ML-KEM-768 public key (1184 bytes)', () => {
    const id = makeIdentity();
    const { bundle } = generatePreKeyBundle(id);
    expect(bundle.pqPublicKey?.length).toBe(1184);
  });

  it('returns pqSecretKey of 2400 bytes', () => {
    const id = makeIdentity();
    const { pqSecretKey } = generatePreKeyBundle(id);
    expect(pqSecretKey.length).toBe(2400);
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

  it('different calls produce different pre-keys and PQ keys', () => {
    const id = makeIdentity();
    const a = generatePreKeyBundle(id);
    const b = generatePreKeyBundle(id);
    expect(a.bundle.signedPreKey).not.toEqual(b.bundle.signedPreKey);
    expect(a.bundle.pqPublicKey).not.toEqual(b.bundle.pqPublicKey);
    expect(a.pqSecretKey).not.toEqual(b.pqSecretKey);
  });
});

// ---- generateOneTimePreKeys ----

describe('generateOneTimePreKeys', () => {
  it('returns the requested count', () => {
    const id = makeIdentity();
    expect(generateOneTimePreKeys(id, 5).length).toBe(5);
  });

  it('each entry has a 32-byte public and private key', () => {
    const id = makeIdentity();
    for (const kp of generateOneTimePreKeys(id, 3)) {
      expect(kp.publicKey.length).toBe(32);
      expect(kp.privateKey.length).toBe(32);
    }
  });

  it('all keys are unique', () => {
    const id = makeIdentity();
    const keys = generateOneTimePreKeys(id, 10);
    const hexes = keys.map((k) => Buffer.from(k.publicKey).toString('hex'));
    expect(new Set(hexes).size).toBe(10);
  });

  it('throws on negative count', () => {
    expect(() => generateOneTimePreKeys(makeIdentity(), -1)).toThrow();
  });

  it('returns empty array for count = 0', () => {
    expect(generateOneTimePreKeys(makeIdentity(), 0)).toEqual([]);
  });
});

// ---- verifyPreKeyBundle ----

describe('verifyPreKeyBundle', () => {
  it('returns true for a valid bundle', () => {
    const { bundle } = generatePreKeyBundle(makeIdentity());
    expect(verifyPreKeyBundle(bundle)).toBe(true);
  });

  it('returns false when the signature is tampered', () => {
    const { bundle } = generatePreKeyBundle(makeIdentity());
    expect(verifyPreKeyBundle({ ...bundle, signedPreKeySignature: new Uint8Array(64) })).toBe(false);
  });

  it('returns false when the signed pre-key is tampered', () => {
    const { bundle } = generatePreKeyBundle(makeIdentity());
    expect(verifyPreKeyBundle({ ...bundle, signedPreKey: new Uint8Array(32) })).toBe(false);
  });
});

// ---- PQXDH round-trip ----

describe('PQXDH key exchange (full round-trip)', () => {
  it('Alice and Bob derive the same shared secret (with PQ)', () => {
    const aliceId = makeIdentity();
    const bobId = makeIdentity();
    const { bundle, signedPreKeyPair: bobSPK, oneTimePreKeyPair: bobOPK, pqSecretKey } =
      generatePreKeyBundle(bobId);

    const result = initiateKeyExchange(aliceId, bundle);

    // Alice's result should include a PQ ciphertext
    expect(result.pqCiphertext?.length).toBe(PQ_CIPHERTEXT_LENGTH);

    const bobSecret = completeKeyExchange(
      bobId, bobSPK, bobOPK,
      aliceId.publicKey, result.ephemeralPublicKey,
      result.pqCiphertext, pqSecretKey,
    );

    expect(result.sharedSecret).toEqual(bobSecret);
  });

  it('produces different secrets for different sessions', () => {
    const aliceId = makeIdentity();
    const bobId = makeIdentity();

    const gen1 = generatePreKeyBundle(bobId);
    const r1 = initiateKeyExchange(aliceId, gen1.bundle);

    const gen2 = generatePreKeyBundle(bobId);
    const r2 = initiateKeyExchange(aliceId, gen2.bundle);

    expect(r1.sharedSecret).not.toEqual(r2.sharedSecret);
  });

  it('works without a one-time pre-key (3-DH + PQ)', () => {
    const aliceId = makeIdentity();
    const bobId = makeIdentity();
    const { bundle, signedPreKeyPair: bobSPK, pqSecretKey } = generatePreKeyBundle(bobId);

    const result = initiateKeyExchange(aliceId, { ...bundle, oneTimePreKey: undefined });

    const bobSecret = completeKeyExchange(
      bobId, bobSPK, null,
      aliceId.publicKey, result.ephemeralPublicKey,
      result.pqCiphertext, pqSecretKey,
    );

    expect(result.sharedSecret).toEqual(bobSecret);
  });

  it('throws when the bundle signature is invalid', () => {
    const aliceId = makeIdentity();
    const { bundle } = generatePreKeyBundle(makeIdentity());
    expect(() =>
      initiateKeyExchange(aliceId, { ...bundle, signedPreKeySignature: new Uint8Array(64) }),
    ).toThrow();
  });

  it('PQXDH secret differs from classical secret for the same DH inputs', () => {
    // Verify that the two KDF paths produce different outputs — ensures domain separation.
    const aliceId = makeIdentity();
    const bobId = makeIdentity();
    const { bundle, signedPreKeyPair: bobSPK, oneTimePreKeyPair: bobOPK, pqSecretKey } =
      generatePreKeyBundle(bobId);

    const result = initiateKeyExchange(aliceId, bundle);

    // PQXDH path
    const pqxdhSecret = completeKeyExchange(
      bobId, bobSPK, bobOPK,
      aliceId.publicKey, result.ephemeralPublicKey,
      result.pqCiphertext, pqSecretKey,
    );

    // Classical path (no PQ params)
    const classicalSecret = completeKeyExchange(
      bobId, bobSPK, bobOPK,
      aliceId.publicKey, result.ephemeralPublicKey,
    );

    expect(pqxdhSecret).not.toEqual(classicalSecret);
  });

  it('wrong PQ ciphertext → secrets do NOT match', () => {
    const aliceId = makeIdentity();
    const bobId = makeIdentity();
    const { bundle, signedPreKeyPair: bobSPK, oneTimePreKeyPair: bobOPK, pqSecretKey } =
      generatePreKeyBundle(bobId);

    const result = initiateKeyExchange(aliceId, bundle);
    const wrongCiphertext = new Uint8Array(PQ_CIPHERTEXT_LENGTH);

    const bobSecret = completeKeyExchange(
      bobId, bobSPK, bobOPK,
      aliceId.publicKey, result.ephemeralPublicKey,
      wrongCiphertext, pqSecretKey,
    );

    expect(result.sharedSecret).not.toEqual(bobSecret);
  });
});

// ---- Classical fallback ----

describe('X3DH classical fallback (no pqPublicKey in bundle)', () => {
  it('Alice and Bob derive the same shared secret without PQ', () => {
    const aliceId = makeIdentity();
    const bobId = makeIdentity();
    const { bundle, signedPreKeyPair: bobSPK, oneTimePreKeyPair: bobOPK } =
      generatePreKeyBundle(bobId);

    // Strip PQ key to simulate a classical bundle
    const classicalBundle = { ...bundle, pqPublicKey: undefined };

    const result = initiateKeyExchange(aliceId, classicalBundle);
    expect(result.pqCiphertext).toBeUndefined();

    const bobSecret = completeKeyExchange(
      bobId, bobSPK, bobOPK,
      aliceId.publicKey, result.ephemeralPublicKey,
    );

    expect(result.sharedSecret).toEqual(bobSecret);
  });
});

// ---- Failure paths ----

describe('X3DH OPK mismatch', () => {
  it('Alice uses OPK but Bob passes null → secrets do NOT match', () => {
    const aliceId = makeIdentity();
    const bobId = makeIdentity();
    const { bundle, signedPreKeyPair: bobSPK, pqSecretKey } = generatePreKeyBundle(bobId);

    const result = initiateKeyExchange(aliceId, bundle);

    const bobSecret = completeKeyExchange(
      bobId, bobSPK, null,  // ← Bob ignores the OPK
      aliceId.publicKey, result.ephemeralPublicKey,
      result.pqCiphertext, pqSecretKey,
    );

    expect(result.sharedSecret).not.toEqual(bobSecret);
  });

  it('Bob uses wrong OPK private key → secrets do NOT match', () => {
    const aliceId = makeIdentity();
    const bobId = makeIdentity();
    const { bundle, signedPreKeyPair: bobSPK, pqSecretKey } = generatePreKeyBundle(bobId);

    const result = initiateKeyExchange(aliceId, bundle);

    const wrongPriv = x25519.utils.randomSecretKey();
    const wrongOPK = { publicKey: x25519.getPublicKey(wrongPriv), privateKey: wrongPriv, keyType: 'dh' as const };

    const bobSecret = completeKeyExchange(
      bobId, bobSPK, wrongOPK,
      aliceId.publicKey, result.ephemeralPublicKey,
      result.pqCiphertext, pqSecretKey,
    );

    expect(result.sharedSecret).not.toEqual(bobSecret);
  });
});

describe('X3DH identity key mismatch', () => {
  it('Bob receives wrong Alice identity key → secrets do NOT match', () => {
    const aliceId = makeIdentity();
    const wrongAliceId = makeIdentity();
    const bobId = makeIdentity();
    const { bundle, signedPreKeyPair: bobSPK, oneTimePreKeyPair: bobOPK, pqSecretKey } =
      generatePreKeyBundle(bobId);

    const result = initiateKeyExchange(aliceId, bundle);

    const bobSecret = completeKeyExchange(
      bobId, bobSPK, bobOPK,
      wrongAliceId.publicKey,  // ← wrong
      result.ephemeralPublicKey,
      result.pqCiphertext, pqSecretKey,
    );

    expect(result.sharedSecret).not.toEqual(bobSecret);
  });

  it('Bob uses wrong signed pre-key → secrets do NOT match', () => {
    const aliceId = makeIdentity();
    const bobId = makeIdentity();
    const { bundle, oneTimePreKeyPair: bobOPK, pqSecretKey } = generatePreKeyBundle(bobId);

    const result = initiateKeyExchange(aliceId, bundle);

    const { signedPreKeyPair: differentSPK } = generatePreKeyBundle(bobId);

    const bobSecret = completeKeyExchange(
      bobId, differentSPK,  // ← wrong SPK
      bobOPK,
      aliceId.publicKey,
      result.ephemeralPublicKey,
      result.pqCiphertext, pqSecretKey,
    );

    expect(result.sharedSecret).not.toEqual(bobSecret);
  });
});

describe('X3DH replayed ephemeral key', () => {
  it('same ephemeral key against a fresh bundle produces a different secret', () => {
    const aliceId = makeIdentity();
    const bobId = makeIdentity();

    const gen1 = generatePreKeyBundle(bobId);
    const result1 = initiateKeyExchange(aliceId, gen1.bundle);

    const gen2 = generatePreKeyBundle(bobId);
    const secret2 = completeKeyExchange(
      bobId, gen2.signedPreKeyPair, gen2.oneTimePreKeyPair,
      aliceId.publicKey, result1.ephemeralPublicKey,
      result1.pqCiphertext, gen2.pqSecretKey,
    );

    expect(result1.sharedSecret).not.toEqual(secret2);
  });
});

// ---- Serialization ----

describe('serializePreKeyBundle / deserializePreKeyBundle', () => {
  it('PQXDH bundle roundtrip with OPK', () => {
    const { bundle } = generatePreKeyBundle(makeIdentity());
    const roundtripped = deserializePreKeyBundle(serializePreKeyBundle(bundle));
    expect(roundtripped.identityKey).toEqual(bundle.identityKey);
    expect(roundtripped.signedPreKey).toEqual(bundle.signedPreKey);
    expect(roundtripped.signedPreKeySignature).toEqual(bundle.signedPreKeySignature);
    expect(roundtripped.oneTimePreKey).toEqual(bundle.oneTimePreKey);
    expect(roundtripped.pqPublicKey).toEqual(bundle.pqPublicKey);
  });

  it('PQXDH bundle roundtrip without OPK', () => {
    const { bundle } = generatePreKeyBundle(makeIdentity());
    const noOpk = { ...bundle, oneTimePreKey: undefined };
    const roundtripped = deserializePreKeyBundle(serializePreKeyBundle(noOpk));
    expect(roundtripped.pqPublicKey).toEqual(bundle.pqPublicKey);
    expect(roundtripped.oneTimePreKey).toBeUndefined();
  });

  it('classical (v1) bundle roundtrip without pqPublicKey', () => {
    const { bundle } = generatePreKeyBundle(makeIdentity());
    const classical = { ...bundle, pqPublicKey: undefined };
    const roundtripped = deserializePreKeyBundle(serializePreKeyBundle(classical));
    expect(roundtripped.pqPublicKey).toBeUndefined();
    expect(roundtripped.identityKey).toEqual(bundle.identityKey);
  });

  it('serialized PQXDH bundle passes signature verification', () => {
    const { bundle } = generatePreKeyBundle(makeIdentity());
    expect(verifyPreKeyBundle(deserializePreKeyBundle(serializePreKeyBundle(bundle)))).toBe(true);
  });

  it('throws on truncated data', () => {
    const { bundle } = generatePreKeyBundle(makeIdentity());
    expect(() => deserializePreKeyBundle(serializePreKeyBundle(bundle).slice(0, 10))).toThrow();
  });

  it('throws on unsupported version byte', () => {
    const { bundle } = generatePreKeyBundle(makeIdentity());
    const bytes = serializePreKeyBundle(bundle);
    bytes[0] = 0xff;
    expect(() => deserializePreKeyBundle(bytes)).toThrow();
  });

  it('OPK flag set but data truncated → throws', () => {
    const { bundle } = generatePreKeyBundle(makeIdentity());
    const serialized = serializePreKeyBundle(bundle);
    expect(() => deserializePreKeyBundle(serialized.slice(0, serialized.length - 16))).toThrow();
  });
});
