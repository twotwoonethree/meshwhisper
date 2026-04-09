// ============================================================
// MeshWhisper SDK — Double Ratchet Module
// Per-message forward secrecy using the Signal Double Ratchet algorithm.
// ============================================================

import { x25519 } from '@noble/curves/ed25519';
import { blake3 } from '@noble/hashes/blake3';
import { concatBytes } from '@noble/hashes/utils';
import { gcm } from '@noble/ciphers/aes';
import type { KeyPair } from '../types.js';

// ---- Constants ----

const MAX_SKIP = 1000;
const KEY_LENGTH = 32;
const GCM_NONCE_LENGTH = 12;

// ---- Interfaces ----

export interface RatchetHeader {
  dhPublicKey: Uint8Array;
  previousChainLength: number;
  messageNumber: number;
}

export interface RatchetState {
  dhSending: KeyPair;
  dhReceiving: Uint8Array | null;
  rootKey: Uint8Array;
  sendingChainKey: Uint8Array | null;
  receivingChainKey: Uint8Array | null;
  sendMessageNumber: number;
  receiveMessageNumber: number;
  previousSendingChainLength: number;
  skippedMessageKeys: Map<string, Uint8Array>;
}

// ---- Key helpers ----

/** Generate a fresh X25519 keypair for the DH ratchet. */
function generateDHKeyPair(): KeyPair {
  const secretKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(secretKey);
  return { privateKey: secretKey, publicKey };
}

/** Compute an X25519 shared secret. */
function dh(keyPair: KeyPair, publicKey: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(keyPair.privateKey, publicKey);
}

// ---- KDF operations ----

/**
 * KDF root step: derive a new root key and chain key from a root key and DH output.
 * output = BLAKE3(rootKey || dhOutput, dkLen=64), split into two 32-byte halves.
 */
export function kdfRootStep(
  rootKey: Uint8Array,
  dhOutput: Uint8Array,
): { newRootKey: Uint8Array; chainKey: Uint8Array } {
  const input = concatBytes(rootKey, dhOutput);
  const output = blake3(input, { dkLen: 64, key: rootKey });
  return {
    newRootKey: output.slice(0, KEY_LENGTH),
    chainKey: output.slice(KEY_LENGTH, KEY_LENGTH * 2),
  };
}

/**
 * KDF chain step: derive a message key and the next chain key from the current chain key.
 * messageKey  = BLAKE3(chainKey || 0x01)
 * newChainKey = BLAKE3(chainKey || 0x02)
 */
export function kdfChainStep(
  chainKey: Uint8Array,
): { newChainKey: Uint8Array; messageKey: Uint8Array } {
  const messageKey = blake3(concatBytes(chainKey, new Uint8Array([0x01])));
  const newChainKey = blake3(concatBytes(chainKey, new Uint8Array([0x02])));
  return { newChainKey, messageKey };
}

// ---- Skipped-key bookkeeping ----

/** Build a map key for a skipped message from the sender's DH public key and the message number. */
function skippedKeyId(dhPublicKey: Uint8Array, messageNumber: number): string {
  // Encode as hex(dhPub) + ":" + messageNumber for uniqueness.
  let hex = '';
  for (let i = 0; i < dhPublicKey.length; i++) {
    hex += dhPublicKey[i].toString(16).padStart(2, '0');
  }
  return hex + ':' + messageNumber;
}

/**
 * Skip ahead in the receiving chain, storing message keys for out-of-order messages.
 * Throws if too many messages would be skipped (DoS protection).
 */
function skipMessageKeys(
  state: RatchetState,
  until: number,
): RatchetState {
  if (state.receivingChainKey === null) {
    return state;
  }

  if (until - state.receiveMessageNumber > MAX_SKIP) {
    throw new Error(
      `Cannot skip more than ${MAX_SKIP} messages (requested skip of ${until - state.receiveMessageNumber})`,
    );
  }

  const skippedMessageKeys = new Map(state.skippedMessageKeys);
  let chainKey = state.receivingChainKey;
  let n = state.receiveMessageNumber;

  while (n < until) {
    const { newChainKey, messageKey } = kdfChainStep(chainKey);
    const id = skippedKeyId(state.dhReceiving!, n);
    skippedMessageKeys.set(id, messageKey);
    chainKey = newChainKey;
    n++;
  }

  return {
    ...state,
    receivingChainKey: chainKey,
    receiveMessageNumber: n,
    skippedMessageKeys,
  };
}

