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
  __mw_ctrl: 'delivered' | 'read' | 'typing_start' | 'typing_stop';
  messageId?: string;
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
}
