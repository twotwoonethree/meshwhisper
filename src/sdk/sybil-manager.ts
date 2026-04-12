// ============================================================
// MeshWhisper SDK — Sybil Manager
//
// Wires EntropyChallenger and ZKRelayReputation into the SDK:
//
//   EntropyChallenger: proof-of-physical-device via sensor data.
//     - Issues challenges to newly-connected peers.
//     - Verifies responses; updates per-peer entropy confidence scores.
//     - Peers that fail or skip challenges get a lower relay trust score.
//
//   ZKRelayReputation: hash-commitment proofs of relay history.
//     - Generates local proofs from RelayLedger data.
//     - Stores and verifies incoming proofs from peers.
//     - Combines proof score with entropy score into getRelayTrustScore().
//
// Relay trust score (0–1):
//   - Unknown peer:        0.5 (neutral — don't block new contacts)
//   - Entropy-verified:    0.5 + entropy_confidence * 0.3
//   - Entropy-failed:      0.1 (actively blocked as relay)
//   - Good reputation:     boosted up to 1.0 by reputation score
//
// The 0.15 threshold in maybeRelay means only actively-failed peers are
// blocked; unverified and unknown peers continue to relay normally.
// ============================================================

import type { EntropyChallenge, EntropyResponse, EntropySensorType } from '../types.js';
import { EntropyChallenger, ZKRelayReputation } from '../sybil/index.js';
import type { ReputationProof } from '../sybil/index.js';
import { RelayLedger } from '../reciprocity/index.js';
import { uint8ArrayToHex } from './utils.js';

/** Relay trust score below which a peer will not be relayed for. */
export const RELAY_TRUST_FLOOR = 0.15;

// Wire format for reputation proof in control messages (all Uint8Arrays → number[])
export interface SerializedReputationProof {
  peerId: string;
  commitment: number[];
  proof: number[];
  claims: {
    minRelayCount: number;
    periodDays: number;
    minReciprocityScore: number;
  };
  timestamp: number;
}

export class SybilManager {
  private readonly challenger: EntropyChallenger;
  private readonly reputation: ZKRelayReputation;

  // Per-peer entropy confidence: 0.0 = failed, 0.5 = unverified, 0.8+ = verified
  private readonly entropyScores: Map<string, number> = new Map();

  // Pending outbound challenges: hex challengeId → { challenge, peerId }
  private readonly pendingChallenges: Map<string, { challenge: EntropyChallenge; peerId: string }> = new Map();

  // Incoming reputation proofs per peer (keep most recent 3)
  private readonly peerProofs: Map<string, ReputationProof[]> = new Map();

  // Derived reputation scores per peer
  private readonly reputationScores: Map<string, number> = new Map();

  // Our own most-recently-generated proof
  private localProof: ReputationProof | null = null;

  constructor(private readonly localPeerId: string) {
    this.challenger = new EntropyChallenger();
    this.reputation = new ZKRelayReputation(localPeerId);
  }

  // ----------------------------------------------------------------
  // Relay trust
  // ----------------------------------------------------------------

  /**
   * Combined relay trust score for `peerId`.
   * Range 0–1. Unknown peers score 0.5 so they're not blocked.
   */
  getRelayTrustScore(peerId: string): number {
    const entropy = this.entropyScores.get(peerId) ?? 0.5;
    const rep = this.reputationScores.get(peerId) ?? 0.5;
    // Entropy failure is a hard signal — cap the combined score
    if (entropy < 0.2) return entropy;
    // Otherwise: 50% entropy, 50% reputation
    return (entropy + rep) / 2;
  }

  // ----------------------------------------------------------------
  // Entropy challenges
  // ----------------------------------------------------------------

  /**
   * Creates an entropy challenge for `peerId` and returns the
   * serialized challenge bytes to embed in a control message.
   */
  createChallenge(peerId: string, sensorType: EntropySensorType = 'accelerometer'): {
    challengeData: number[];
    challengeId: string;
  } {
    const challenge = this.challenger.createChallenge(sensorType);
    const challengeIdHex = uint8ArrayToHex(challenge.challengeId);
    this.pendingChallenges.set(challengeIdHex, { challenge, peerId });
    const serialized = this.challenger.serializeChallenge(challenge);
    return {
      challengeData: Array.from(serialized),
      challengeId: challengeIdHex,
    };
  }

