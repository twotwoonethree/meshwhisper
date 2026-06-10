#!/usr/bin/env node
// ============================================================
// MeshWhisper Node
// Bundles four functions into one process on one port:
//   1. Relay        — WebSocket relay + store-and-forward
//   2. Directory    — Prekey bundle lookup (X3DH cold-start)
//   3. Push         — APNs/FCM wake signals via webhook
//   4. Media        — Encrypted blob storage (TTL-based, opaque)
//
// Usage:
//   PORT=443 node dist/index.js
//   PORT=8080 node dist/index.js   (dev)
//
// Push webhook:
//   PUSH_WEBHOOK_URL=https://your-push-server/notify
//
//   When a blob arrives for an offline recipient that has a registered push
//   token, the Node POSTs JSON to PUSH_WEBHOOK_URL:
//     { token, platform, topic?, destHash }
//
//   The webhook is responsible for sending the actual APNs/FCM notification.
//   The Node only sends a silent wake signal — no message content is included.
//
// Persistence:
//   Data is stored in a SQLite database (default: ./meshwhisper.db).
//   Set DB_PATH to change the location. For Docker, mount a volume at /data
//   and set DB_PATH=/data/meshwhisper.db so data survives container restarts.
//
// Self-hosted: one Docker container, one VPS, everything included.
// Foundation-hosted: same binary, run by the Foundation as public infra.
// ============================================================

import * as http from 'node:http';
import * as https from 'node:https';
import * as nodeCrypto from 'node:crypto';
import * as path from 'node:path';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Database from 'better-sqlite3';
import {
  FederationManager,
  FEDERATION_SUBPROTOCOL,
  loadOrCreateFederationKey,
  loadPeersConfig,
  loadBlocklist,
  type FederationMode,
} from './federation.js';

// ============================================================
// Configuration
// ============================================================

const PORT = parseInt(process.env.PORT ?? '8080', 10);
// Default 30 days. The previous 72h was tight enough that anyone offline
// for a long weekend lost messages. Storage cost is small in absolute terms
// because chaff dominates the relay's traffic, not real blobs. SDK clients
// listen on the same window to ensure blobs aren't stranded under
// destHashes the recipient stops asking for.
const BLOB_TTL_HOURS = parseInt(process.env.BLOB_TTL_HOURS ?? '720', 10);
const MAX_BLOB_SIZE = parseInt(process.env.MAX_BLOB_SIZE ?? String(256 * 1024), 10); // 256 KB
const MAX_BLOBS_PER_HASH = parseInt(process.env.MAX_BLOBS_PER_HASH ?? '500', 10);
const MEDIA_TTL_HOURS = parseInt(process.env.MEDIA_TTL_HOURS ?? String(7 * 24), 10); // 7 days
const MAX_ARCHIVE_SIZE = parseInt(process.env.MAX_ARCHIVE_SIZE ?? String(12 * 1024 * 1024), 10); // 12 MB
const MAX_MEDIA_SIZE = parseInt(process.env.MAX_MEDIA_SIZE ?? String(50 * 1024 * 1024), 10); // 50 MB
const PRUNE_INTERVAL_MS = 5 * 60 * 1000; // prune expired blobs every 5 minutes
const PUSH_WEBHOOK_URL = process.env.PUSH_WEBHOOK_URL ?? null;
const DB_PATH = process.env.DB_PATH ?? './meshwhisper.db';
// Rate limiting (per IP, sliding window).
//
// Buckets are coarse on purpose — one budget per bucket per IP per minute.
// Operators tune via env vars; the defaults are deliberately generous so
// well-behaved clients almost never hit them, while still catching obvious
// abuse (scripted enumeration, blob spam, etc).
//
// TRUST_PROXY controls whether X-Forwarded-For is honoured when computing
// the per-IP key. Default OFF — a direct-exposed node would otherwise let
// an attacker spoof the header to evade limits. Set TRUST_PROXY=1 (or any
// truthy value) when running behind nginx / Caddy / Cloudflare etc., which
// is the expected production deployment shape.
const RATE_WINDOW_MS    = 60_000; // 1 minute window
const RATE_LIMIT_MEDIA  = parseInt(process.env.RATE_LIMIT_MEDIA   ?? '20',  10);  // uploads/min
const RATE_LIMIT_DIR    = parseInt(process.env.RATE_LIMIT_DIR     ?? '60',  10);  // writes/min on directory/opks/policy
const RATE_LIMIT_READ   = parseInt(process.env.RATE_LIMIT_READ    ?? '300', 10);  // reads/min (GETs)
const RATE_LIMIT_ARCHIVE = parseInt(process.env.RATE_LIMIT_ARCHIVE ?? '30', 10);  // archive PUTs/min
const TRUST_PROXY       = /^(1|true|yes|on)$/i.test(process.env.TRUST_PROXY ?? '');
/** Canonical external base URL for constructing media download links.
 *  Set this when the Node is behind a reverse proxy (nginx, Caddy, Cloudflare).
 *  Example: BASE_URL=https://msg.myapp.com
 *  If unset, the URL is inferred from the Host header (works for local dev). */
const BASE_URL = (process.env.BASE_URL ?? '').replace(/\/$/, '');

