// ============================================================
// MeshWhisper SDK — Safety Number (Key Fingerprint)
//
// Produces a canonical human-comparable fingerprint from two
// Ed25519 identity public keys. Both parties compute the same
// number because the keys are sorted before hashing — order of
// computation doesn't matter.
//
// Format: 12 groups of 5 decimal digits (60 digits total),
// separated by spaces. Modelled on Signal's safety numbers.
// ============================================================

import { blake3 } from '@noble/hashes/blake3';

const GROUPS = 12;

/**
 * Computes a safety number from two Ed25519 identity public keys.
 *
 * The result is identical regardless of which key is passed first.
 * Both peers must use their long-term Ed25519 identity keys (the
 * same keys embedded in their pre-key bundles as `identityKey`).
 *
 * @returns 60-digit string in the form "DDDDD DDDDD ... DDDDD"
 */
export function computeFingerprint(keyA: Uint8Array, keyB: Uint8Array): string {
  const [first, second] = compareBytes(keyA, keyB) <= 0
    ? [keyA, keyB]
    : [keyB, keyA];

  const input = new Uint8Array(first.length + second.length);
  input.set(first, 0);
  input.set(second, first.length);

  const hash = blake3(input, { dkLen: GROUPS * 2 });

  const groups: string[] = [];
  for (let i = 0; i < GROUPS; i++) {
    const val = (hash[i * 2]! << 8) | hash[i * 2 + 1]!;
    groups.push(val.toString().padStart(5, '0'));
  }
  return groups.join(' ');
}

/**
 * Parses and normalises a safety number string for comparison.
 * Strips spaces and non-digit characters so copy-paste or OCR
 * variants ("12345 67890" vs "1234567890") both match correctly.
 */
export function normaliseSafetyNumber(s: string): string {
  return s.replace(/\D/g, '');
}

/**
 * Returns true if `candidate` matches the expected safety number
 * for the given key pair. Tolerates extra whitespace or dashes.
 */
export function verifySafetyNumber(
  keyA: Uint8Array,
  keyB: Uint8Array,
  candidate: string,
): boolean {
  const expected = normaliseSafetyNumber(computeFingerprint(keyA, keyB));
  const actual = normaliseSafetyNumber(candidate);
  return expected === actual;
}

// ---- Helpers ----

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}
