// ============================================================
// MeshWhisper federation — onion routing for transit hops (ADR-010 stage-3+)
//
// A packet routed across the relay mesh is wrapped in nested encryption layers,
// one per relay on the path. Each relay peels exactly its own layer (sealed to
// its X25519 onion key) and learns ONLY the next hop — never the final
// destination or the packet. The innermost layer, openable solely by the
// destination relay, carries the actual packet for local delivery.
//
// Each layer is an anonymous sealed box: an ephemeral X25519 key → ECDH with
// the hop's static onion key → HKDF-SHA256 → AES-256-GCM. The sender is
// unauthenticated to the hop (sealed-box semantics), which is what we want —
// an intermediate must not learn who originated the onion.
// ============================================================

import * as crypto from 'node:crypto';

// DER wrappers so node:crypto can ingest raw X25519 key bytes (OID 1.3.101.110).
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

const HKDF_INFO = Buffer.from('meshwhisper-onion-v1', 'utf8');
const EPH_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const LAYER_OVERHEAD = EPH_LEN + IV_LEN + TAG_LEN;

// Layer plaintext type byte.
const T_FORWARD = 0x00; // [0x00][nextPubkey:32][innerOnion]
const T_DELIVER = 0x01; // [0x01][packet]

export interface OnionHop {
  pubkey: string;   // hex ed25519 federation pubkey — how the prior hop addresses this relay
  onionKey: string; // hex X25519 onion public key — what this hop's layer is sealed to
}

export type OnionResult =
  | { type: 'forward'; next: string; inner: Buffer }
  | { type: 'deliver'; inner: Buffer };

function importPublic(rawHexOr32: string | Buffer): crypto.KeyObject {
  const raw = typeof rawHexOr32 === 'string' ? Buffer.from(rawHexOr32, 'hex') : rawHexOr32;
  return crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

function importPrivate(pkcs8Base64: string): crypto.KeyObject {
  return crypto.createPrivateKey({ key: Buffer.from(pkcs8Base64, 'base64'), format: 'der', type: 'pkcs8' });
}

function rawPublic(key: crypto.KeyObject): Buffer {
  const spki = key.export({ format: 'der', type: 'spki' }) as Buffer;
  return spki.subarray(spki.length - 32);
}

function deriveKey(shared: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.alloc(0), HKDF_INFO, 32));
}

/** Generate a relay's persistent X25519 onion keypair. */
export function generateOnionKeypair(): { publicKeyHex: string; privatePkcs8Base64: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  return { publicKeyHex: rawPublic(publicKey).toString('hex'), privatePkcs8Base64: pkcs8.toString('base64') };
}

/** Seal `plaintext` to `recipientOnionKeyHex` as an anonymous sealed box. */
function seal(recipientOnionKeyHex: string, plaintext: Buffer): Buffer {
  const eph = crypto.generateKeyPairSync('x25519');
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: importPublic(recipientOnionKeyHex) });
  const key = deriveKey(shared);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([rawPublic(eph.publicKey), iv, tag, ct]);
}

/**
 * Build a full onion for an ordered path of hops. The last hop is the
 * destination relay (it peels to a `deliver`); every earlier hop peels to a
 * `forward` naming the next hop. Returned blob is sent to `hops[0]`.
 */
export function sealOnion(hops: OnionHop[], packet: Buffer): Buffer {
  if (hops.length === 0) throw new Error('onion path is empty');
  let blob = seal(hops[hops.length - 1].onionKey, Buffer.concat([Buffer.from([T_DELIVER]), packet]));
  for (let i = hops.length - 2; i >= 0; i--) {
    const next = Buffer.from(hops[i + 1].pubkey, 'hex'); // 32-byte federation pubkey
    blob = seal(hops[i].onionKey, Buffer.concat([Buffer.from([T_FORWARD]), next, blob]));
  }
  return blob;
}

/**
 * Peel exactly one layer with our onion private key. Returns the next hop +
 * inner onion (forward), or the delivered packet (deliver), or null if the
 * layer isn't ours / is malformed (drop silently — it isn't addressed to us).
 */
export function openOnion(privPkcs8Base64: string, blob: Buffer): OnionResult | null {
  if (blob.length < LAYER_OVERHEAD + 1) return null;
  const ephPub = blob.subarray(0, EPH_LEN);
  const iv = blob.subarray(EPH_LEN, EPH_LEN + IV_LEN);
  const tag = blob.subarray(EPH_LEN + IV_LEN, LAYER_OVERHEAD);
  const ct = blob.subarray(LAYER_OVERHEAD);
  let pt: Buffer;
  try {
    const shared = crypto.diffieHellman({ privateKey: importPrivate(privPkcs8Base64), publicKey: importPublic(ephPub) });
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(shared), iv);
    decipher.setAuthTag(tag);
    pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    return null; // GCM auth failure — not our layer
  }
  if (pt.length < 1) return null;
  if (pt[0] === T_DELIVER) return { type: 'deliver', inner: pt.subarray(1) };
  if (pt[0] === T_FORWARD && pt.length >= 33) return { type: 'forward', next: pt.subarray(1, 33).toString('hex'), inner: pt.subarray(33) };
  return null;
}
