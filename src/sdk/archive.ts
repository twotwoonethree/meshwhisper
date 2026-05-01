// ============================================================
// MeshWhisper SDK — Encrypted Archive
//
// Provides portable encrypted backup of message history,
// contacts, and peer state. The archive key is derived from
// the user's identity key via HKDF so the relay never sees it.
//
// Keys archived: contacts, peers/*, messages/*, seen_ids, blocked
// Keys excluded: identity (rederivable), sessions/* (forward secrecy),
//                prekeys/*, edkeys/*, opks/*, signed_pre_key, pq_*
// ============================================================

import type { StorageBackend } from '../persistence/types.js';

// ============================================================
// Internal format
// ============================================================

export interface ArchivePayload {
  version: 1;
  createdAt: number;
  peerId: string;
  relayUrl: string;
  kv: Record<string, string>;
  extra?: Record<string, unknown>;
}

// Storage key prefixes / names to include in the archive.
const ARCHIVE_PREFIXES = ['peers/', 'messages/'];
const ARCHIVE_SINGLE_KEYS = ['contacts', 'seen_ids', 'blocked'];

// Maximum archive size we'll attempt to upload (10 MB plaintext).
export const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;

// ============================================================
// Key derivation — from identity key bytes via HKDF
// ============================================================

export async function deriveBackupKey(identityKeyBytes: Uint8Array): Promise<Uint8Array> {
  const base = await globalThis.crypto.subtle.importKey(
    'raw', identityKeyBytes.buffer as ArrayBuffer, 'HKDF', false, ['deriveBits'],
  );
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('meshwhisper:archive:v1'),
      info: new TextEncoder().encode('backup-key'),
    },
    base,
    256,
  );
  return new Uint8Array(bits);
}

export async function deriveArchiveToken(identityKeyBytes: Uint8Array): Promise<string> {
  const base = await globalThis.crypto.subtle.importKey(
    'raw', identityKeyBytes.buffer as ArrayBuffer, 'HKDF', false, ['deriveBits'],
  );
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('meshwhisper:archive:v1'),
      info: new TextEncoder().encode('write-token'),
    },
    base,
    256,
  );
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

// ============================================================
// Symmetric encryption — AES-GCM, nonce(12) | ciphertext+tag
// ============================================================

export async function encryptArchive(
  payload: ArchivePayload,
  backupKey: Uint8Array,
): Promise<Uint8Array> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw', backupKey.buffer as ArrayBuffer, { name: 'AES-GCM' }, false, ['encrypt'],
  );
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(
    await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plaintext.buffer as ArrayBuffer),
  );
  const out = new Uint8Array(12 + ciphertext.byteLength);
  out.set(nonce);
  out.set(ciphertext, 12);
  return out;
}

export async function decryptArchive(
  blob: Uint8Array,
  backupKey: Uint8Array,
): Promise<ArchivePayload> {
  if (blob.byteLength < 29) throw new Error('Archive blob too small');
  const key = await globalThis.crypto.subtle.importKey(
    'raw', backupKey.buffer as ArrayBuffer, { name: 'AES-GCM' }, false, ['decrypt'],
  );
  const nonce = blob.slice(0, 12);
  const ciphertext = blob.slice(12);
  const plaintext = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce }, key, ciphertext.buffer as ArrayBuffer,
  );
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as ArchivePayload;
  if (parsed.version !== 1) throw new Error(`Unknown archive version: ${parsed.version}`);
  return parsed;
}

// ============================================================
// Storage serialisation
// ============================================================

export async function collectKv(storage: StorageBackend): Promise<Record<string, string>> {
  const kv: Record<string, string> = {};

  for (const prefix of ARCHIVE_PREFIXES) {
    const keys = await storage.keys(prefix);
    for (const k of keys) {
      const v = await storage.get(k);
      if (v !== null) kv[k] = v;
    }
  }

  for (const k of ARCHIVE_SINGLE_KEYS) {
    const v = await storage.get(k);
    if (v !== null) kv[k] = v;
  }

  return kv;
}

export async function restoreKv(
  kv: Record<string, string>,
  storage: StorageBackend,
): Promise<void> {
  for (const [k, v] of Object.entries(kv)) {
    await storage.set(k, v);
  }
}

/**
 * Merges remote KV data into local storage rather than overwriting it.
 * - JSON arrays (contacts, seen_ids, blocked): union of unique values
 * - messages/*: message objects merged and deduplicated by `id` field
 * - peers/*: remote wins (public keys are deterministic, not user-editable)
 *
 * Use this instead of restoreKv when local data may already exist — it
 * ensures no data is lost from either device.
 *
 * The optional `lock` callback lets the caller serialise per-key
 * read-modify-write against other concurrent operations (e.g. live
 * messages arriving via the SDK while the boot-time merge is running).
 * Without a lock, a live message arriving during merge can be silently
 * overwritten when the merge writes the pre-arrival snapshot back.
 */
export async function mergeKv(
  kv: Record<string, string>,
  storage: StorageBackend,
  lock?: <T>(key: string, fn: () => Promise<T>) => Promise<T>,
): Promise<void> {
  const merge = async (k: string, v: string): Promise<void> => {
    const existing = await storage.get(k);
    if (!existing) {
      await storage.set(k, v);
      return;
    }
    try {
      const local = JSON.parse(existing) as unknown;
      const remote = JSON.parse(v) as unknown;
      if (Array.isArray(local) && Array.isArray(remote)) {
        if (k.startsWith('messages/')) {
          type MsgLike = { id?: string; timestamp?: number };
          const byId = new Map<string, MsgLike>();
          for (const m of local as MsgLike[]) if (m.id) byId.set(m.id, m);
          for (const m of remote as MsgLike[]) if (m.id && !byId.has(m.id)) byId.set(m.id, m);
          const merged = [...byId.values()].sort(
            (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0),
          );
          await storage.set(k, JSON.stringify(merged));
        } else {
          await storage.set(k, JSON.stringify([...new Set([...(local as string[]), ...(remote as string[])])]));
        }
        return;
      }
    } catch { /* not JSON arrays — fall through */ }
    await storage.set(k, v);
  };

  for (const [k, v] of Object.entries(kv)) {
    if (lock && k.startsWith('messages/')) {
      await lock(k, () => merge(k, v));
    } else {
      await merge(k, v);
    }
  }
}

// ============================================================
// Relay transport — PUT / GET /archive/:peerId
// ============================================================

function archiveUrl(relayUrl: string, peerId: string): string {
  const base = relayUrl
    .replace(/^wss:\/\//, 'https://')
    .replace(/^ws:\/\//, 'http://')
    .replace(/\/$/, '');
  return `${base}/archive/${encodeURIComponent(peerId)}`;
}

export async function uploadArchive(
  relayUrl: string,
  peerId: string,
  authToken: string,
  blob: Uint8Array,
): Promise<void> {
  const resp = await fetch(archiveUrl(relayUrl, peerId), {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Authorization': `Bearer ${authToken}`,
      'Content-Length': String(blob.byteLength),
    },
    body: blob.buffer as ArrayBuffer,
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Archive upload failed (${resp.status}): ${body}`);
  }
}

export async function downloadArchive(
  relayUrl: string,
  peerId: string,
): Promise<Uint8Array | null> {
  const resp = await fetch(archiveUrl(relayUrl, peerId));
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Archive download failed: ${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer());
}
