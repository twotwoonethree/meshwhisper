// ============================================================
// MeshWhisper SDK — RatchetState serialization
// Converts between the in-memory RatchetState and a JSON string
// suitable for storage. All Uint8Array fields are hex-encoded.
// ============================================================

import type { RatchetState } from '../ratchet/index.js';

// ---- Helpers ----

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

// ---- Serialized shape ----

interface SerializedRatchetState {
  v: 1;
  dhSendingPriv: string;
  dhSendingPub: string;
  dhReceiving: string | null;
  rootKey: string;
  sendingChainKey: string | null;
  receivingChainKey: string | null;
  sendMessageNumber: number;
  receiveMessageNumber: number;
  previousSendingChainLength: number;
  skippedMessageKeys: Record<string, string>;
}

// ---- Public API ----

export function serializeRatchetState(state: RatchetState): string {
  const obj: SerializedRatchetState = {
    v: 1,
    dhSendingPriv: toHex(state.dhSending.privateKey),
    dhSendingPub: toHex(state.dhSending.publicKey),
    dhReceiving: state.dhReceiving ? toHex(state.dhReceiving) : null,
    rootKey: toHex(state.rootKey),
    sendingChainKey: state.sendingChainKey ? toHex(state.sendingChainKey) : null,
    receivingChainKey: state.receivingChainKey ? toHex(state.receivingChainKey) : null,
    sendMessageNumber: state.sendMessageNumber,
    receiveMessageNumber: state.receiveMessageNumber,
    previousSendingChainLength: state.previousSendingChainLength,
    skippedMessageKeys: Object.fromEntries(
      [...state.skippedMessageKeys.entries()].map(([k, v]) => [k, toHex(v)]),
    ),
  };
  return JSON.stringify(obj);
}

export function deserializeRatchetState(json: string): RatchetState {
  const obj = JSON.parse(json) as SerializedRatchetState;
  if (obj.v !== 1) throw new Error(`Unknown RatchetState version: ${obj.v}`);
  return {
    dhSending: {
      privateKey: fromHex(obj.dhSendingPriv),
      publicKey: fromHex(obj.dhSendingPub),
    },
    dhReceiving: obj.dhReceiving ? fromHex(obj.dhReceiving) : null,
    rootKey: fromHex(obj.rootKey),
    sendingChainKey: obj.sendingChainKey ? fromHex(obj.sendingChainKey) : null,
    receivingChainKey: obj.receivingChainKey ? fromHex(obj.receivingChainKey) : null,
    sendMessageNumber: obj.sendMessageNumber,
    receiveMessageNumber: obj.receiveMessageNumber,
    previousSendingChainLength: obj.previousSendingChainLength,
    skippedMessageKeys: new Map(
      Object.entries(obj.skippedMessageKeys).map(([k, v]) => [k, fromHex(v)]),
    ),
  };
}
