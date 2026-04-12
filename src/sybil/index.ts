// ============================================================
// MeshWhisper SDK — Sybil Resistance Module
// Proof of Physical Device (entropy challenges) and
// Zero-Knowledge Relay Reputation (hash-commitment proofs).
// ============================================================

import { blake3 } from '@noble/hashes/blake3';
import { randomBytes } from '@noble/hashes/utils';
import { ed25519 } from '@noble/curves/ed25519';
import type { EntropySensorType, EntropyChallenge, EntropyResponse } from '../types.js';

// ---- Exported Interfaces ----

export interface VerificationResult {
  valid: boolean;
  confidence: number;    // 0.0–1.0
  reasons: string[];     // explanation of pass/fail
}

export interface ReputationProof {
  peerId: string;          // can be pseudonymous
  commitment: Uint8Array;  // hash commitment to claims
  proof: Uint8Array;       // signed proof data
  claims: {
    minRelayCount: number;
    periodDays: number;
    minReciprocityScore: number;
  };
  timestamp: number;
}

// ---- Constants ----

/** Default challenge duration in milliseconds (3 seconds). */
const DEFAULT_CHALLENGE_DURATION_MS = 3_000;

/** Default minimum entropy samples expected for a valid response. */
const DEFAULT_MIN_ENTROPY_SAMPLES = 30;

/** Challenge ID length in bytes. */
const CHALLENGE_ID_LENGTH = 16;

/** Physical accelerometer range in m/s² (±20). */
const ACCEL_MAX = 20.0;

/** Expected gravity magnitude in m/s². */
const _GRAVITY = 9.81;

/** Minimum acceptable standard deviation for accelerometer data. */
const MIN_STD_DEV = 0.01;

/** Maximum acceptable standard deviation for accelerometer data. */
const MAX_STD_DEV = 15.0;

/** Autocorrelation lag-1 lower bound for physical data. */
const MIN_AUTOCORRELATION = 0.05;

/** Maximum allowed autocorrelation — nearly perfect correlation indicates replay. */
const MAX_AUTOCORRELATION = 0.998;

/** Maximum allowed fraction of perfectly repeating consecutive blocks. */
const MAX_REPEAT_FRACTION = 0.5;

/** Reputation proof validity window in milliseconds (30 days). */
const PROOF_VALIDITY_MS = 30 * 24 * 60 * 60 * 1_000;

/** Nonce length for reputation commitments. */
const COMMITMENT_NONCE_LENGTH = 16;

// ---- Helpers ----

/** Concatenates multiple Uint8Arrays into one. */
function concat(...arrays: Uint8Array[]): Uint8Array {
  let totalLength = 0;
  for (const arr of arrays) totalLength += arr.length;
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/** Encodes a 64-bit number as 8-byte big-endian. */
function encodeUint64BE(value: number): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setUint32(0, Math.floor(value / 0x100000000), false);
  view.setUint32(4, value >>> 0, false);
  return buf;
}

/** Encodes a 32-bit number as 4-byte big-endian. */
function encodeUint32BE(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  const view = new DataView(buf.buffer);
  view.setUint32(0, value, false);
  return buf;
}

/** Encodes a Float64 as 8-byte IEEE 754. */
function encodeFloat64(value: number): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setFloat64(0, value, false);
  return buf;
}

/** Encodes a UTF-8 string to bytes. */
const textEncoder = new TextEncoder();

function encodeString(s: string): Uint8Array {
  return textEncoder.encode(s);
}

// ---- Serialization helpers for challenges/responses ----

/**
 * Sensor type to single-byte identifier.
 */
function sensorTypeToByte(t: EntropySensorType): number {
  switch (t) {
    case 'accelerometer': return 0x01;
    case 'gyroscope': return 0x02;
    case 'magnetometer': return 0x03;
    default: throw new Error(`Unknown sensor type: ${t}`);
  }
}

function byteToSensorType(b: number): EntropySensorType {
  switch (b) {
    case 0x01: return 'accelerometer';
    case 0x02: return 'gyroscope';
    case 0x03: return 'magnetometer';
    default: throw new Error(`Unknown sensor type byte: 0x${b.toString(16)}`);
  }
}

