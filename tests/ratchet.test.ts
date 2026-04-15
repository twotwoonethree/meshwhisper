import { describe, it, expect } from 'vitest';
import {
  initSender,
  initReceiver,
  ratchetEncrypt,
  ratchetDecrypt,
  kdfRootStep,
  kdfChainStep,
} from '../src/ratchet/index.js';
import { x25519 } from '@noble/curves/ed25519';
import { randomBytes } from '../src/crypto/index.js';

function makeKeyPair() {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

function makeSharedSecret() {
  return randomBytes(32);
}

function enc(txt: string): Uint8Array {
  return new TextEncoder().encode(txt);
}

function dec(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

// ---- KDF primitives ----

describe('kdfRootStep', () => {
  it('returns 32-byte root key and chain key', () => {
    const { newRootKey, chainKey } = kdfRootStep(randomBytes(32), randomBytes(32));
    expect(newRootKey.length).toBe(32);
    expect(chainKey.length).toBe(32);
  });

  it('is deterministic', () => {
    const root = randomBytes(32);
    const dh = randomBytes(32);
    const a = kdfRootStep(root, dh);
    const b = kdfRootStep(root, dh);
    expect(a.newRootKey).toEqual(b.newRootKey);
    expect(a.chainKey).toEqual(b.chainKey);
  });

  it('different inputs produce different outputs', () => {
    const r = randomBytes(32);
    const a = kdfRootStep(r, randomBytes(32));
    const b = kdfRootStep(r, randomBytes(32));
    expect(a.newRootKey).not.toEqual(b.newRootKey);
  });
});

describe('kdfChainStep', () => {
  it('returns 32-byte chain key and message key', () => {
    const { newChainKey, messageKey } = kdfChainStep(randomBytes(32));
    expect(newChainKey.length).toBe(32);
    expect(messageKey.length).toBe(32);
  });

  it('chain key and message key are different', () => {
    const { newChainKey, messageKey } = kdfChainStep(randomBytes(32));
    expect(newChainKey).not.toEqual(messageKey);
  });

  it('advancing produces unique message keys', () => {
    let chainKey = randomBytes(32);
    const keys: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { newChainKey, messageKey } = kdfChainStep(chainKey);
      keys.push(Buffer.from(messageKey).toString('hex'));
      chainKey = newChainKey;
    }
    expect(new Set(keys).size).toBe(5);
  });
});

// ---- Basic send/receive ----

describe('initSender / initReceiver', () => {
  it('sender has a sending chain key, receiver has none', () => {
    const secret = makeSharedSecret();
    const bobKP = makeKeyPair();
    const sender = initSender(secret, bobKP.publicKey);
    const receiver = initReceiver(secret, bobKP);
    expect(sender.sendingChainKey).not.toBeNull();
    expect(receiver.sendingChainKey).toBeNull();
    expect(receiver.receivingChainKey).toBeNull();
  });
});

describe('ratchetEncrypt / ratchetDecrypt — single message', () => {
  it('encrypts and decrypts a message', () => {
    const secret = makeSharedSecret();
    const bobKP = makeKeyPair();
    let alice = initSender(secret, bobKP.publicKey);
    let bob = initReceiver(secret, bobKP);

    const plaintext = enc('hello bob');
    const { state: alice2, header, ciphertext } = ratchetEncrypt(alice, plaintext);
    alice = alice2;

    const { state: bob2, plaintext: decrypted } = ratchetDecrypt(bob, header, ciphertext);
    bob = bob2;

    expect(dec(decrypted)).toBe('hello bob');
  });

  it('wrong ciphertext throws', () => {
    const secret = makeSharedSecret();
    const bobKP = makeKeyPair();
    const alice = initSender(secret, bobKP.publicKey);
    const bob = initReceiver(secret, bobKP);

    const { header } = ratchetEncrypt(alice, enc('hi'));
    const badCiphertext = randomBytes(50);
    expect(() => ratchetDecrypt(bob, header, badCiphertext)).toThrow();
  });
});

describe('multi-message forward secrecy', () => {
  it('decrypts multiple sequential messages in order', () => {
    const secret = makeSharedSecret();
    const bobKP = makeKeyPair();
    let alice = initSender(secret, bobKP.publicKey);
    let bob = initReceiver(secret, bobKP);

    const messages = ['msg1', 'msg2', 'msg3', 'msg4', 'msg5'];
    const encrypted: Array<{ header: any; ciphertext: Uint8Array }> = [];

    for (const msg of messages) {
      const { state, header, ciphertext } = ratchetEncrypt(alice, enc(msg));
      alice = state;
      encrypted.push({ header, ciphertext });
    }

    for (let i = 0; i < messages.length; i++) {
      const { state, plaintext } = ratchetDecrypt(bob, encrypted[i].header, encrypted[i].ciphertext);
      bob = state;
      expect(dec(plaintext)).toBe(messages[i]);
    }
  });

  it('each message uses a unique key (ciphertexts differ for identical plaintext)', () => {
    const secret = makeSharedSecret();
    const bobKP = makeKeyPair();
    let alice = initSender(secret, bobKP.publicKey);

    const plaintext = enc('same message');
    const { state: s1, ciphertext: ct1 } = ratchetEncrypt(alice, plaintext);
    alice = s1;
    const { ciphertext: ct2 } = ratchetEncrypt(alice, plaintext);

    // Strip nonce prefix (12 bytes) and compare ciphertext bodies
    expect(ct1.slice(12)).not.toEqual(ct2.slice(12));
  });
});

describe('bidirectional messaging', () => {
  it('Alice and Bob can exchange messages in both directions', () => {
    const secret = makeSharedSecret();
    const bobKP = makeKeyPair();
    let alice = initSender(secret, bobKP.publicKey);
    let bob = initReceiver(secret, bobKP);

    // Alice → Bob
    {
      const { state, header, ciphertext } = ratchetEncrypt(alice, enc('from alice'));
      alice = state;
      const { state: b, plaintext } = ratchetDecrypt(bob, header, ciphertext);
      bob = b;
      expect(dec(plaintext)).toBe('from alice');
    }

    // Bob → Alice (Bob's sending chain was set up when he decrypted Alice's message)
    {
      const { state, header, ciphertext } = ratchetEncrypt(bob, enc('from bob'));
      bob = state;

      // Alice receives — her receiving key is Bob's new DH public key
      const { state: a, plaintext } = ratchetDecrypt(alice, header, ciphertext);
      alice = a;
      expect(dec(plaintext)).toBe('from bob');
    }
  });
});

describe('out-of-order delivery', () => {
  it('delivers message 3 before message 2 (skipped key recovery)', () => {
    const secret = makeSharedSecret();
    const bobKP = makeKeyPair();
    let alice = initSender(secret, bobKP.publicKey);
    let bob = initReceiver(secret, bobKP);

    const { state: s1, header: h1, ciphertext: ct1 } = ratchetEncrypt(alice, enc('msg1'));
    alice = s1;
    const { state: s2, header: h2, ciphertext: ct2 } = ratchetEncrypt(alice, enc('msg2'));
    alice = s2;
    const { state: s3, header: h3, ciphertext: ct3 } = ratchetEncrypt(alice, enc('msg3'));
    alice = s3;

    // Deliver 1, skip 2, deliver 3
    { const { state } = ratchetDecrypt(bob, h1, ct1); bob = state; }
    { const { state, plaintext } = ratchetDecrypt(bob, h3, ct3); bob = state; expect(dec(plaintext)).toBe('msg3'); }
    // Now deliver skipped msg2
    { const { state, plaintext } = ratchetDecrypt(bob, h2, ct2); bob = state; expect(dec(plaintext)).toBe('msg2'); }
  });

  it('throws when skip count exceeds MAX_SKIP', () => {
    const secret = makeSharedSecret();
    const bobKP = makeKeyPair();
    let alice = initSender(secret, bobKP.publicKey);
    const bob = initReceiver(secret, bobKP);

    // Encrypt 2001 messages so the last one requires skipping > MAX_SKIP (2000)
    let lastHeader: any;
    let lastCiphertext: Uint8Array = new Uint8Array();
    for (let i = 0; i <= 2001; i++) {
      const { state, header, ciphertext } = ratchetEncrypt(alice, enc(`msg${i}`));
      alice = state;
      lastHeader = header;
      lastCiphertext = ciphertext;
    }

    expect(() => ratchetDecrypt(bob, lastHeader, lastCiphertext)).toThrow();
  });
});

describe('initSender throws if no sending chain', () => {
  it('receiver cannot encrypt before a DH ratchet step', () => {
    const secret = makeSharedSecret();
    const bobKP = makeKeyPair();
    const bob = initReceiver(secret, bobKP);
    expect(() => ratchetEncrypt(bob, enc('hi'))).toThrow();
  });
});

// ---- Failure paths ----

describe('replay attack', () => {
  it('decrypting the same message twice throws', () => {
    const secret = makeSharedSecret();
    const bobKP = makeKeyPair();
    const alice = initSender(secret, bobKP.publicKey);
    let bob = initReceiver(secret, bobKP);

    const { header, ciphertext } = ratchetEncrypt(alice, enc('once'));
    const { state } = ratchetDecrypt(bob, header, ciphertext);
    bob = state;

    // Replaying the same (header, ciphertext) should throw — the message key
    // is consumed on first use and the skipped-key store won't have it.
    expect(() => ratchetDecrypt(bob, header, ciphertext)).toThrow();
  });
});

describe('session state independence', () => {
  it('two independent sessions with the same shared secret produce different ciphertexts', () => {
    // Each session has its own ephemeral ratchet keys, so even identical
    // plaintexts encrypted under the same initial secret diverge immediately.
    const secret = makeSharedSecret();
    const bobKP1 = makeKeyPair();
    const bobKP2 = makeKeyPair();

    const alice1 = initSender(secret, bobKP1.publicKey);
    const alice2 = initSender(secret, bobKP2.publicKey);

    const { ciphertext: ct1 } = ratchetEncrypt(alice1, enc('hello'));
    const { ciphertext: ct2 } = ratchetEncrypt(alice2, enc('hello'));

    expect(ct1).not.toEqual(ct2);
  });

  it('a message encrypted by one session cannot be decrypted by a receiver with a different shared secret', () => {
    const secret1 = makeSharedSecret();
    const secret2 = makeSharedSecret();
    const bobKP = makeKeyPair();

    const alice = initSender(secret1, bobKP.publicKey);
    // Bob was initialized with a different secret
    const bob = initReceiver(secret2, bobKP);

    const { header, ciphertext } = ratchetEncrypt(alice, enc('secret'));
    expect(() => ratchetDecrypt(bob, header, ciphertext)).toThrow();
  });
});

describe('session loss recovery', () => {
  it('mid-conversation state snapshot can resume decryption', () => {
    // Simulate saving state after N messages and restoring it.
    const secret = makeSharedSecret();
    const bobKP = makeKeyPair();
    let alice = initSender(secret, bobKP.publicKey);
    let bob = initReceiver(secret, bobKP);

    // Exchange a few messages to advance the ratchet
    for (let i = 0; i < 3; i++) {
      const { state: a, header, ciphertext } = ratchetEncrypt(alice, enc(`msg${i}`));
      alice = a;
      const { state: b } = ratchetDecrypt(bob, header, ciphertext);
      bob = b;
    }

    // Snapshot Bob's state (shallow clone simulates persistence round-trip)
    const bobSnapshot = { ...bob };

    // Continue with more messages
    const { state: a4, header: h4, ciphertext: ct4 } = ratchetEncrypt(alice, enc('msg3'));
    alice = a4;

    // Both the live and snapshot state should decrypt the next message
    const { state: liveState, plaintext: liveText } = ratchetDecrypt(bob, h4, ct4);
    const { plaintext: snapText } = ratchetDecrypt(bobSnapshot, h4, ct4);

    expect(dec(liveText)).toBe('msg3');
    expect(dec(snapText)).toBe('msg3');
  });
});

describe('tampered header', () => {
  it('wrong message counter in header causes decryption failure', () => {
    const secret = makeSharedSecret();
    const bobKP = makeKeyPair();
    const alice = initSender(secret, bobKP.publicKey);
    const bob = initReceiver(secret, bobKP);

    const { header, ciphertext } = ratchetEncrypt(alice, enc('hi'));

    // Corrupt the message counter — advances to a wrong key
    const badHeader = { ...header, messageNumber: header.messageNumber + 100 };
    expect(() => ratchetDecrypt(bob, badHeader, ciphertext)).toThrow();
  });
});
