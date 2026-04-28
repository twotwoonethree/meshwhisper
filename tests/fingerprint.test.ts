import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { computeFingerprint, verifySafetyNumber, normaliseSafetyNumber } from '../src/fingerprint/index.js';

function makeKey(): Uint8Array {
  return ed25519.getPublicKey(ed25519.utils.randomPrivateKey());
}

describe('computeFingerprint', () => {
  it('returns a string of 12 five-digit groups', () => {
    const fp = computeFingerprint(makeKey(), makeKey());
    const groups = fp.split(' ');
    expect(groups).toHaveLength(12);
    for (const g of groups) {
      expect(g).toMatch(/^\d{5}$/);
    }
  });

  it('is symmetric — same result regardless of key order', () => {
    const a = makeKey();
    const b = makeKey();
    expect(computeFingerprint(a, b)).toBe(computeFingerprint(b, a));
  });

  it('is deterministic — same keys always produce the same fingerprint', () => {
    const a = makeKey();
    const b = makeKey();
    expect(computeFingerprint(a, b)).toBe(computeFingerprint(a, b));
  });

  it('different key pairs produce different fingerprints', () => {
    const fp1 = computeFingerprint(makeKey(), makeKey());
    const fp2 = computeFingerprint(makeKey(), makeKey());
    expect(fp1).not.toBe(fp2);
  });

  it('changing one key changes the fingerprint', () => {
    const a = makeKey();
    const b = makeKey();
    const c = makeKey();
    expect(computeFingerprint(a, b)).not.toBe(computeFingerprint(a, c));
  });

  it('returns 60 digits total (ignoring spaces)', () => {
    const fp = computeFingerprint(makeKey(), makeKey());
    expect(fp.replace(/ /g, '')).toHaveLength(60);
  });
});

describe('normaliseSafetyNumber', () => {
  it('strips spaces', () => {
    expect(normaliseSafetyNumber('12345 67890')).toBe('1234567890');
  });

  it('strips dashes and other non-digit characters', () => {
    expect(normaliseSafetyNumber('12345-67890')).toBe('1234567890');
    expect(normaliseSafetyNumber('12345\n67890')).toBe('1234567890');
  });
});

describe('verifySafetyNumber', () => {
  it('returns true for a matching safety number', () => {
    const a = makeKey();
    const b = makeKey();
    const fp = computeFingerprint(a, b);
    expect(verifySafetyNumber(a, b, fp)).toBe(true);
  });

  it('returns true regardless of key order', () => {
    const a = makeKey();
    const b = makeKey();
    const fp = computeFingerprint(a, b);
    expect(verifySafetyNumber(b, a, fp)).toBe(true);
  });

  it('returns true when candidate has extra spaces', () => {
    const a = makeKey();
    const b = makeKey();
    const fp = computeFingerprint(a, b);
    const spaceless = fp.replace(/ /g, '');
    expect(verifySafetyNumber(a, b, spaceless)).toBe(true);
  });

  it('returns false for a wrong safety number', () => {
    const a = makeKey();
    const b = makeKey();
    expect(verifySafetyNumber(a, b, '00000 00000 00000 00000 00000 00000 00000 00000 00000 00000 00000 00000')).toBe(false);
  });

  it('returns false when one key differs', () => {
    const a = makeKey();
    const b = makeKey();
    const c = makeKey();
    const fp = computeFingerprint(a, b);
    expect(verifySafetyNumber(a, c, fp)).toBe(false);
  });
});