// ============================================================
// EntropyChallenger — Proof of Physical Device
// ============================================================

export class EntropyChallenger {
  private readonly challengeDurationMs: number;
  private readonly minEntropySamples: number;

  constructor(options?: {
    challengeDurationMs?: number;
    minEntropySamples?: number;
  }) {
    this.challengeDurationMs = options?.challengeDurationMs ?? DEFAULT_CHALLENGE_DURATION_MS;
    this.minEntropySamples = options?.minEntropySamples ?? DEFAULT_MIN_ENTROPY_SAMPLES;
  }

  // ---- Challenge generation ----

  /**
   * Creates an entropy challenge with a random ID.
   * @param sensorType - Type of sensor to challenge (default: accelerometer).
   */
  createChallenge(sensorType: EntropySensorType = 'accelerometer'): EntropyChallenge {
    return {
      challengeId: randomBytes(CHALLENGE_ID_LENGTH),
      sensorType,
      durationMs: this.challengeDurationMs,
      timestamp: Date.now(),
    };
  }

  /**
   * Serializes an EntropyChallenge to a compact binary format.
   *
   * Layout:
   *   [16 bytes challengeId] [1 byte sensorType] [4 bytes durationMs] [8 bytes timestamp]
   */
  serializeChallenge(challenge: EntropyChallenge): Uint8Array {
    return concat(
      challenge.challengeId,
      new Uint8Array([sensorTypeToByte(challenge.sensorType)]),
      encodeUint32BE(challenge.durationMs),
      encodeUint64BE(challenge.timestamp),
    );
  }

  /**
   * Deserializes a binary-encoded EntropyChallenge.
   */
  deserializeChallenge(data: Uint8Array): EntropyChallenge {
    if (data.length < 29) {
      throw new RangeError('Challenge data too short: expected at least 29 bytes');
    }
    const challengeId = data.slice(0, 16);
    const sensorType = byteToSensorType(data[16]);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const durationMs = view.getUint32(17, false);
    const timestampHigh = view.getUint32(21, false);
    const timestampLow = view.getUint32(25, false);
    const timestamp = timestampHigh * 0x100000000 + timestampLow;

    return { challengeId, sensorType, durationMs, timestamp };
  }

  // ---- Response handling ----

  /**
   * Creates an entropy response by signing the challenge ID concatenated
   * with the raw sensor data.
   *
   * @param challenge - The challenge being responded to.
   * @param sensorData - Raw sensor readings collected during the challenge window.
   * @param signingKey - Ed25519 private key (32 bytes).
   */
  createResponse(
    challenge: EntropyChallenge,
    sensorData: Float64Array,
    signingKey: Uint8Array,
  ): EntropyResponse {
    const dataBytes = new Uint8Array(sensorData.buffer, sensorData.byteOffset, sensorData.byteLength);
    const payload = concat(challenge.challengeId, dataBytes);
    const signature = ed25519.sign(payload, signingKey);

    return {
      challengeId: challenge.challengeId,
      sensorData,
      deviceSignature: signature,
    };
  }

  /**
   * Serializes an EntropyResponse to binary.
   *
   * Layout:
   *   [16 bytes challengeId] [4 bytes sampleCount] [sampleCount * 8 bytes float64 data] [64 bytes signature]
   */
  serializeResponse(response: EntropyResponse): Uint8Array {
    const sampleCount = response.sensorData.length;
    const dataBytes = new Uint8Array(
      response.sensorData.buffer,
      response.sensorData.byteOffset,
      response.sensorData.byteLength,
    );
    return concat(
      response.challengeId,
      encodeUint32BE(sampleCount),
      dataBytes,
      response.deviceSignature,
    );
  }

  /**
   * Deserializes a binary-encoded EntropyResponse.
   */
  deserializeResponse(data: Uint8Array): EntropyResponse {
    if (data.length < 84) {
      throw new RangeError('Response data too short: expected at least 84 bytes');
    }
    const challengeId = data.slice(0, 16);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const sampleCount = view.getUint32(16, false);

    const expectedLength = 20 + sampleCount * 8 + 64;
    if (data.length < expectedLength) {
      throw new RangeError(
        `Response data too short: expected ${expectedLength} bytes, got ${data.length}`,
      );
    }

    const sensorDataBytes = data.slice(20, 20 + sampleCount * 8);
    const sensorData = new Float64Array(
      sensorDataBytes.buffer,
      sensorDataBytes.byteOffset,
      sampleCount,
    );
    const deviceSignature = data.slice(20 + sampleCount * 8, 20 + sampleCount * 8 + 64);

    return { challengeId, sensorData, deviceSignature };
  }

