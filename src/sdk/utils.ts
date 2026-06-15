// ============================================================
// MeshWhisper SDK — Shared utilities
// Pure functions only; no side effects, no external state.
// ============================================================

import { randomBytes } from '../crypto/index.js';
import type { RatchetHeader } from '../ratchet/index.js';

// ============================================================
// Hex / Base64 encoding
// ============================================================

export function uint8ArrayToHex(arr: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < arr.length; i++) {
    hex += arr[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

export function hexToUint8Array(hex: string): Uint8Array {
  const len = hex.length >>> 1;
  const arr = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return arr;
}

export function uint8ArrayToBase64(arr: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(arr).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i]!);
  }
  return btoa(binary);
}

export function base64ToUint8Array(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function generateMessageId(): string {
  const bytes = randomBytes(16);
  return uint8ArrayToHex(bytes);
}

// ============================================================
// Ratchet Header Serialization
//
// Wire format:
//   [32 bytes dhPublicKey] [4 bytes previousChainLength BE] [4 bytes messageNumber BE]
// ============================================================

export const RATCHET_HEADER_SIZE = 40;

export function serializeRatchetHeader(header: RatchetHeader): Uint8Array {
  const buf = new Uint8Array(RATCHET_HEADER_SIZE);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  buf.set(header.dhPublicKey, 0);
  view.setUint32(32, header.previousChainLength, false);
  view.setUint32(36, header.messageNumber, false);

  return buf;
}

export function deserializeRatchetHeader(
  data: Uint8Array,
): { header: RatchetHeader; ciphertextBody: Uint8Array } {
  if (data.length < RATCHET_HEADER_SIZE) {
    throw new Error('Data too short for ratchet header');
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const header: RatchetHeader = {
    dhPublicKey: data.slice(0, 32),
    previousChainLength: view.getUint32(32, false),
    messageNumber: view.getUint32(36, false),
  };

  const ciphertextBody = data.slice(RATCHET_HEADER_SIZE);

  return { header, ciphertextBody };
}

// ============================================================
// Control messages
// ============================================================

export interface ControlMessage {
  __mw_ctrl:
    | 'delivered'
    | 'read'
    | 'typing_start'
    | 'typing_stop'
    | 'entropy_challenge'
    | 'entropy_response'
    | 'reputation_proof'
    | 'contact_request'
    | 'group_invite'
    | 'group_leave'
    | 'group_member_added'
    | 'group_member_kicked'
    | 'group_admin_change'
    | 'group_rename'
    | 'delete'
    | 'handshake_activate'
    | 'request_history'
    | 'history_replay'
    | 'session_ping'
    | 'session_pong'
    | 'device_added'
    | 'device_revoked'
    | 'device_linked'
    | 'reaction'
    | 'disappearing_messages'
    | 'sync_send';
  /** session_ping / session_pong correlation id. */
  sessionPingId?: string;
  /** history_replay: a chunk of historical messages from the sender's view. */
  historyMessages?: Array<{
    id: string;
    senderId: string;
    recipientId: string;
    payload: number[];
    timestamp: number;
    expiresAt?: number;
    /** group messages: original group sender */
    groupSenderId?: string;
  }>;
  /** history_replay: 0-indexed chunk number for ordering. */
  historyChunkIndex?: number;
  /** history_replay: total number of chunks in this restore. */
  historyChunkTotal?: number;
  /** request_history: only ask for messages after this ms epoch (optional). */
  historySince?: number;
  /** group_leave / group_invite / group_member_added / group_admin_change / group_member_kicked reference */
  groupId?: string;
  /** group_member_added: peerId of the newly added member */
  addedPeerId?: string;
  /** group_member_added: ed25519 identity key of the newly added member */
  addedEdKey?: number[];
  /** group_member_added: sender key the admin generated for the new member */
  addedSenderKey?: number[];
  /**
   * group_admin_change: peerId of the new admin, or '' for adminless.
   * The current admin is the only sender allowed to issue this.
   */
  newAdminId?: string;
  /** group_member_kicked: peerId of the kicked member. Only the current admin may issue this. */
  kickedPeerId?: string;
  /** group_rename: the new group name. Only the current admin may issue this. */
  newGroupName?: string;
  /**
   * sync_send: self-fan-out from another device of the same account.
   * The receiver verifies the sender shares the local account key before
   * applying the message as outbound to the named conversation.
   */
  syncRecipientId?: string;
  syncIsGroup?: boolean;
  syncMessageId?: string;
  syncTimestamp?: number;
  syncPayload?: number[];
  syncReplyTo?: { messageId: string; snippetText?: string };
  syncForwardedFrom?: string;
  syncExpiry?: number;
  messageId?: string;
  // entropy_challenge
  challengeData?: number[];
  // entropy_response
  responseData?: number[];
  // reputation_proof
  reputationProof?: {
    peerId: string;
    commitment: number[];
    proof: number[];
    claims: { minRelayCount: number; periodDays: number; minReciprocityScore: number };
    timestamp: number;
  };
  // contact_request (introduction)
  contactRequest?: {
    introducedPeerId: string;
    introducedPublicKey: number[];
    introducedBy: string;
    username?: string;
  };
  // group_invite
  groupInvite?: {
    groupId: string;
    groupName: string;
    invitedBy: string;
    members: string[];
    senderKeys: Record<string, number[]>;
    /** Per-member Ed25519 keys; needed for X3DH lookup between non-creator members. */
    memberEdKeys?: Record<string, number[]>;
  };
  // device_added / device_revoked — multi-device phase B. The sender's
  // accountKey signs (Ed25519) over the canonical message:
  //   "meshwhisper.device-added.v1\n{accountKey}\n{newDeviceKey}\n{addedAt}"
  //   "meshwhisper.device-revoked.v1\n{accountKey}\n{revokedDeviceKey}\n{revokedAt}"
  // Receivers MUST verify the signature against the sender's accountKey
  // (which, in phase B, equals the sender's peerId since accountKey ===
  // primary-device key for now).
  deviceAnnouncement?: {
    accountKey: string;          // hex; the signer
    deviceKey: string;           // hex; the device being added or revoked
    eventAt: number;             // unix ms; addedAt or revokedAt
    signature: string;           // base64; 64 raw bytes
  };
  /** reaction: the emoji being toggled. Caller's choice; the SDK treats
   *  it as an opaque string and does no validation. */
  reactionEmoji?: string;
  /** reaction: true to add this peer's reaction, false to remove. */
  reactionAdd?: boolean;
  /** disappearing_messages: per-conversation TTL in milliseconds.
   *  null or 0 disables the policy. The peer applies the same value to
   *  their own send-side default so both sides stay in sync. */
  disappearingTtlMs?: number | null;
  // device_linked — sent by the primary to a freshly-linked secondary
  // immediately after accepting its DeviceLinkOffer. Carries the
  // signed device_added announcement so the secondary can verify its
  // own membership, plus a snapshot of the primary's contact list so
  // the secondary can bootstrap its routing.
  deviceLinked?: {
    /** Echo of the offer's linkChallenge so the secondary can confirm
     *  this payload corresponds to the offer it actually showed. */
    linkChallenge: string;
    /** Signed device_added announcement adding the secondary's
     *  deviceKey to the primary's accountKey. Validated by the
     *  secondary on receipt. */
    deviceAnnouncement: {
      accountKey: string;
      deviceKey: string;
      eventAt: number;
      signature: string;
    };
    /** Account/device snapshot of the primary's PermissionManager.
     *  X25519 peerIds throughout (PermissionManager convention). */
    contactRecords: Array<{ accountKey: string; deviceKeys: string[] }>;
  };
}

export function tryParseControl(payload: Uint8Array): ControlMessage | null {
  try {
    const text = new TextDecoder().decode(payload);
    if (!text.startsWith('{')) return null;
    const obj = JSON.parse(text) as Record<string, unknown>;
    if (typeof obj.__mw_ctrl !== 'string') return null;
    return obj as unknown as ControlMessage;
  } catch {
    return null;
  }
}

export function isControlPayload(payload: Uint8Array): boolean {
  return tryParseControl(payload) !== null;
}

// ============================================================
// Internal message envelope (serialized inside encrypted payload)
// ============================================================

export interface MessageEnvelope {
  id: string;
  senderId: string;
  recipientId: string;
  payload: number[]; // serialized Uint8Array
  timestamp: number;
  urgency: string;
  expiry?: number;
  group?: {
    groupId: string;
    senderId: string;
  };
  ratchetHeader?: {
    dhPublicKey: number[];
    previousChainLength: number;
    messageNumber: number;
  };
  /** Set when the sender used SendOptions.replyTo. Carries the original
   *  message ID + an optional preview snippet so the receiver can render
   *  the quote without looking up the source. */
  replyTo?: { messageId: string; snippetText?: string };
  /** Set when the sender used SendOptions.forwardedFrom or
   *  MeshWhisper.forwardMessage. The peerId of the message's original
   *  sender (NOT the forwarder — that's `senderId`). */
  forwardedFrom?: string;
}

// ============================================================
// Handshake envelope (serialized inside HANDSHAKE packets)
// ============================================================

export interface HandshakeEnvelope {
  type: 'x3dh_init' | 'x3dh_response' | 'prekey_bundle';
  senderId: string;
  preKeyBundle?: number[]; // serialized PreKeyBundle
  ephemeralPublicKey?: number[];
  identityKey?: number[];
  // Public key of the one-time pre-key Alice consumed, so Bob can look up
  // the corresponding private key to complete DH4. Absent when no OPK was used.
  usedOneTimePreKeyPublic?: number[];
  // ML-KEM-768 ciphertext (1088 bytes). Present when Alice performed PQXDH.
  pqCiphertext?: number[];
  // The sender's namespace id — present ONLY when the sender opted into
  // cross-namespace interop (ADR-009). Lets the receiver address replies into
  // the sender's namespace. Absent for normal same-namespace apps (default),
  // so the envelope is byte-identical to before for them.
  senderNamespace?: number[];
}
