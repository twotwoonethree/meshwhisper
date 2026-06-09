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
  /**
   * Deletion tombstones — peerId/groupId → ms epoch of the delete event.
   * Suppresses the peer's archived keys and contacts-array entry on merge
   * when the peer's most-recent event is a tombstone. Older devices that
   * don't know about this field still read version=1 archives without
   * crashing — they just lose tombstone semantics and may resurrect
   * deleted peers until they update.
   */
  tombstones?: Record<string, number>;
  /**
   * Revivals — peerId → ms epoch of an explicit re-add (acceptContact,
   * addContactByKey, or inbound x3dh_init from a previously-deleted peer).
   * Merge picks the most-recent event per peer; a revival newer than the
   * tombstone means the peer is active. Without this, a re-add whose
   * archive push didn't fire (e.g. via a Prudence handler that forgot
   * scheduleArchiveSync) would be undone on the next pull by the stale
   * remote tombstone.
   */
  revivals?: Record<string, number>;
  extra?: Record<string, unknown>;
}

// Storage key prefixes / names to include in the archive.
//   peers/    — X25519 routing keys
//   edkeys/   — Ed25519 identity keys, needed so a fresh device can fetch a
//               contact's prekey bundle from the relay directory and re-
//               handshake without the user re-adding contacts manually
//   messages/ — full per-conversation message history
const ARCHIVE_PREFIXES = ['peers/', 'edkeys/', 'messages/'];
// `contacts_v2` is the multi-device-aware contact list (an array of
// { accountKey, deviceKeys[] }). `contacts` is its single-device
// legacy form (a flat string[] of peerIds). Both are archived during
// the v1→v2 transition so a downgrade is non-destructive.
const ARCHIVE_SINGLE_KEYS = ['contacts', 'contacts_v2', 'seen_ids', 'blocked'];

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
 *
 * Tombstone filtering: any peer present in `remoteTombstones` is treated
 * as deleted and its archived keys (`messages/{P}`, `peers/{P}`,
 * `edkeys/{P}`) plus its `contacts`-array entry are dropped from the
 * remote side before merging. The merged tombstone set (local ∪ remote
 * with max-timestamp-wins) is written back to `tombstones` so the next
 * push carries deletions to other devices.
 */
export async function mergeKv(
  kv: Record<string, string>,
  storage: StorageBackend,
  lock?: <T>(key: string, fn: () => Promise<T>) => Promise<T>,
  remoteTombstones: Record<string, number> = {},
  remoteRevivals: Record<string, number> = {},
): Promise<void> {
  const localTombstones = await readTombstones(storage);
  const localRevivals = await readRevivals(storage);

  const mergedTombstones: Record<string, number> = { ...localTombstones };
  for (const [peer, t] of Object.entries(remoteTombstones)) {
    mergedTombstones[peer] = Math.max(mergedTombstones[peer] ?? 0, t);
  }
  const mergedRevivals: Record<string, number> = { ...localRevivals };
  for (const [peer, t] of Object.entries(remoteRevivals)) {
    mergedRevivals[peer] = Math.max(mergedRevivals[peer] ?? 0, t);
  }

  await writeTombstones(storage, mergedTombstones);
  await writeRevivals(storage, mergedRevivals);

  // A peer is currently tombstoned iff its most-recent event is a delete.
  // Equal timestamps fall back to "revived" (favour resurrection — better UX
  // than dropping the peer when timestamps coincide by accident).
  const peerIsTombstoned = (peerId: string): boolean => {
    const tomb = mergedTombstones[peerId];
    if (tomb === undefined) return false;
    const rev = mergedRevivals[peerId] ?? 0;
    return tomb > rev;
  };

  const isPeerTombstoned = (key: string): boolean => {
    for (const prefix of ARCHIVE_PREFIXES) {
      if (key.startsWith(prefix)) {
        const peerId = key.slice(prefix.length);
        return peerIsTombstoned(peerId);
      }
    }
    return false;
  };

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
        } else if (k === 'contacts') {
          const union = new Set([...(local as string[]), ...(remote as string[])]);
          for (const peerId of Object.keys(mergedTombstones)) {
            if (peerIsTombstoned(peerId)) union.delete(peerId);
          }
          await storage.set(k, JSON.stringify([...union]));
        } else if (k === 'contacts_v2') {
          // Union accounts across both sides; for each account, union
          // the device-key sets. Tombstoned accounts are dropped (a
          // delete of the account-level identity removes all devices
          // belonging to it). Per-device tombstones are not yet a
          // concept — phase A only tombstones at the account level.
          type Record = { accountKey: string; deviceKeys: string[] };
          const byAccount = new Map<string, Set<string>>();
          for (const r of [...(local as Record[]), ...(remote as Record[])]) {
            if (!r?.accountKey) continue;
            if (peerIsTombstoned(r.accountKey)) continue;
            if (!byAccount.has(r.accountKey)) byAccount.set(r.accountKey, new Set());
            for (const dk of r.deviceKeys ?? []) byAccount.get(r.accountKey)!.add(dk);
          }
          const merged: Record[] = Array.from(byAccount.entries()).map(
            ([accountKey, devices]) => ({ accountKey, deviceKeys: [...devices] }),
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
    if (isPeerTombstoned(k)) continue;
    if (lock && k.startsWith('messages/')) {
      await lock(k, () => merge(k, v));
    } else {
      await merge(k, v);
    }
  }

  // The remote may have included `contacts` only when the local side already
  // had it — meaning the merge() branch above handled the filter. Cover the
  // case where local had nothing and remote dropped its tombstoned peers
  // straight into storage: re-filter local contacts against tombstones.
  const localContactsRaw = await storage.get('contacts');
  if (localContactsRaw) {
    try {
      const arr = JSON.parse(localContactsRaw) as string[];
      const filtered = arr.filter((p) => !peerIsTombstoned(p));
      if (filtered.length !== arr.length) {
        await storage.set('contacts', JSON.stringify(filtered));
      }
    } catch { /* leave it */ }
  }
  const localContactsV2Raw = await storage.get('contacts_v2');
  if (localContactsV2Raw) {
    try {
      type Record = { accountKey: string; deviceKeys: string[] };
      const arr = JSON.parse(localContactsV2Raw) as Record[];
      const filtered = arr.filter((r) => r?.accountKey && !peerIsTombstoned(r.accountKey));
      if (filtered.length !== arr.length) {
        await storage.set('contacts_v2', JSON.stringify(filtered));
      }
    } catch { /* leave it */ }
  }
}