  // ---- Verification ----

  /**
   * Verifies an entropy response against its challenge.
   *
   * Checks performed:
   *  1. Ed25519 signature validity
   *  2. Sufficient data points for the duration
   *  3. Statistical analysis of sensor data
   *
   * @param challenge - The original challenge that was issued.
   * @param response - The response to verify.
   * @param publicKey - Ed25519 public key of the responding peer.
   */
  verifyResponse(
    challenge: EntropyChallenge,
    response: EntropyResponse,
    publicKey: Uint8Array,
  ): VerificationResult {
    const reasons: string[] = [];
    let confidence = 1.0;

    // 1. Verify challenge ID matches
    if (!uint8ArrayEqual(challenge.challengeId, response.challengeId)) {
      return { valid: false, confidence: 0, reasons: ['Challenge ID mismatch'] };
    }

    // 2. Verify signature
    const dataBytes = new Uint8Array(
      response.sensorData.buffer,
      response.sensorData.byteOffset,
      response.sensorData.byteLength,
    );
    const payload = concat(challenge.challengeId, dataBytes);

    let signatureValid: boolean;
    try {
      signatureValid = ed25519.verify(response.deviceSignature, payload, publicKey);
    } catch {
      signatureValid = false;
    }

    if (!signatureValid) {
      return { valid: false, confidence: 0, reasons: ['Invalid Ed25519 signature'] };
    }
    reasons.push('Signature valid');

    // 3. Sufficient data points
    const samples = response.sensorData;
    if (samples.length < this.minEntropySamples) {
      return {
        valid: false,
        confidence: 0,
        reasons: [
          `Insufficient samples: got ${samples.length}, need >= ${this.minEntropySamples}`,
        ],
      };
    }
    reasons.push(`Sample count sufficient (${samples.length})`);

    // 4. Statistical analysis
    const stats = this.analyzeSensorData(samples, challenge.sensorType);

    // 4a. Non-zero variance
    if (stats.variance === 0) {
      return {
        valid: false,
        confidence: 0,
        reasons: ['Zero variance — constant values indicate synthetic data'],
      };
    }

    // 4b. Values within physical sensor range
    if (challenge.sensorType === 'accelerometer') {
      if (stats.min < -ACCEL_MAX || stats.max > ACCEL_MAX) {
        confidence -= 0.3;
        reasons.push(
          `Values outside physical range: [${stats.min.toFixed(2)}, ${stats.max.toFixed(2)}] vs ±${ACCEL_MAX} m/s²`,
        );
      } else {
        reasons.push('Values within physical accelerometer range');
      }
    }

    // 4c. Standard deviation check
    if (stats.stdDev < MIN_STD_DEV) {
      confidence -= 0.4;
      reasons.push(
        `Standard deviation too low (${stats.stdDev.toFixed(6)}) — likely static synthetic data`,
      );
    } else if (stats.stdDev > MAX_STD_DEV) {
      confidence -= 0.3;
      reasons.push(
        `Standard deviation too high (${stats.stdDev.toFixed(4)}) — likely random noise`,
      );
    } else {
      reasons.push(`Standard deviation within expected range (${stats.stdDev.toFixed(4)})`);
    }

    // 4d. Autocorrelation check (physical movement has temporal correlation)
    if (stats.autocorrelation < MIN_AUTOCORRELATION) {
      confidence -= 0.3;
      reasons.push(
        `Low autocorrelation (${stats.autocorrelation.toFixed(4)}) — data resembles white noise`,
      );
    } else if (stats.autocorrelation > MAX_AUTOCORRELATION) {
      confidence -= 0.2;
      reasons.push(
        `Very high autocorrelation (${stats.autocorrelation.toFixed(4)}) — possible replay`,
      );
    } else {
      reasons.push(`Autocorrelation consistent with physical movement (${stats.autocorrelation.toFixed(4)})`);
    }

    // 4e. Repeating pattern detection
    if (stats.repeatFraction > MAX_REPEAT_FRACTION) {
      confidence -= 0.3;
      reasons.push(
        `High pattern repetition (${(stats.repeatFraction * 100).toFixed(1)}%) — possible replay attack`,
      );
    } else {
      reasons.push('No significant repeating patterns detected');
    }

    // Clamp confidence
    confidence = Math.max(0, Math.min(1, confidence));

    return {
      valid: confidence > 0.3,
      confidence,
      reasons,
    };
  }