  /**
   * Deserializes a received challenge (from a control message) so the
   * app can collect sensor data and call processEntropyResponse().
   */
  deserializeChallenge(data: number[]): EntropyChallenge {
    return this.challenger.deserializeChallenge(new Uint8Array(data));
  }

  /**
   * Creates a signed entropy response given sensor readings.
   * The signing key is the identity's Ed25519 private key.
   */
  createResponse(
    challenge: EntropyChallenge,
    sensorData: Float64Array,
    signingKey: Uint8Array,
  ): { responseData: number[] } {
    const response = this.challenger.createResponse(challenge, sensorData, signingKey);
    const serialized = this.challenger.serializeResponse(response);
    return { responseData: Array.from(serialized) };
  }

  /**
   * Verifies an entropy response from `peerId` and records the result.
   * Called when we receive an entropy_response control message.
   */
  processEntropyResponse(
    responseData: number[],
    fromPeerId: string,
    peerEdPublicKey: Uint8Array,
  ): void {
    let response: EntropyResponse;
    try {
      response = this.challenger.deserializeResponse(new Uint8Array(responseData));
    } catch {
      // Malformed response — treat as failed
      this.entropyScores.set(fromPeerId, 0.05);
      return;
    }

    const challengeIdHex = uint8ArrayToHex(response.challengeId);
    const pending = this.pendingChallenges.get(challengeIdHex);
    if (!pending || pending.peerId !== fromPeerId) {
      // Unsolicited response — ignore
      return;
    }
    this.pendingChallenges.delete(challengeIdHex);

    const result = this.challenger.verifyResponse(pending.challenge, response, peerEdPublicKey);
    this.entropyScores.set(fromPeerId, result.valid ? result.confidence : 0.05);
  }

  // ----------------------------------------------------------------
  // Reputation proofs
  // ----------------------------------------------------------------

  /**
   * Generates our local reputation proof from the relay ledger.
   * Call periodically (e.g. every hour) and after significant relay activity.
   */
  buildLocalProof(ledger: RelayLedger, signingKey: Uint8Array): SerializedReputationProof {
    const entries = ledger.getAllEntries();
    const relayCount = entries.reduce((sum, e) => sum + e.bytesRelayedForThem, 0);
    // Convert bytes to a rough message count (avg ~512 bytes per blob)
    const relayMessages = Math.floor(relayCount / 512);
    const reciprocityScore = Math.min(1.0, ledger.getGlobalScore());

    this.localProof = this.reputation.generateProof(
      relayMessages,
      30, // period: rolling 30 days
      reciprocityScore,
      signingKey,
    );

    return this.serializeProof(this.localProof);
  }

  getLocalProof(): SerializedReputationProof | null {
    return this.localProof ? this.serializeProof(this.localProof) : null;
  }

  /**
   * Accepts and verifies an incoming reputation proof from a peer.
   * Updates the peer's reputation score.
   */
  acceptReputationProof(
    serialized: SerializedReputationProof,
    fromPeerId: string,
    peerEdPublicKey: Uint8Array,
  ): void {
    const proof = this.deserializeProof(serialized);
    if (!this.reputation.verifyProof(proof, peerEdPublicKey)) return;

    const existing = this.peerProofs.get(fromPeerId) ?? [];
    const updated = [...existing, proof]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 3); // keep most recent 3
    this.peerProofs.set(fromPeerId, updated);
    this.reputationScores.set(fromPeerId, this.reputation.getReputationScore(updated));
  }

  // ----------------------------------------------------------------
  // Serialization helpers
  // ----------------------------------------------------------------

  private serializeProof(proof: ReputationProof): SerializedReputationProof {
    return {
      peerId: proof.peerId,
      commitment: Array.from(proof.commitment),
      proof: Array.from(proof.proof),
      claims: proof.claims,
      timestamp: proof.timestamp,
    };
  }

  private deserializeProof(s: SerializedReputationProof): ReputationProof {
    return {
      peerId: s.peerId,
      commitment: new Uint8Array(s.commitment),
      proof: new Uint8Array(s.proof),
      claims: s.claims,
      timestamp: s.timestamp,
    };
  }
}