// ============================================================
// Tombstones + revivals — local storage helpers
// ============================================================

const TOMBSTONE_KEY = 'tombstones';
const REVIVAL_KEY = 'revivals';

export async function readTombstones(storage: StorageBackend): Promise<Record<string, number>> {
  const raw = await storage.get(TOMBSTONE_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, number>;
  } catch {
    return {};
  }
}

export async function writeTombstones(
  storage: StorageBackend,
  tombstones: Record<string, number>,
): Promise<void> {
  await storage.set(TOMBSTONE_KEY, JSON.stringify(tombstones));
}

export async function readRevivals(storage: StorageBackend): Promise<Record<string, number>> {
  const raw = await storage.get(REVIVAL_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, number>;
  } catch {
    return {};
  }
}

export async function writeRevivals(
  storage: StorageBackend,
  revivals: Record<string, number>,
): Promise<void> {
  await storage.set(REVIVAL_KEY, JSON.stringify(revivals));
}

// Per-(account, device) LWW replay-protection timestamps for
// `device_added` / `device_revoked` announcements. Without persistence,
// a fresh device boot has no historical protection: a captured
// revocation could be replayed after a re-add to silently undo it.
// Key shape: `${accountX25519}:${deviceX25519}` (matches the SDK's
// in-memory Map). Values are unix ms of the latest applied eventAt.
const DEVICE_ANNOUNCEMENT_SEEN_KEY = 'device_announcement_seen';

export async function readDeviceAnnouncementSeen(
  storage: StorageBackend,
): Promise<Record<string, number>> {
  const raw = await storage.get(DEVICE_ANNOUNCEMENT_SEEN_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, number>;
  } catch {
    return {};
  }
}

export async function writeDeviceAnnouncementSeen(
  storage: StorageBackend,
  seen: Record<string, number>,
): Promise<void> {
  await storage.set(DEVICE_ANNOUNCEMENT_SEEN_KEY, JSON.stringify(seen));
}

export async function addTombstone(storage: StorageBackend, peerId: string): Promise<void> {
  const cur = await readTombstones(storage);
  cur[peerId] = Date.now();
  await writeTombstones(storage, cur);
}

/**
 * Record a revival event for `peerId` (re-add after delete). On merge, the
 * peer is considered tombstoned only if its tombstone timestamp is greater
 * than its revival timestamp — so this beats any stale remote tombstone.
 */
export async function addRevival(storage: StorageBackend, peerId: string): Promise<void> {
  const cur = await readRevivals(storage);
  cur[peerId] = Date.now();
  await writeRevivals(storage, cur);
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
  keepalive = false,
): Promise<void> {
  const resp = await fetch(archiveUrl(relayUrl, peerId), {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Authorization': `Bearer ${authToken}`,
      'Content-Length': String(blob.byteLength),
    },
    body: blob.buffer as ArrayBuffer,
    // keepalive lets the request complete even if the tab is unloading.
    // Browsers cap keepalive payloads at ~64 KB, so the SDK only sets
    // it for short blobs; larger archives skip the unload-flush path
    // and rely on the next session's restore catching up.
    keepalive,
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