  // ---- Internal statistical analysis ----

  private analyzeSensorData(
    data: Float64Array,
    _sensorType: EntropySensorType,
  ): SensorStats {
    const n = data.length;

    // Mean
    let sum = 0;
    for (let i = 0; i < n; i++) sum += data[i];
    const mean = sum / n;

    // Variance and std dev
    let varianceSum = 0;
    for (let i = 0; i < n; i++) {
      const diff = data[i] - mean;
      varianceSum += diff * diff;
    }
    const variance = varianceSum / n;
    const stdDev = Math.sqrt(variance);

    // Min and max
    let min = data[0];
    let max = data[0];
    for (let i = 1; i < n; i++) {
      if (data[i] < min) min = data[i];
      if (data[i] > max) max = data[i];
    }

    // Lag-1 autocorrelation
    let autocorrelation = 0;
    if (n > 1 && variance > 0) {
      let autoSum = 0;
      for (let i = 1; i < n; i++) {
        autoSum += (data[i] - mean) * (data[i - 1] - mean);
      }
      autocorrelation = autoSum / ((n - 1) * variance);
    }

    // Repeating pattern detection: check consecutive blocks of size 3
    const blockSize = 3;
    let repeatCount = 0;
    let totalBlocks = 0;
    if (n >= blockSize * 2) {
      for (let i = blockSize; i <= n - blockSize; i += blockSize) {
        totalBlocks++;
        let isRepeat = true;
        for (let j = 0; j < blockSize; j++) {
          if (data[i + j] !== data[i - blockSize + j]) {
            isRepeat = false;
            break;
          }
        }
        if (isRepeat) repeatCount++;
      }
    }
    const repeatFraction = totalBlocks > 0 ? repeatCount / totalBlocks : 0;

    return { mean, variance, stdDev, min, max, autocorrelation, repeatFraction };
  }
}

interface SensorStats {
  mean: number;
  variance: number;
  stdDev: number;
  min: number;
  max: number;
  autocorrelation: number;
  repeatFraction: number;
}

/** Constant-time-ish comparison of two Uint8Arrays. */
function uint8ArrayEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

// ============================================================
// ZKRelayReputation — Zero-Knowledge Relay Reputation
// ============================================================

export class ZKRelayReputation {
  private readonly localPeerId: string;

  constructor(localPeerId: string) {
    this.localPeerId = localPeerId;
  }

  // ---- Proof generation ----

  /**
   * Generates a simplified ZK reputation proof using hash commitments + Ed25519 signatures.
   *
   * The commitment is BLAKE3(relayCount || periodDays || reciprocityScore || nonce),
   * and the proof is an Ed25519 signature over (commitment || claims).
   *
   * @param relayCount - Number of blobs relayed in the period.
   * @param periodDays - Duration of the relay period in days.
   * @param reciprocityScore - Reciprocity score (0.0–1.0).
   * @param signingKey - Ed25519 private key (32 bytes).
   */
  generateProof(
    relayCount: number,
    periodDays: number,
    reciprocityScore: number,
    signingKey: Uint8Array,
  ): ReputationProof {
    const nonce = randomBytes(COMMITMENT_NONCE_LENGTH);
    const timestamp = Date.now();

    // Build commitment: BLAKE3(relayCount || periodDays || reciprocityScore || nonce)
    const commitmentInput = concat(
      encodeUint32BE(relayCount),
      encodeUint32BE(periodDays),
      encodeFloat64(reciprocityScore),
      nonce,
    );
    const commitment = blake3(commitmentInput);

    // Build claims payload for signing
    const claims = {
      minRelayCount: relayCount,
      periodDays,
      minReciprocityScore: reciprocityScore,
    };

    const claimsBytes = encodeString(JSON.stringify(claims));
    const timestampBytes = encodeUint64BE(timestamp);
    const peerIdBytes = encodeString(this.localPeerId);

    // Sign: commitment || claims || timestamp || peerId
    const signPayload = concat(commitment, claimsBytes, timestampBytes, peerIdBytes);
    const proof = ed25519.sign(signPayload, signingKey);

    return {
      peerId: this.localPeerId,
      commitment,
      proof,
      claims,
      timestamp,
    };
  }

