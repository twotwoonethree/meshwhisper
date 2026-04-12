import { describe, it, expect } from 'vitest';
import {
  hash,
  encrypt,
  decrypt,
  generateKeyPair,
  computeSharedSecret,
  deriveDestHash,
  deriveNamespaceId,
  kdf,
  randomBytes,
  getCurrentEpochHour,
  concat,
} from '../src/crypto/index.js';

describe('hash', () => {
  it('returns 32 bytes', () => {
    expect(hash(new Uint8Array([1, 2, 3])).length).toBe(32);
  });

  it('is deterministic', () => {
    const input = new Uint8Array([42, 43, 44]);
    expect(hash(input)).toEqual(hash(input));
  });

  it('different inputs produce different outputs', () => {
    const a = hash(new Uint8Array([1]));
    const b = hash(new Uint8Array([2]));
    expect(a).not.toEqual(b);
  });
});

describe('encrypt / decrypt', () => {
  const key = randomBytes(32);
  const plaintext = new TextEncoder().encode('hello meshwhisper');

  it('roundtrip produces original plaintext', () => {
    const encrypted = encrypt(plaintext, key);
    const decrypted = decrypt(encrypted, key);
    expect(decrypted).toEqual(plaintext);
  });

  it('ciphertext differs from plaintext', () => {
    const encrypted = encrypt(plaintext, key);
    expect(encrypted.ciphertext).not.toEqual(plaintext);
  });

  it('each call produces a different nonce', () => {
    const a = encrypt(plaintext, key);
    const b = encrypt(plaintext, key);
    expect(a.nonce).not.toEqual(b.nonce);
  });

  it('wrong key throws on decrypt', () => {
    const encrypted = encrypt(plaintext, key);
    const wrongKey = randomBytes(32);
    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  it('tampered ciphertext throws on decrypt', () => {
    const encrypted = encrypt(plaintext, key);
    const tampered = { ...encrypted, ciphertext: encrypted.ciphertext.map((b) => b ^ 0xff) };
    expect(() => decrypt(tampered as any, key)).toThrow();
  });

  it('tampered tag throws on decrypt', () => {
    const encrypted = encrypt(plaintext, key);
    const tampered = { ...encrypted, tag: new Uint8Array(16) };
    expect(() => decrypt(tampered, key)).toThrow();
  });
});

describe('generateKeyPair', () => {
  it('returns 32-byte keys', () => {
    const kp = generateKeyPair();
    expect(kp.publicKey.length).toBe(32);
    expect(kp.privateKey.length).toBe(32);
  });

  it('each call returns different keys', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    expect(a.publicKey).not.toEqual(b.publicKey);
    expect(a.privateKey).not.toEqual(b.privateKey);
  });
});

describe('computeSharedSecret (X25519)', () => {
  it('produces the same secret from both sides', () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const aliceShared = computeSharedSecret(alice.privateKey, bob.publicKey);
    const bobShared = computeSharedSecret(bob.privateKey, alice.publicKey);
    expect(aliceShared).toEqual(bobShared);
  });

  it('different key pairs produce different secrets', () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const carol = generateKeyPair();
    const s1 = computeSharedSecret(alice.privateKey, bob.publicKey);
    const s2 = computeSharedSecret(alice.privateKey, carol.publicKey);
    expect(s1).not.toEqual(s2);
  });
});

describe('deriveDestHash', () => {
  const ns = randomBytes(32);

  it('returns 8 bytes', () => {
    const kp = generateKeyPair();
    expect(deriveDestHash(ns, kp.publicKey, 0).length).toBe(8);
  });

  it('same key + same hour → same hash', () => {
    const kp = generateKeyPair();
    const hour = 12345;
    expect(deriveDestHash(ns, kp.publicKey, hour)).toEqual(deriveDestHash(ns, kp.publicKey, hour));
  });

  it('same key + different hour → different hash', () => {
    const kp = generateKeyPair();
    const h1 = deriveDestHash(ns, kp.publicKey, 1000);
    const h2 = deriveDestHash(ns, kp.publicKey, 1001);
    expect(h1).not.toEqual(h2);
  });

  it('different keys → different hashes', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const h1 = deriveDestHash(ns, a.publicKey, 42);
    const h2 = deriveDestHash(ns, b.publicKey, 42);
    expect(h1).not.toEqual(h2);
  });

  it('different namespaces → different hashes for same key and hour', () => {
    const kp = generateKeyPair();
    const ns2 = randomBytes(32);
    expect(deriveDestHash(ns, kp.publicKey, 100)).not.toEqual(deriveDestHash(ns2, kp.publicKey, 100));
  });
});

describe('deriveNamespaceId', () => {
  it('returns 32 bytes', () => {
    const id = deriveNamespaceId('com.example.app', randomBytes(32));
    expect(id.length).toBe(32);
  });

  it('same inputs → same ID', () => {
    const devKey = randomBytes(32);
    const a = deriveNamespaceId('com.example.app', devKey);
    const b = deriveNamespaceId('com.example.app', devKey);
    expect(a).toEqual(b);
  });

  it('different bundle IDs → different namespace IDs', () => {
    const devKey = randomBytes(32);
    const a = deriveNamespaceId('com.app.one', devKey);
    const b = deriveNamespaceId('com.app.two', devKey);
    expect(a).not.toEqual(b);
  });
});

describe('kdf', () => {
  it('returns 32 bytes by default', () => {
    const out = kdf(randomBytes(32), 'test-context');
    expect(out.length).toBe(32);
  });

  it('same inputs → same output', () => {
    const key = randomBytes(32);
    expect(kdf(key, 'ctx')).toEqual(kdf(key, 'ctx'));
  });

  it('different contexts → different outputs', () => {
    const key = randomBytes(32);
    expect(kdf(key, 'ctx-a')).not.toEqual(kdf(key, 'ctx-b'));
  });
});

describe('getCurrentEpochHour', () => {
  it('returns a positive integer', () => {
    const hour = getCurrentEpochHour();
    expect(hour).toBeGreaterThan(0);
    expect(Number.isInteger(hour)).toBe(true);
  });
});

describe('concat', () => {
  it('joins arrays in order', () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([3, 4]);
    const c = new Uint8Array([5]);
    expect(concat(a, b, c)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('handles empty arrays', () => {
    const a = new Uint8Array([1]);
    expect(concat(new Uint8Array(), a, new Uint8Array())).toEqual(a);
  });
});