// ---- DH ratchet step ----

/**
 * Perform a DH ratchet step: compute new root key / receiving chain key from the
 * remote's new public key, then generate a new sending keypair and compute the
 * sending chain key.
 */
export function dhRatchetStep(
  state: RatchetState,
  remotePublicKey: Uint8Array,
): RatchetState {
  const previousSendingChainLength = state.sendMessageNumber;

  // Receiving side: DH with our current sending keypair and their new public key.
  const dhReceiveOutput = dh(state.dhSending, remotePublicKey);
  const { newRootKey: rootKey1, chainKey: receivingChainKey } = kdfRootStep(
    state.rootKey,
    dhReceiveOutput,
  );

  // Sending side: generate new DH keypair, compute DH with new keypair and their public key.
  const dhSending = generateDHKeyPair();
  const dhSendOutput = dh(dhSending, remotePublicKey);
  const { newRootKey: rootKey2, chainKey: sendingChainKey } = kdfRootStep(
    rootKey1,
    dhSendOutput,
  );

  return {
    ...state,
    dhSending,
    dhReceiving: remotePublicKey,
    rootKey: rootKey2,
    sendingChainKey,
    receivingChainKey,
    sendMessageNumber: 0,
    receiveMessageNumber: 0,
    previousSendingChainLength,
  };
}

// ---- Encrypt / Decrypt helpers ----

/** Encrypt plaintext with AES-256-GCM using a message key. Nonce is derived deterministically. */
function aesEncrypt(
  messageKey: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  // Derive a nonce from the message key via BLAKE3 to avoid needing random state.
  const nonce = blake3(messageKey, { dkLen: GCM_NONCE_LENGTH });
  const cipher = gcm(messageKey, nonce);
  const ciphertext = cipher.encrypt(plaintext);
  // Prepend nonce so the receiver can decrypt.
  return concatBytes(nonce, ciphertext);
}

/** Decrypt ciphertext produced by aesEncrypt. */
function aesDecrypt(
  messageKey: Uint8Array,
  nonceAndCiphertext: Uint8Array,
): Uint8Array {
  const nonce = nonceAndCiphertext.slice(0, GCM_NONCE_LENGTH);
  const ciphertext = nonceAndCiphertext.slice(GCM_NONCE_LENGTH);
  const cipher = gcm(messageKey, nonce);
  return cipher.decrypt(ciphertext);
}

// ---- Initialization ----

/**
 * Initialize the ratchet state as the sender (initiator) after X3DH.
 *
 * The sender knows the shared secret and the remote's signed pre-key (or ratchet public key).
 * It performs the first DH ratchet step immediately so it can begin sending.
 */
export function initSender(
  sharedSecret: Uint8Array,
  remotePublicKey: Uint8Array,
): RatchetState {
  const dhSending = generateDHKeyPair();
  const dhOutput = dh(dhSending, remotePublicKey);
  const { newRootKey, chainKey } = kdfRootStep(sharedSecret, dhOutput);

  return {
    dhSending,
    dhReceiving: remotePublicKey,
    rootKey: newRootKey,
    sendingChainKey: chainKey,
    receivingChainKey: null,
    sendMessageNumber: 0,
    receiveMessageNumber: 0,
    previousSendingChainLength: 0,
    skippedMessageKeys: new Map(),
  };
}

/**
 * Initialize the ratchet state as the receiver (responder) after X3DH.
 *
 * The receiver provides its own keypair (the signed pre-key used in X3DH) and
 * the shared secret. It waits for the first message to complete the DH ratchet.
 */