  // ---- Proof verification ----

  /**
   * Verifies a reputation proof's Ed25519 signature.
   *
   * Note: this verifies the proof was signed by the holder of the corresponding
   * private key. It does NOT verify the actual relay behavior — that requires
   * on-chain or gossip-protocol corroboration.
   *
   * @param proof - The reputation proof to verify.
   * @param publicKey - Ed25519 public key of the prover.
   */
  verifyProof(proof: ReputationProof, publicKey: Uint8Array): boolean {
    // Check proof is not expired
    const age = Date.now() - proof.timestamp;
    if (age > PROOF_VALIDITY_MS || age < 0) {
      return false;
    }

    const claimsBytes = encodeString(JSON.stringify(proof.claims));
    const timestampBytes = encodeUint64BE(proof.timestamp);
    const peerIdBytes = encodeString(proof.peerId);

    const signPayload = concat(proof.commitment, claimsBytes, timestampBytes, peerIdBytes);

    try {
      return ed25519.verify(proof.proof, signPayload, publicKey);
    } catch {
      return false;
    }
  }

  // ---- Reputation scoring ----

  /**
   * Aggregates multiple verified reputation proofs into a single 0.0–1.0 score.
   *
   * Scoring factors:
   *  - Number of valid proofs (more proofs = more trust)
   *  - Relay counts (higher is better, with diminishing returns)
   *  - Reciprocity scores (weighted average)
   *  - Recency (more recent proofs weigh more)
   *
   * @param proofs - Array of reputation proofs (assumed already signature-verified).
   */
  getReputationScore(proofs: ReputationProof[]): number {
    if (proofs.length === 0) return 0;

    const now = Date.now();
    let weightedRelayScore = 0;
    let weightedReciprocityScore = 0;
    let totalWeight = 0;

    for (const proof of proofs) {
      // Recency weight: exponential decay over 30 days
      const ageDays = (now - proof.timestamp) / (24 * 60 * 60 * 1_000);
      const recencyWeight = Math.exp(-ageDays / 30);

      // Relay score: logarithmic scaling with diminishing returns
      // log2(relayCount + 1) / log2(1001) gives ~1.0 at 1000 relays
      const relayScore = Math.min(
        1.0,
        Math.log2(proof.claims.minRelayCount + 1) / Math.log2(1001),
      );

      weightedRelayScore += relayScore * recencyWeight;
      weightedReciprocityScore += proof.claims.minReciprocityScore * recencyWeight;
      totalWeight += recencyWeight;
    }

    if (totalWeight === 0) return 0;

    const avgRelayScore = weightedRelayScore / totalWeight;
    const avgReciprocityScore = weightedReciprocityScore / totalWeight;

    // Proof volume bonus: more proofs = more trust (capped contribution)
    const volumeBonus = Math.min(0.2, proofs.length * 0.04);

    // Combine: 40% relay score + 40% reciprocity + 20% volume bonus
    const rawScore = avgRelayScore * 0.4 + avgReciprocityScore * 0.4 + volumeBonus;

    return Math.max(0, Math.min(1, rawScore));
  }

  /**
   * Checks whether a proof meets minimum relay count and reciprocity thresholds.
   *
   * @param proof - The reputation proof to check.
   * @param minRelays - Minimum required relay count.
   * @param minScore - Minimum required reciprocity score.
   */
  meetsThreshold(proof: ReputationProof, minRelays: number, minScore: number): boolean {
    return (
      proof.claims.minRelayCount >= minRelays &&
      proof.claims.minReciprocityScore >= minScore
    );
  }
}