// ============================================================
// SQLite database setup
// ============================================================

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Migrate existing prekey_bundles table if columns are missing (added for username support)
for (const col of ['username', 'namespace']) {
  try { db.exec(`ALTER TABLE prekey_bundles ADD COLUMN ${col} TEXT`); } catch { /* already exists */ }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS blobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    dest_hash   TEXT    NOT NULL,
    data        BLOB    NOT NULL,
    received_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS blobs_dest_hash ON blobs (dest_hash);

  CREATE TABLE IF NOT EXISTS push_registrations (
    dest_hash         TEXT PRIMARY KEY,
    token             TEXT NOT NULL,
    platform          TEXT NOT NULL,
    topic             TEXT,
    push_subscription TEXT
  );

  CREATE TABLE IF NOT EXISTS prekey_bundles (
    key       TEXT PRIMARY KEY,
    bundle    TEXT NOT NULL,
    username  TEXT,
    namespace TEXT
  );

  CREATE TABLE IF NOT EXISTS media (
    id        TEXT PRIMARY KEY,
    data      BLOB    NOT NULL,
    stored_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS opks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    identity_key TEXT    NOT NULL,
    opk_public   TEXT    NOT NULL,
    stored_at    INTEGER NOT NULL,
    UNIQUE (identity_key, opk_public)
  );
  CREATE INDEX IF NOT EXISTS opks_identity_key ON opks (identity_key);

  -- TOFU auth for DELETE /opks. Identity_pubkey is the user's Ed25519
  -- public key hex (cross-namespace). First DELETE establishes the hash;
  -- subsequent DELETEs must match.
  CREATE TABLE IF NOT EXISTS opk_auth (
    identity_pubkey TEXT PRIMARY KEY,
    auth_hash       TEXT NOT NULL,
    stored_at       INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS prekey_username_idx
    ON prekey_bundles (namespace, username)
    WHERE username IS NOT NULL;

  CREATE TABLE IF NOT EXISTS archives (
    peer_id    TEXT    PRIMARY KEY,
    auth_hash  TEXT    NOT NULL,
    data       BLOB    NOT NULL,
    stored_at  INTEGER NOT NULL,
    size       INTEGER NOT NULL
  );

  -- Per-namespace policy controlling username ownership semantics.
  -- 'signed-transfer' (default for unrecorded namespaces): username is sticky
  --   to whichever identity first claims it; a different key cannot take it
  --   over via a plain re-registration. Re-publishing with the SAME key is
  --   always allowed (covers bundle refresh and key-rotation flows).
  -- 'last-writer-wins': legacy/opt-in behavior — a fresh key claiming a taken
  --   username silently displaces the prior owner. Useful for password-derived
  --   identities where re-deriving the same key from credentials is the
  --   recovery story.
  CREATE TABLE IF NOT EXISTS namespace_policy (
    namespace       TEXT PRIMARY KEY,
    username_policy TEXT NOT NULL CHECK (username_policy IN ('signed-transfer', 'last-writer-wins')),
    set_at          INTEGER NOT NULL
  );
`);

// Prepared statements
const stmts = {
  // blobs
  insertBlob: db.prepare(
    'INSERT INTO blobs (dest_hash, data, received_at) VALUES (?, ?, ?)',
  ),
  countBlobsForHash: db.prepare<[string]>(
    'SELECT COUNT(*) AS cnt FROM blobs WHERE dest_hash = ?',
  ),
  oldestBlobIdForHash: db.prepare<[string]>(
    'SELECT id FROM blobs WHERE dest_hash = ? ORDER BY id ASC LIMIT 1',
  ),
  deleteBlob: db.prepare<[number]>(
    'DELETE FROM blobs WHERE id = ?',
  ),
  pullBlobs: db.prepare<[string]>(
    'SELECT id, data FROM blobs WHERE dest_hash = ? ORDER BY id ASC',
  ),
  deleteBlobsByHash: db.prepare<[string]>(
    'DELETE FROM blobs WHERE dest_hash = ?',
  ),
  pruneBlobs: db.prepare<[number]>(
    'DELETE FROM blobs WHERE received_at < ?',
  ),
  countBlobs: db.prepare(
    'SELECT COUNT(*) AS cnt FROM blobs',
  ),

  // push registrations
  upsertPush: db.prepare(
    `INSERT INTO push_registrations (dest_hash, token, platform, topic, push_subscription)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(dest_hash) DO UPDATE SET
       token = excluded.token,
       platform = excluded.platform,
       topic = excluded.topic,
       push_subscription = excluded.push_subscription`,
  ),
  getPush: db.prepare<[string]>(
    'SELECT token, platform, topic, push_subscription FROM push_registrations WHERE dest_hash = ?',
  ),
  deletePush: db.prepare<[string]>(
    'DELETE FROM push_registrations WHERE dest_hash = ?',
  ),
  countPush: db.prepare(
    'SELECT COUNT(*) AS cnt FROM push_registrations',
  ),

  // prekey bundles
  upsertPrekey: db.prepare(
    `INSERT INTO prekey_bundles (key, bundle, username, namespace) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       bundle    = excluded.bundle,
       username  = COALESCE(excluded.username, username),
       namespace = COALESCE(excluded.namespace, namespace)`,
  ),
  getPrekey: db.prepare<[string]>(
    'SELECT bundle, username FROM prekey_bundles WHERE key = ?',
  ),
  getPrekeyByUsername: db.prepare<[string, string]>(
    'SELECT key, bundle FROM prekey_bundles WHERE namespace = ? AND username = ?',
  ),
  countPrekeys: db.prepare(
    'SELECT COUNT(*) AS cnt FROM prekey_bundles',
  ),

  // opks
  insertOpk: db.prepare(
    'INSERT OR IGNORE INTO opks (identity_key, opk_public, stored_at) VALUES (?, ?, ?)',
  ),
  countOpksForKey: db.prepare<[string]>(
    'SELECT COUNT(*) AS cnt FROM opks WHERE identity_key = ?',
  ),
  countOpks: db.prepare(
    'SELECT COUNT(*) AS cnt FROM opks',
  ),
  // Purges every OPK row for one (namespace, publicKey) pair. Used by the
  // SDK's one-shot migration after the OPK-resurrection fix to clear out
  // zombie entries that the buggy bulk re-upload left behind. The auth_hash
  // check (separate TOFU table below) prevents anyone other than the
  // identity owner from purging the pool.
  deleteOpksForKey: db.prepare<[string]>(
    'DELETE FROM opks WHERE identity_key = ?',
  ),
  // opk_auth (TOFU per identity)
  getOpkAuthHash: db.prepare<[string]>(
    'SELECT auth_hash FROM opk_auth WHERE identity_pubkey = ?',
  ),
  insertOpkAuthHash: db.prepare(
    'INSERT OR IGNORE INTO opk_auth (identity_pubkey, auth_hash, stored_at) VALUES (?, ?, ?)',
  ),

  // media
  insertMedia: db.prepare(
    'INSERT INTO media (id, data, stored_at) VALUES (?, ?, ?)',
  ),
  getMedia: db.prepare<[string]>(
    'SELECT data, stored_at FROM media WHERE id = ?',
  ),
  deleteMedia: db.prepare<[string]>(
    'DELETE FROM media WHERE id = ?',
  ),
  pruneMedia: db.prepare<[number]>(
    'DELETE FROM media WHERE stored_at < ?',
  ),
  countMedia: db.prepare(
    'SELECT COUNT(*) AS cnt FROM media',
  ),

  // namespace policy
  getNamespacePolicy: db.prepare<[string]>(
    'SELECT username_policy FROM namespace_policy WHERE namespace = ?',
  ),
  insertNamespacePolicy: db.prepare(
    'INSERT OR IGNORE INTO namespace_policy (namespace, username_policy, set_at) VALUES (?, ?, ?)',
  ),

  // archives
  upsertArchive: db.prepare(
    `INSERT INTO archives (peer_id, auth_hash, data, stored_at, size)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(peer_id) DO UPDATE SET
       data      = excluded.data,
       stored_at = excluded.stored_at,
       size      = excluded.size
     WHERE auth_hash = excluded.auth_hash`,
  ),
  getArchiveAuthHash: db.prepare<[string]>(
    'SELECT auth_hash FROM archives WHERE peer_id = ?',
  ),
  getArchiveData: db.prepare<[string]>(
    'SELECT data FROM archives WHERE peer_id = ?',
  ),
  insertArchiveFirstTime: db.prepare(
    'INSERT OR IGNORE INTO archives (peer_id, auth_hash, data, stored_at, size) VALUES (?, ?, ?, ?, ?)',
  ),
  countArchives: db.prepare(
    'SELECT COUNT(*) AS cnt FROM archives',
  ),
};

// Atomic OPK claim: SELECT + DELETE in a single transaction so two concurrent
// initiators can never claim the same one-time pre-key.
const claimOpkTx = db.transaction((identityKey: string): string | null => {
  const row = db.prepare<[string]>(
    'SELECT id, opk_public FROM opks WHERE identity_key = ? LIMIT 1',
  ).get(identityKey) as { id: number; opk_public: string } | undefined;
  if (!row) return null;
  db.prepare<[number]>('DELETE FROM opks WHERE id = ?').run(row.id);
  return row.opk_public;
});

// ============================================================
// Rate limiter — sliding window counter per IP (in-memory, intentionally)
// ============================================================

interface RateWindow {
  count: number;
  windowStart: number;
}

const rateLimitState = new Map<string, RateWindow>();

interface RateLimitResult {
  ok: boolean;
  /** Seconds until the current window resets (only meaningful when ok=false). */
  retryAfterSeconds: number;
}

/**
 * Returns ok=true if the request is within limits. On rejection, retryAfterSeconds
 * is the number of whole seconds until the current window rolls over (clamped to ≥1).
 */
function checkRateLimit(ip: string, bucket: string, maxPerWindow: number): RateLimitResult {
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const entry = rateLimitState.get(key);

  if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
    rateLimitState.set(key, { count: 1, windowStart: now });
    return { ok: true, retryAfterSeconds: 0 };
  }
  if (entry.count >= maxPerWindow) {
    const remainingMs = RATE_WINDOW_MS - (now - entry.windowStart);
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)) };
  }
  entry.count++;
  return { ok: true, retryAfterSeconds: 0 };
}

/**
 * Apply a rate limit at the start of a request handler. On rejection writes
 * a 429 with a Retry-After header and returns true (caller should `return`).
 * On accept returns false (caller continues).
 */
function rateLimited(
  req: IncomingMessage,
  res: ServerResponse,
  bucket: string,
  maxPerWindow: number,
): boolean {
  const r = checkRateLimit(getClientIp(req), bucket, maxPerWindow);
  if (r.ok) return false;
  if (metrics.rateLimitRejections[bucket] !== undefined) {
    metrics.rateLimitRejections[bucket]++;
  }
  res.setHeader('Retry-After', String(r.retryAfterSeconds));
  sendJson(res, 429, { error: 'Too many requests', retryAfter: r.retryAfterSeconds });
  return true;
}

function getClientIp(req: IncomingMessage): string {
  // X-Forwarded-For is only honoured when the operator has set TRUST_PROXY,
  // otherwise an attacker on a direct-exposed node could spoof the header
  // to evade per-IP rate limiting.
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function pruneRateLimitState(): void {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [key, entry] of rateLimitState.entries()) {
    if (entry.windowStart < cutoff) rateLimitState.delete(key);
  }
}

// ============================================================
// Observability counters — surfaced via the /metrics endpoint in
// Prometheus text exposition format. Cheap, in-process, reset on
// every restart (which is what Prometheus expects from counters).
// ============================================================

const NODE_STARTED_AT_MS = Date.now();

const metrics = {
  httpRequestsTotal: 0,
  // Indexed by Prometheus-style status family label ("2xx", "3xx", etc.)
  // plus exact "429" because that's the one operators alert on most.
  httpStatus: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, '429': 0 } as Record<string, number>,
  rateLimitRejections: { dir: 0, media: 0, read: 0, archive: 0 } as Record<string, number>,
  websocketConnectionsTotal: 0,
};

function recordHttpStatus(status: number): void {
  metrics.httpRequestsTotal++;
  if (status === 429) metrics.httpStatus['429']++;
  const family = `${Math.floor(status / 100)}xx`;
  if (metrics.httpStatus[family] !== undefined) metrics.httpStatus[family]++;
}

// ============================================================
// Packet header constants (must match SDK wire format)
//
// Binary layout (all big-endian):
//   [0]       version       u8
//   [1]       flags         u8
//   [2..9]    destHash      8 bytes
//   [10..25]  senderEphId   16 bytes
//   [26]      ttl           u8
//   [27..30]  payloadLen    u32
//   [31..]    encrypted payload
// ============================================================

const HEADER_SIZE = 31;
const DEST_HASH_OFFSET = 2;
const DEST_HASH_LENGTH = 8;

function readDestHash(buf: Uint8Array): string | null {
  if (buf.byteLength < HEADER_SIZE) return null;
  const bytes = buf.subarray(DEST_HASH_OFFSET, DEST_HASH_OFFSET + DEST_HASH_LENGTH);
  return Buffer.from(bytes).toString('hex');
}

// ============================================================
// Blob store — SQLite-backed, TTL-based
// ============================================================

function storeBlob(destHash: string, data: Uint8Array): number {
  // Enforce per-hash cap: drop oldest if full
  const row = stmts.countBlobsForHash.get(destHash) as { cnt: number };
  if (row.cnt >= MAX_BLOBS_PER_HASH) {
    const oldest = stmts.oldestBlobIdForHash.get(destHash) as { id: number } | undefined;
    if (oldest) stmts.deleteBlob.run(oldest.id);
  }
  const result = stmts.insertBlob.run(destHash, Buffer.from(data), Date.now());
  return Number(result.lastInsertRowid);
}

function pullBlobs(destHash: string): Uint8Array[] {
  const rows = stmts.pullBlobs.all(destHash) as Array<{ id: number; data: Buffer }>;
  if (rows.length === 0) return [];
  stmts.deleteBlobsByHash.run(destHash);
  return rows.map((r) => new Uint8Array(r.data));
}

function pruneExpiredBlobs(): void {
  const cutoff = Date.now() - BLOB_TTL_HOURS * 60 * 60 * 1000;
  stmts.pruneBlobs.run(cutoff);
}

// ============================================================
// Push token store — SQLite-backed
// ============================================================

interface PushRegistration {
  token: string;
  platform: 'apns' | 'fcm' | 'webpush';
  topic?: string;
  pushSubscription?: string;
}

function registerPushTokens(destHashes: string[], reg: PushRegistration): void {
  for (const hash of destHashes) {
    stmts.upsertPush.run(
      hash,
      reg.token,
      reg.platform,
      reg.topic ?? null,
      reg.pushSubscription ?? null,
    );
  }
}

function getPushRegistration(destHash: string): PushRegistration | null {
  const row = stmts.getPush.get(destHash) as {
    token: string;
    platform: string;
    topic: string | null;
    push_subscription: string | null;
  } | undefined;
  if (!row) return null;
  return {
    token: row.token,
    platform: row.platform as PushRegistration['platform'],
    ...(row.topic ? { topic: row.topic } : {}),
    ...(row.push_subscription ? { pushSubscription: row.push_subscription } : {}),
  };
}

/**
 * Fire-and-forget POST to the configured push webhook.
 * Payload: { token, platform, topic?, destHash }
 * No retry — best-effort. If there is no webhook configured, this is a no-op.
 */
function notifyPush(destHash: string, reg: PushRegistration): void {
  if (!PUSH_WEBHOOK_URL) return;

  const body = JSON.stringify({
    token: reg.token,
    platform: reg.platform,
    ...(reg.topic ? { topic: reg.topic } : {}),
    ...(reg.pushSubscription ? { pushSubscription: JSON.parse(reg.pushSubscription) } : {}),
    destHash,
  });

  try {
    const url = new URL(PUSH_WEBHOOK_URL);
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    });
    req.on('error', () => { /* best-effort */ });
    req.write(body);
    req.end();
  } catch {
    // Misconfigured URL or network error — swallow
  }
}

// ============================================================
// Prekey directory — SQLite-backed, namespace-scoped
// ============================================================

function directoryKey(namespace: string, publicKey: string): string {
  return `${namespace}:${publicKey}`;
}

const USERNAME_RE = /^[a-z0-9_-]{3,30}$/;

function validateUsername(raw: string): string | null {
  const u = raw.toLowerCase().trim();
  return USERNAME_RE.test(u) ? u : null;
}

type UsernamePolicy = 'signed-transfer' | 'last-writer-wins';

function getNamespaceUsernamePolicy(namespace: string): UsernamePolicy {
  const row = stmts.getNamespacePolicy.get(namespace) as
    | { username_policy: UsernamePolicy }
    | undefined;
  return row?.username_policy ?? 'signed-transfer';
}

// Wire format for username-transfer authorizations. The signed bytes MUST
// match what the SDK produces; see `src/sdk/username-transfer.ts`. Bumping
// the version tag breaks old tokens — fine, transfer tokens are short-lived.
function canonicalTransferMessage(
  namespace: string,
  username: string,
  toPublicKeyHex: string,
  expiresAt: number,
): Buffer {
  return Buffer.from(
    [
      'meshwhisper.username-transfer.v1',
      namespace,
      username,
      toPublicKeyHex,
      String(expiresAt),
    ].join('\n'),
    'utf8',
  );
}

// DER SubjectPublicKeyInfo prefix for a raw Ed25519 public key.
// Lets `nodeCrypto.createPublicKey` ingest a 32-byte key without
// pulling in an external Ed25519 library.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

interface TransferAuthInput {
  fromPublicKey: string; // hex; informational — current owner is the source of truth
  expiresAt: number;     // unix ms
  signature: string;     // base64, 64 raw bytes
}

function verifyTransferAuth(
  namespace: string,
  username: string,
  newOwnerPublicKeyHex: string,
  currentOwnerPublicKeyHex: string,
  auth: TransferAuthInput,
): boolean {
  if (typeof auth.expiresAt !== 'number' || !Number.isFinite(auth.expiresAt)) return false;
  if (Date.now() > auth.expiresAt) return false;

  // fromPublicKey in the request is informational; the relay binds
  // verification to the actual current owner. We still cross-check
  // so an obviously-mismatched token is rejected early.
  if (
    typeof auth.fromPublicKey === 'string' &&
    auth.fromPublicKey.toLowerCase() !== currentOwnerPublicKeyHex.toLowerCase()
  ) {
    return false;
  }

  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(auth.signature, 'base64');
  } catch { return false; }
  if (signatureBytes.length !== 64) return false;

  let publicKeyBytes: Buffer;
  try {
    publicKeyBytes = Buffer.from(currentOwnerPublicKeyHex, 'hex');
  } catch { return false; }
  if (publicKeyBytes.length !== 32) return false;

  let publicKey;
  try {
    publicKey = nodeCrypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]),
      format: 'der',
      type: 'spki',
    });
  } catch { return false; }

  const message = canonicalTransferMessage(
    namespace,
    username,
    newOwnerPublicKeyHex,
    auth.expiresAt,
  );

  try {
    return nodeCrypto.verify(null, message, publicKey, signatureBytes);
  } catch { return false; }
}

type RegisterResult = 'ok' | 'username_taken' | 'invalid_transfer_auth';

const registerPrekeyTx = db.transaction((
  namespace: string,
  publicKey: string,
  bundle: string,
  username: string | null,
  transferAuth: TransferAuthInput | null,
): RegisterResult => {
  const key = directoryKey(namespace, publicKey);
  if (username) {
    const existing = stmts.getPrekeyByUsername.get(namespace, username) as
      | { key: string }
      | undefined;
    if (existing && existing.key !== key) {
      const policy = getNamespaceUsernamePolicy(namespace);
      if (policy === 'last-writer-wins') {
        // Legacy/opt-in: displace the prior owner without proof.
        db.prepare('DELETE FROM prekey_bundles WHERE key = ?').run(existing.key);
      } else if (transferAuth) {
        // Signed-transfer policy with handover token: verify the prior owner
        // authorized this takeover. existing.key is `${namespace}:${publicKey}`;
        // splitting on the last colon recovers the publicKey hex (which itself
        // never contains a colon).
        const lastColon = existing.key.lastIndexOf(':');
        const currentOwnerHex = lastColon >= 0 ? existing.key.slice(lastColon + 1) : '';
        const ok = verifyTransferAuth(
          namespace,
          username,
          publicKey,
          currentOwnerHex,
          transferAuth,
        );
        if (!ok) return 'invalid_transfer_auth';
        db.prepare('DELETE FROM prekey_bundles WHERE key = ?').run(existing.key);
      } else {
        // Signed-transfer policy, no token — reject takeover.
        return 'username_taken';
      }
    }
  }
  stmts.upsertPrekey.run(key, bundle, username, namespace);
  return 'ok';
});

function lookupPrekeyByPublicKey(
  namespace: string,
  publicKey: string,
): { bundle: string; username?: string } | null {
  const row = stmts.getPrekey.get(directoryKey(namespace, publicKey)) as
    | { bundle: string; username: string | null }
    | undefined;
  if (!row) return null;
  return { bundle: row.bundle, ...(row.username ? { username: row.username } : {}) };
}

function lookupPrekeyByUsername(
  namespace: string,
  username: string,
): { bundle: string; publicKey: string } | null {
  const row = stmts.getPrekeyByUsername.get(namespace, username) as
    | { key: string; bundle: string }
    | undefined;
  if (!row) return null;
  // key format is "namespace:publicKey"
  const publicKey = row.key.slice(namespace.length + 1);
  return { bundle: row.bundle, publicKey };
}

// ============================================================
// Media store — SQLite-backed, TTL-based encrypted blob storage
// ============================================================

function generateMediaId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('hex');
}

function storeMedia(data: Buffer): { id: string; expiresAt: number } {
  const id = generateMediaId();
  const storedAt = Date.now();
  stmts.insertMedia.run(id, data, storedAt);
  return { id, expiresAt: storedAt + MEDIA_TTL_HOURS * 60 * 60 * 1000 };
}

function fetchMedia(id: string): Buffer | null {
  const row = stmts.getMedia.get(id) as { data: Buffer; stored_at: number } | undefined;
  if (!row) return null;
  const expiresAt = row.stored_at + MEDIA_TTL_HOURS * 60 * 60 * 1000;
  if (Date.now() > expiresAt) {
    stmts.deleteMedia.run(id);
    return null;
  }
  return row.data;
}

function pruneExpiredMedia(): void {
  const cutoff = Date.now() - MEDIA_TTL_HOURS * 60 * 60 * 1000;
  stmts.pruneMedia.run(cutoff);
}

// ============================================================
// Connected clients — map from destHash (hex) → WebSocket
// (connection state is ephemeral by nature, always in-memory)
// ============================================================

/** A client may register multiple dest hashes (current + previous epoch). */
const clientsByHash = new Map<string, WebSocket>();

/** Reverse map so we can clean up on disconnect. */
const hashesPerClient = new Map<WebSocket, Set<string>>();

// ============================================================
// Anonymous activity stream — for the public live-traffic page
//
// Events are content-blind tags only: in/fwd/queue/wake/drain. No IPs,
// no destination hashes, no timestamps fine enough to fingerprint a
// single send. The relay can't distinguish chaff from real traffic, so
// even a perfect observer can't say "Alice just sent something."
// ============================================================

type ActivityType = 'in' | 'fwd' | 'queue' | 'wake' | 'drain';

interface ActivityBucket {
  in: number;
  fwd: number;
  queue: number;
  wake: number;
  drain: number;
}

const activitySubscribers = new Set<ServerResponse>();
let activityBucket: ActivityBucket = { in: 0, fwd: 0, queue: 0, wake: 0, drain: 0 };

function bumpActivity(type: ActivityType): void {
  if (activitySubscribers.size === 0) return; // no-op when nobody is watching
  activityBucket[type] += 1;
}

function flushActivity(): void {
  if (activitySubscribers.size === 0) return;
  const total =
    activityBucket.in + activityBucket.fwd + activityBucket.queue +
    activityBucket.wake + activityBucket.drain;
  if (total === 0) return;

  const payload = `data: ${JSON.stringify(activityBucket)}\n\n`;
  for (const res of activitySubscribers) {
    try { res.write(payload); } catch { /* dead connection — cleaned on close */ }
  }
  activityBucket = { in: 0, fwd: 0, queue: 0, wake: 0, drain: 0 };
}

// Flush at ~4 Hz: fast enough to feel live, slow enough to obscure
// individual sends and keep CPU usage trivial.
setInterval(flushActivity, 250);

function registerClient(ws: WebSocket, destHashes: string[]): void {
  const existing = hashesPerClient.get(ws);
  if (existing) {
    for (const h of existing) clientsByHash.delete(h);
  }

  const hashes = new Set<string>();
  for (const h of destHashes) {
    clientsByHash.set(h, ws);
    hashes.add(h);
  }
  hashesPerClient.set(ws, hashes);
}

function deregisterClient(ws: WebSocket): void {
  const hashes = hashesPerClient.get(ws);
  if (hashes) {
    for (const h of hashes) clientsByHash.delete(h);
    // Push registrations are intentionally kept after disconnect — they are
    // needed to wake the device when it is offline.
    hashesPerClient.delete(ws);
  }
}

function deliverQueuedBlobs(ws: WebSocket, destHashes: string[]): void {
  for (const hash of destHashes) {
    const blobs = pullBlobs(hash);
    for (const blob of blobs) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(blob, { binary: true });
        bumpActivity('drain');
      }
    }
  }
}

// ============================================================
// Relay — incoming binary packet handler
// ============================================================

function handleRelayPacket(data: Uint8Array, sender: WebSocket): void {
  if (data.byteLength > MAX_BLOB_SIZE) return; // drop oversized packets

  const destHash = readDestHash(data);
  if (!destHash) return; // malformed header

  bumpActivity('in');

  // Always store the blob first so it survives regardless of delivery outcome.
  // This prevents a race where the recipient's WebSocket is still in the
  // registry (close event not yet fired) but the peer has already called
  // terminate(): we'd forward to the stale socket and the store-and-forward
  // delivery on reconnect would never happen.
  const blobId = storeBlob(destHash, data);

  const recipient = clientsByHash.get(destHash);
  if (recipient && recipient !== sender && recipient.readyState === WebSocket.OPEN) {
    // Recipient appears connected — deliver immediately AND delete from store.
    // If the send fails (connection dropped between readyState check and write),
    // the blob stays in the store and will be delivered on the next reconnect.
    recipient.send(data, { binary: true }, (err) => {
      if (!err) {
        // Delivery succeeded — purge from store so it isn't delivered twice
        stmts.deleteBlob.run(blobId);
        bumpActivity('fwd');
      }
      // On error: blob remains in store for reconnect delivery
    });
  } else {
    // Recipient offline (or same socket) — already stored above.
    bumpActivity('queue');
    // Wake the recipient via push if they have a registered token.
    const pushReg = getPushRegistration(destHash);
    if (pushReg) {
      notifyPush(destHash, pushReg);
      bumpActivity('wake');
    } else if (federation) {
      // No connected client and no push registration — this destHash may
      // be homed on a federated peer. Forward best-effort. The local
      // store (above) is kept as a harmless safety net; it expires per
      // BLOB_TTL like everything else.
      federation.forwardFromLocal(data);
    }
  }
}

// ============================================================
// WebSocket server
// ============================================================

function handleWebSocketConnection(ws: WebSocket): void {
  ws.on('message', (raw: RawData, isBinary: boolean) => {
    // Binary frames are relay packets
    if (isBinary) {
      if (raw instanceof ArrayBuffer) {
        handleRelayPacket(new Uint8Array(raw), ws);
      } else if (Buffer.isBuffer(raw)) {
        handleRelayPacket(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength), ws);
      }
      return;
    }

    // Text frames are JSON control messages
    try {
      const msg = JSON.parse(raw.toString()) as {
        type: string;
        destHashes?: string[];
        pushToken?: string;
        pushPlatform?: string;
        pushTopic?: string;
        pushSubscription?: string;
      };

      if (msg.type === 'hello' && Array.isArray(msg.destHashes)) {
        const hashes = msg.destHashes.filter(
          (h): h is string => typeof h === 'string' && /^[0-9a-f]{16}$/.test(h),
        );
        registerClient(ws, hashes);

        if (msg.pushPlatform === 'webpush' && typeof msg.pushSubscription === 'string') {
          registerPushTokens(hashes, {
            token: msg.pushSubscription,
            platform: 'webpush',
            pushSubscription: msg.pushSubscription,
          });
        } else if (
          typeof msg.pushToken === 'string' && msg.pushToken &&
          (msg.pushPlatform === 'apns' || msg.pushPlatform === 'fcm')
        ) {
          registerPushTokens(hashes, {
            token: msg.pushToken,
            platform: msg.pushPlatform,
            ...(typeof msg.pushTopic === 'string' && msg.pushTopic ? { topic: msg.pushTopic } : {}),
          });
        }

        deliverQueuedBlobs(ws, hashes);
        return;
      }

      if (msg.type === 'pull') {
        const hashes = hashesPerClient.get(ws);
        if (hashes) deliverQueuedBlobs(ws, [...hashes]);
        return;
      }
    } catch {
      // Not JSON or malformed — ignore
    }
  });

  ws.on('close', () => deregisterClient(ws));
  ws.on('error', () => deregisterClient(ws));
}

// ============================================================
// HTTP handler — health check and prekey directory
// ============================================================

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
  recordHttpStatus(status);
}

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost`);
  const method = req.method ?? 'GET';

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  // Anonymous live activity stream (Server-Sent Events) — public, no auth.
  // Emits a JSON object every ~250ms when the relay handled any traffic in
  // that window. Counts only — no destination hashes, no IPs, no per-event
  // metadata. Safe to expose to anyone watching the public site.
  if (url.pathname === '/events' && method === 'GET') {
    // Per-IP cap on SSE subscriptions. Each subscriber holds a long-lived
    // connection; cap prevents a single peer from exhausting socket budget.
    if (rateLimited(req, res, 'read', RATE_LIMIT_READ)) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering for SSE
      'Access-Control-Allow-Origin': '*',
    });
    res.write(': connected\n\n');
    activitySubscribers.add(res);
    const heartbeat = setInterval(() => {
      try { res.write(': hb\n\n'); } catch { /* ignored */ }
    }, 15_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      activitySubscribers.delete(res);
    });
    return;
  }

  // Health check
  if (url.pathname === '/health' && method === 'GET') {
    sendJson(res, 200, {
      status: 'ok',
      clients: clientsByHash.size,
      storedBlobs: (stmts.countBlobs.get() as { cnt: number }).cnt,
      prekeyEntries: (stmts.countPrekeys.get() as { cnt: number }).cnt,
      pushRegistrations: (stmts.countPush.get() as { cnt: number }).cnt,
      mediaEntries: (stmts.countMedia.get() as { cnt: number }).cnt,
      opkEntries: (stmts.countOpks.get() as { cnt: number }).cnt,
      archiveEntries: (stmts.countArchives.get() as { cnt: number }).cnt,
      federationPeersConfigured: federation?.stats.peersConfigured ?? 0,
      federationPeersConnected: federation?.connectedPeerCount() ?? 0,
    });
    return;
  }

  // Prometheus-format metrics. Includes gauges (current state) and
  // counters (cumulative since boot). Not rate-limited so a scraper
  // can poll on its own schedule. Operators wanting to keep this
  // private should gate it at the reverse proxy.
  if (url.pathname === '/metrics' && method === 'GET') {
    const lines: string[] = [];
    const emit = (name: string, help: string, type: 'counter' | 'gauge', value: number, labels?: Record<string, string>): void => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
      const labelStr = labels
        ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}`
        : '';
      lines.push(`${name}${labelStr} ${value}`);
    };
    const emitLabeled = (name: string, help: string, type: 'counter' | 'gauge', labelName: string, values: Record<string, number>): void => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
      for (const [label, value] of Object.entries(values)) {
        lines.push(`${name}{${labelName}="${label}"} ${value}`);
      }
    };

    // Uptime
    emit('meshwhisper_uptime_seconds', 'Seconds since this node started', 'gauge',
      Math.floor((Date.now() - NODE_STARTED_AT_MS) / 1000));

    // Live counts (gauges)
    emit('meshwhisper_clients_connected', 'Currently connected WebSocket clients', 'gauge', clientsByHash.size);
    emit('meshwhisper_stored_blobs', 'Encrypted blobs currently queued for offline delivery', 'gauge',
      (stmts.countBlobs.get() as { cnt: number }).cnt);
    emit('meshwhisper_prekey_entries', 'Registered prekey-bundle entries in the directory', 'gauge',
      (stmts.countPrekeys.get() as { cnt: number }).cnt);
    emit('meshwhisper_push_registrations', 'Active push-notification registrations', 'gauge',
      (stmts.countPush.get() as { cnt: number }).cnt);
    emit('meshwhisper_media_entries', 'Encrypted media blobs currently stored', 'gauge',
      (stmts.countMedia.get() as { cnt: number }).cnt);
    emit('meshwhisper_opk_entries', 'Unused one-time prekeys in the pool', 'gauge',
      (stmts.countOpks.get() as { cnt: number }).cnt);
    emit('meshwhisper_archive_entries', 'Stored per-identity encrypted archives', 'gauge',
      (stmts.countArchives.get() as { cnt: number }).cnt);

    // Counters
    emit('meshwhisper_http_requests_total', 'Total HTTP requests served since startup', 'counter',
      metrics.httpRequestsTotal);
    emitLabeled('meshwhisper_http_responses_total', 'HTTP responses by status family (plus 429 broken out)',
      'counter', 'status', metrics.httpStatus);
    emitLabeled('meshwhisper_rate_limit_rejections_total', 'Rate-limit (429) rejections by bucket',
      'counter', 'bucket', metrics.rateLimitRejections);
    emit('meshwhisper_websocket_connections_total', 'Total WebSocket connections accepted since startup',
      'counter', metrics.websocketConnectionsTotal);

    // Federation (zeroes when federation is dormant)
    emit('meshwhisper_federation_peers_configured', 'Federation peers in the allow-list', 'gauge',
      federation?.stats.peersConfigured ?? 0);
    emit('meshwhisper_federation_peers_connected', 'Federation peers with an established handshake', 'gauge',
      federation?.connectedPeerCount() ?? 0);
    emit('meshwhisper_federation_forwards_sent_total', 'PacketForward frames sent to peers', 'counter',
      federation?.stats.forwardsSentTotal ?? 0);
    emit('meshwhisper_federation_forwards_received_total', 'PacketForward frames received from peers', 'counter',
      federation?.stats.forwardsReceivedTotal ?? 0);
    emit('meshwhisper_federation_delivered_locally_total', 'Federation packets delivered to a connected local client', 'counter',
      federation?.stats.deliveredLocallyTotal ?? 0);
    emit('meshwhisper_federation_stored_locally_total', 'Federation packets stored for a local offline device', 'counter',
      federation?.stats.storedLocallyTotal ?? 0);
    emit('meshwhisper_federation_forwarded_onward_total', 'Federation packets forwarded to further peers', 'counter',
      federation?.stats.forwardedOnwardTotal ?? 0);
    emit('meshwhisper_federation_drops_duplicate_total', 'Federation packets dropped by the packet-id cache', 'counter',
      federation?.stats.dropsDuplicateTotal ?? 0);
    emit('meshwhisper_federation_drops_ttl_total', 'Federation packets dropped by hop-count exhaustion', 'counter',
      federation?.stats.dropsTtlTotal ?? 0);
    emit('meshwhisper_federation_handshake_failures_total', 'Failed federation handshakes', 'counter',
      federation?.stats.handshakeFailuresTotal ?? 0);
    emit('meshwhisper_federation_drops_rate_limited_total', 'Federation frames dropped by per-peer rate limiting', 'counter',
      federation?.stats.dropsRateLimitedTotal ?? 0);
    emit('meshwhisper_federation_handshake_rejections_blocked_total', 'Handshakes rejected by the blocklist', 'counter',
      federation?.stats.handshakeRejectionsBlockedTotal ?? 0);

    const body = lines.join('\n') + '\n';
    res.writeHead(200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
    recordHttpStatus(200);
    return;
  }

  // Register prekey bundle
  // POST /directory  { namespace, publicKey, bundle, username? }
  if (url.pathname === '/directory' && method === 'POST') {
    if (rateLimited(req, res, 'dir', RATE_LIMIT_DIR)) return;
    let body: {
      namespace?: string;
      publicKey?: string;
      bundle?: string;
      username?: string;
      transferAuth?: unknown;
    };
    try {
      body = JSON.parse(await parseBody(req));
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    const { namespace, publicKey, bundle } = body;
    if (
      typeof namespace !== 'string' || !namespace ||
      typeof publicKey !== 'string' || !publicKey ||
      typeof bundle !== 'string' || !bundle
    ) {
      sendJson(res, 400, { error: 'Missing required fields: namespace, publicKey, bundle' });
      return;
    }

    let username: string | null = null;
    if (typeof body.username === 'string' && body.username) {
      username = validateUsername(body.username);
      if (!username) {
        sendJson(res, 400, { error: 'Invalid username: 3–30 chars, a–z 0–9 _ -' });
        return;
      }
    }

    let transferAuth: TransferAuthInput | null = null;
    if (body.transferAuth && typeof body.transferAuth === 'object') {
      const ta = body.transferAuth as Record<string, unknown>;
      if (
        typeof ta.fromPublicKey === 'string' &&
        typeof ta.expiresAt === 'number' &&
        typeof ta.signature === 'string'
      ) {
        transferAuth = {
          fromPublicKey: ta.fromPublicKey,
          expiresAt: ta.expiresAt,
          signature: ta.signature,
        };
      } else {
        sendJson(res, 400, { error: 'Invalid transferAuth shape' });
        return;
      }
    }

    const result = registerPrekeyTx(namespace, publicKey, bundle, username, transferAuth);
    if (result === 'username_taken') {
      sendJson(res, 409, {
        error: 'Username already claimed by a different identity in this namespace',
      });
      return;
    }
    if (result === 'invalid_transfer_auth') {
      sendJson(res, 403, {
        error: 'transferAuth invalid: signature, expiry, or sender mismatch',
      });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  // Set or read namespace policy
  // POST /namespace-policy { namespace, usernamePolicy }
  //   First writer wins. Once set, the policy is sticky. Re-POSTing the
  //   same value returns 200; a different value returns 409.
  // GET  /namespace-policy?namespace=
  //   Returns the effective policy. Falls back to defaults when no row.
  if (url.pathname === '/namespace-policy' && method === 'POST') {
    if (rateLimited(req, res, 'dir', RATE_LIMIT_DIR)) return;
    let body: { namespace?: string; usernamePolicy?: string };
    try {
      body = JSON.parse(await parseBody(req));
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    const { namespace, usernamePolicy } = body;
    if (typeof namespace !== 'string' || !namespace) {
      sendJson(res, 400, { error: 'Missing required field: namespace' });
      return;
    }
    if (usernamePolicy !== 'signed-transfer' && usernamePolicy !== 'last-writer-wins') {
      sendJson(res, 400, {
        error: "usernamePolicy must be 'signed-transfer' or 'last-writer-wins'",
      });
      return;
    }
    stmts.insertNamespacePolicy.run(namespace, usernamePolicy, Date.now());
    const current = getNamespaceUsernamePolicy(namespace);
    if (current !== usernamePolicy) {
      sendJson(res, 409, {
        error: 'Namespace policy already set to a different value',
        currentPolicy: current,
      });
      return;
    }
    sendJson(res, 200, { ok: true, usernamePolicy: current });
    return;
  }

  if (url.pathname === '/namespace-policy' && method === 'GET') {
    if (rateLimited(req, res, 'read', RATE_LIMIT_READ)) return;
    const namespace = url.searchParams.get('namespace');
    if (!namespace) {
      sendJson(res, 400, { error: 'Missing query param: namespace' });
      return;
    }
    sendJson(res, 200, {
      namespace,
      usernamePolicy: getNamespaceUsernamePolicy(namespace),
    });
    return;
  }

  // Lookup prekey bundle
  // GET /directory?namespace=&publicKey=
  // GET /directory?namespace=&username=alice
  if (url.pathname === '/directory' && method === 'GET') {
    // Username/publicKey lookup is the natural endpoint for an enumeration
    // attempt — bucket separately from writes so a busy lookup workload
    // doesn't starve registrations and vice versa.
    if (rateLimited(req, res, 'read', RATE_LIMIT_READ)) return;
    const namespace = url.searchParams.get('namespace');
    const usernameParam = url.searchParams.get('username');
    const publicKeyParam = url.searchParams.get('publicKey');

    if (!namespace) {
      sendJson(res, 400, { error: 'Missing query param: namespace' });
      return;
    }

    if (usernameParam) {
      const username = validateUsername(usernameParam);
      if (!username) {
        sendJson(res, 400, { error: 'Invalid username' });
        return;
      }
      const result = lookupPrekeyByUsername(namespace, username);
      if (!result) {
        sendJson(res, 404, { error: 'User not found' });
        return;
      }
      sendJson(res, 200, { bundle: result.bundle, publicKey: result.publicKey, username });
      return;
    }

    if (!publicKeyParam) {
      sendJson(res, 400, { error: 'Missing query param: publicKey or username' });
      return;
    }

    const result = lookupPrekeyByPublicKey(namespace, publicKeyParam);
    if (!result) {
      sendJson(res, 404, { error: 'Prekey bundle not found' });
      return;
    }
    sendJson(res, 200, { bundle: result.bundle, ...(result.username ? { username: result.username } : {}) });
    return;
  }

  // Upload one-time pre-keys for a user
  // POST /opks  { namespace, publicKey, opks: string[] }  (base64 public keys)
  if (url.pathname === '/opks' && method === 'POST') {
    if (rateLimited(req, res, 'dir', RATE_LIMIT_DIR)) return;
    let body: { namespace?: string; publicKey?: string; opks?: unknown };
    try {
      body = JSON.parse(await parseBody(req));
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    const { namespace, publicKey, opks } = body;
    if (
      typeof namespace !== 'string' || !namespace ||
      typeof publicKey !== 'string' || !publicKey ||
      !Array.isArray(opks) || opks.length === 0
    ) {
      sendJson(res, 400, { error: 'Missing required fields: namespace, publicKey, opks[]' });
      return;
    }

    const MAX_OPKS_PER_UPLOAD = 20;
    const MAX_OPKS_PER_IDENTITY = 100;
    const batch = (opks as unknown[]).slice(0, MAX_OPKS_PER_UPLOAD).filter(
      (o): o is string => typeof o === 'string' && o.length > 0,
    );

    const identityKey = directoryKey(namespace, publicKey);
    const existing = (stmts.countOpksForKey.get(identityKey) as { cnt: number }).cnt;
    const canStore = Math.max(0, MAX_OPKS_PER_IDENTITY - existing);
    const toStore = batch.slice(0, canStore);

    const now = Date.now();
    for (const opk of toStore) {
      stmts.insertOpk.run(identityKey, opk, now);
    }
    sendJson(res, 200, { ok: true, stored: toStore.length });
    return;
  }

  // Purge all OPKs for a (namespace, publicKey) pair.
  // DELETE /opks  { namespace, publicKey }
  // Authorization: Bearer <token>
  //
  // TOFU auth: first DELETE for a given publicKey establishes the auth hash;
  // subsequent DELETEs must present a token whose SHA-256 matches the stored
  // hash. Identity_pubkey is cross-namespace so the same person purging
  // their pool in different namespaces uses the same token.
  //
  // Used by the SDK's one-shot OPK-pool migration to clear zombie entries
  // left by the pre-fix bulk re-upload bug. Apps don't need to call this
  // directly — the SDK runs it on first init after the fix.
  if (url.pathname === '/opks' && method === 'DELETE') {
    if (rateLimited(req, res, 'dir', RATE_LIMIT_DIR)) return;
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) {
      sendJson(res, 401, { error: 'Missing bearer token' });
      return;
    }
    const token = auth.slice('Bearer '.length).trim();

    let body: { namespace?: string; publicKey?: string };
    try {
      body = JSON.parse(await parseBody(req));
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    const { namespace, publicKey } = body;
    if (typeof namespace !== 'string' || !namespace || typeof publicKey !== 'string' || !publicKey) {
      sendJson(res, 400, { error: 'Missing required fields: namespace, publicKey' });
      return;
    }

    const incomingHash = nodeCrypto.createHash('sha256').update(token).digest('hex');

    // TOFU: insert-or-ignore establishes the hash on first call. Subsequent
    // calls succeed only if the hash matches what's already stored.
    stmts.insertOpkAuthHash.run(publicKey, incomingHash, Date.now());
    const existing = stmts.getOpkAuthHash.get(publicKey) as { auth_hash: string } | undefined;
    if (!existing || existing.auth_hash !== incomingHash) {
      sendJson(res, 403, { error: 'Invalid OPK pool token' });
      return;
    }

    const result = stmts.deleteOpksForKey.run(directoryKey(namespace, publicKey));
    sendJson(res, 200, { ok: true, deleted: result.changes });
    return;
  }

  // Claim one one-time pre-key for a user (atomic — removes it from the pool)
  // GET /opks/claim?namespace=&publicKey=
  if (url.pathname === '/opks/claim' && method === 'GET') {
    // OPK claim is a write-like operation (each call atomically consumes a
    // one-time prekey from the pool). Bucket with the other write endpoints
    // so the directory budget gates abuse — an attacker draining a victim's
    // OPK pool to force fallback to the signed-prekey-only handshake is the
    // primary risk this addresses.
    if (rateLimited(req, res, 'dir', RATE_LIMIT_DIR)) return;
    const namespace = url.searchParams.get('namespace');
    const publicKey = url.searchParams.get('publicKey');

    if (!namespace || !publicKey) {
      sendJson(res, 400, { error: 'Missing query params: namespace, publicKey' });
      return;
    }

    const opk = claimOpkTx(directoryKey(namespace, publicKey));
    if (!opk) {
      sendJson(res, 404, { error: 'No one-time pre-keys available' });
      return;
    }

    sendJson(res, 200, { opk });
    return;
  }

  // Upload encrypted media blob
  // POST /media  (binary body, Content-Length required)
  // Returns: { id, url, expiresAt }
  if (url.pathname === '/media' && method === 'POST') {
    if (rateLimited(req, res, 'media', RATE_LIMIT_MEDIA)) return;
    const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
    if (contentLength > MAX_MEDIA_SIZE) {
      sendJson(res, 413, { error: `Payload too large (max ${MAX_MEDIA_SIZE} bytes)` });
      return;
    }

    const chunks: Buffer[] = [];
    let received = 0;
    let aborted = false;

    await new Promise<void>((resolve, reject) => {
      req.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_MEDIA_SIZE) {
          aborted = true;
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', resolve);
      req.on('error', reject);
    });

    if (aborted) {
      sendJson(res, 413, { error: `Payload too large (max ${MAX_MEDIA_SIZE} bytes)` });
      return;
    }

    const data = Buffer.concat(chunks);
    const { id, expiresAt } = storeMedia(data);
    const base = BASE_URL || `http://${req.headers['host'] ?? `localhost:${PORT}`}`;
    const mediaUrl = `${base}/media/${id}`;
    sendJson(res, 200, { id, url: mediaUrl, expiresAt });
    return;
  }

  // Download encrypted media blob
  // GET /media/:id
  const mediaMatch = url.pathname.match(/^\/media\/([0-9a-f]{32})$/);
  if (mediaMatch && method === 'GET') {
    if (rateLimited(req, res, 'read', RATE_LIMIT_READ)) return;
    const data = fetchMedia(mediaMatch[1]);
    if (!data) {
      sendJson(res, 404, { error: 'Media not found or expired' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': data.length,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'private, max-age=604800', // 7 days
    });
    res.end(data);
    return;
  }

  // Upload encrypted archive
  // PUT /archive/:peerId  Authorization: Bearer <token>
  const archivePutMatch = url.pathname.match(/^\/archive\/([0-9a-f]{64})$/);
  if (archivePutMatch && method === 'PUT') {
    if (rateLimited(req, res, 'archive', RATE_LIMIT_ARCHIVE)) return;
    const peerId = archivePutMatch[1];
    const authHeader = req.headers['authorization'] ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!token) {
      sendJson(res, 401, { error: 'Missing Authorization header' });
      return;
    }

    const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
    if (contentLength > MAX_ARCHIVE_SIZE) {
      sendJson(res, 413, { error: `Archive too large (max ${MAX_ARCHIVE_SIZE} bytes)` });
      return;
    }

    const chunks: Buffer[] = [];
    let received = 0;
    let aborted = false;
    await new Promise<void>((resolve, reject) => {
      req.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_ARCHIVE_SIZE) { aborted = true; req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', resolve);
      req.on('error', reject);
    });
    if (aborted) {
      sendJson(res, 413, { error: `Archive too large (max ${MAX_ARCHIVE_SIZE} bytes)` });
      return;
    }

    const data = Buffer.concat(chunks);
    const incomingHash = nodeCrypto.createHash('sha256').update(token).digest('hex');

    // First write: INSERT OR IGNORE sets the auth_hash. The upsert only
    // succeeds when auth_hash matches, preventing overwrites by other parties.
    stmts.insertArchiveFirstTime.run(peerId, incomingHash, data, Date.now(), data.length);
    const existing = stmts.getArchiveAuthHash.get(peerId) as { auth_hash: string } | undefined;
    if (!existing || existing.auth_hash !== incomingHash) {
      sendJson(res, 403, { error: 'Invalid archive token' });
      return;
    }
    stmts.upsertArchive.run(peerId, incomingHash, data, Date.now(), data.length);
    sendJson(res, 200, { ok: true, size: data.length });
    return;
  }

  // Download encrypted archive
  // GET /archive/:peerId  (no auth — content is client-encrypted)
  const archiveGetMatch = url.pathname.match(/^\/archive\/([0-9a-f]{64})$/);
  if (archiveGetMatch && method === 'GET') {
    if (rateLimited(req, res, 'read', RATE_LIMIT_READ)) return;
    const row = stmts.getArchiveData.get(archiveGetMatch[1]) as { data: Buffer } | undefined;
    if (!row) {
      sendJson(res, 404, { error: 'Archive not found' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': row.data.length,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(row.data);
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

// ============================================================
// Server startup
// ============================================================

const httpServer = http.createServer((req, res) => {
  handleHttp(req, res).catch((err) => {
    console.error('[ERROR] HTTP handler threw:', err);
    res.writeHead(500).end();
  });
});

// ============================================================
// Federation (docs/federation.md v1)
//
// Dormant unless a peers file with at least one entry exists. The
// classifyLocal callback answers "can this packet be handled here?":
//   - a connected client holds the destHash       → deliver  ('delivered')
//   - a push registration exists for the destHash → store+wake ('stored';
//     the device is homed here, currently offline)
//   - neither                                     → 'unknown' (forward onward)
// ============================================================

const FEDERATION_KEY_FILE = process.env.FEDERATION_KEY_FILE
  ?? path.join(path.dirname(DB_PATH), 'federation-key.json');
const FEDERATION_PEERS_FILE = process.env.FEDERATION_PEERS_FILE
  ?? path.join(path.dirname(DB_PATH), 'federation-peers.json');
const FEDERATION_BLOCKLIST_FILE = process.env.FEDERATION_BLOCKLIST_FILE
  ?? path.join(path.dirname(DB_PATH), 'federation-blocklist.json');

// FEDERATION_MODE: 'off' | 'allowlist' | 'open'.
//   off       — dormant regardless of peers file
//   allowlist — only pre-approved pubkeys; v1 behavior
//   open      — accept any peer completing the handshake (recommended once
//               you're comfortable; per-peer rate limiting is the abuse
//               boundary). Peers file becomes the outbound bootstrap list.
// Unset (back-compat): allowlist when the peers file has entries, else off.
const federationPeersConfig = loadPeersConfig(FEDERATION_PEERS_FILE);
const FEDERATION_MODE_RAW = (process.env.FEDERATION_MODE ?? '').toLowerCase();
const federationMode: FederationMode | 'off' =
  FEDERATION_MODE_RAW === 'open' ? 'open'
  : FEDERATION_MODE_RAW === 'allowlist' ? 'allowlist'
  : FEDERATION_MODE_RAW === 'off' ? 'off'
  : (federationPeersConfig.length > 0 ? 'allowlist' : 'off');
const FEDERATION_MAX_PEERS = parseInt(process.env.FEDERATION_MAX_PEERS ?? '64', 10);
const FEDERATION_RATE_LIMIT = parseInt(process.env.FEDERATION_RATE_LIMIT ?? '6000', 10); // frames/min/peer

const federation: FederationManager | null = federationMode !== 'off'
  ? new FederationManager({
      key: loadOrCreateFederationKey(FEDERATION_KEY_FILE),
      peers: federationPeersConfig,
      mode: federationMode,
      blockedPubkeys: loadBlocklist(FEDERATION_BLOCKLIST_FILE),
      maxPeers: FEDERATION_MAX_PEERS,
      rateLimitPerMin: FEDERATION_RATE_LIMIT,
      classifyLocal: (packet: Uint8Array) => {
        const destHash = readDestHash(packet);
        if (!destHash) return 'delivered'; // malformed — swallow, don't propagate
        const recipient = clientsByHash.get(destHash);
        if (recipient && recipient.readyState === WebSocket.OPEN) {
          // Same store-then-deliver race protection as the client path.
          const blobId = storeBlob(destHash, packet);
          recipient.send(packet, { binary: true }, (err) => {
            if (!err) stmts.deleteBlob.run(blobId);
          });
          bumpActivity('fwd');
          return 'delivered';
        }
        const pushReg = getPushRegistration(destHash);
        if (pushReg) {
          storeBlob(destHash, packet);
          notifyPush(destHash, pushReg);
          bumpActivity('wake');
          return 'stored';
        }
        return 'unknown';
      },
    })
  : null;

if (federation) {
  federation.start();
  console.log(`[federation] mode=${federationMode}, ${federationPeersConfig.length} configured peer(s), max ${FEDERATION_MAX_PEERS}`);
}

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws: WebSocket) => {
  metrics.websocketConnectionsTotal++;
  handleWebSocketConnection(ws);
});

httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
  // Federation peers negotiate the meshwhisper-federation.v1 subprotocol;
  // everything else is a regular client-relay connection.
  const offered = (req.headers['sec-websocket-protocol'] ?? '')
    .split(',').map((s) => s.trim());
  if (federation && offered.includes(FEDERATION_SUBPROTOCOL)) {
    federation.handleUpgrade(req, socket, head);
    return;
  }
  wss.handleUpgrade(req, socket as any, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// Prune expired blobs and media on a regular interval
const pruneInterval = setInterval(() => {
  pruneExpiredBlobs();
  pruneExpiredMedia();
  pruneRateLimitState();
}, PRUNE_INTERVAL_MS);
pruneInterval.unref();

// Default to '::' (IPv6 wildcard) which also accepts IPv4 on Linux (bindv6only=0).
// Set LISTEN_HOST=0.0.0.0 to restrict to IPv4 only.
const LISTEN_HOST = process.env.LISTEN_HOST ?? '::';
httpServer.listen(PORT, LISTEN_HOST, () => {
  console.log(`MeshWhisper Node listening on port ${PORT}`);
  console.log(`  Relay:     ws://localhost:${PORT}`);
  console.log(`  Directory: http://localhost:${PORT}/directory`);
  console.log(`  OPKs:      http://localhost:${PORT}/opks`);
  console.log(`  Media:     http://localhost:${PORT}/media`);
  console.log(`  Archive:   http://localhost:${PORT}/archive/:peerId`);
  console.log(`  Health:    http://localhost:${PORT}/health`);
  console.log(`  Database:  ${DB_PATH}`);
  console.log(`  Blob TTL:  ${BLOB_TTL_HOURS}h`);
  console.log(`  Media TTL: ${MEDIA_TTL_HOURS}h (max ${MAX_MEDIA_SIZE / (1024 * 1024)}MB per file)`);
  console.log(`  Base URL:  ${BASE_URL || '(inferred from Host header — set BASE_URL in production)'}`);
  console.log(`  Push:      ${PUSH_WEBHOOK_URL ?? 'disabled (set PUSH_WEBHOOK_URL to enable)'}`);
});

// ============================================================
// Graceful shutdown
// ============================================================

function shutdown(): void {
  console.log('\nShutting down...');
  clearInterval(pruneInterval);
  wss.clients.forEach((ws) => ws.close(1001, 'Node shutting down'));
  wss.close();
  httpServer.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => {
    db.close();
    process.exit(1);
  }, 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