export function initReceiver(
  sharedSecret: Uint8Array,
  localKeyPair: KeyPair,
): RatchetState {
  return {
    dhSending: localKeyPair,
    dhReceiving: null,
    rootKey: sharedSecret,
    sendingChainKey: null,
    receivingChainKey: null,
    sendMessageNumber: 0,
    receiveMessageNumber: 0,
    previousSendingChainLength: 0,
    skippedMessageKeys: new Map(),
  };
}

// ---- Encrypt ----

/**
 * Encrypt a plaintext message, advancing the sending chain.
 *
 * Returns the updated state, a header (to be sent alongside the ciphertext), and
 * the AES-256-GCM ciphertext.
 */
export function ratchetEncrypt(
  state: RatchetState,
  plaintext: Uint8Array,
): { state: RatchetState; header: RatchetHeader; ciphertext: Uint8Array } {
  if (state.sendingChainKey === null) {
    throw new Error('Sending chain not initialized — cannot encrypt before the first DH ratchet step');
  }

  const { newChainKey, messageKey } = kdfChainStep(state.sendingChainKey);

  const header: RatchetHeader = {
    dhPublicKey: state.dhSending.publicKey,
    previousChainLength: state.previousSendingChainLength,
    messageNumber: state.sendMessageNumber,
  };

  const ciphertext = aesEncrypt(messageKey, plaintext);

  const newState: RatchetState = {
    ...state,
    sendingChainKey: newChainKey,
    sendMessageNumber: state.sendMessageNumber + 1,
  };

  return { state: newState, header, ciphertext };
}

// ---- Decrypt ----

/**
 * Decrypt a received message, handling DH ratchet steps and out-of-order delivery.
 *
 * 1. Try skipped message keys first (for out-of-order messages).
 * 2. If the header's DH public key differs from our stored remote key, perform
 *    a DH ratchet step (advancing the root chain).
 * 3. Advance the receiving chain to the header's message number, storing any
 *    skipped message keys along the way.
 * 4. Decrypt with the derived message key.
 */
export function ratchetDecrypt(
  state: RatchetState,
  header: RatchetHeader,
  ciphertext: Uint8Array,
): { state: RatchetState; plaintext: Uint8Array } {
  // 1. Check skipped message keys.
  const skippedId = skippedKeyId(header.dhPublicKey, header.messageNumber);
  const skippedKey = state.skippedMessageKeys.get(skippedId);
  if (skippedKey !== undefined) {
    const skippedMessageKeys = new Map(state.skippedMessageKeys);
    skippedMessageKeys.delete(skippedId);
    const plaintext = aesDecrypt(skippedKey, ciphertext);
    return {
      state: { ...state, skippedMessageKeys },
      plaintext,
    };
  }

  let currentState = state;

  // 2. DH ratchet step if the remote key has changed.
  const remoteKeyChanged =
    currentState.dhReceiving === null ||
    !bytesEqual(header.dhPublicKey, currentState.dhReceiving);

  if (remoteKeyChanged) {
    // Skip any remaining messages on the old receiving chain.
    if (currentState.dhReceiving !== null && currentState.receivingChainKey !== null) {
      currentState = skipMessageKeys(currentState, header.previousChainLength);
    }
    currentState = dhRatchetStep(currentState, header.dhPublicKey);
  }

  // 3. Skip messages on the current receiving chain up to this message number.
  currentState = skipMessageKeys(currentState, header.messageNumber);

  // 4. Derive the message key.
  if (currentState.receivingChainKey === null) {
    throw new Error('Receiving chain key is null — protocol state error');
  }
  const { newChainKey, messageKey } = kdfChainStep(currentState.receivingChainKey);

  const plaintext = aesDecrypt(messageKey, ciphertext);

  return {
    state: {
      ...currentState,
      receivingChainKey: newChainKey,
      receiveMessageNumber: currentState.receiveMessageNumber + 1,
    },
    plaintext,
  };
}

// ---- Utility ----

/** Constant-time(ish) byte array comparison. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}
