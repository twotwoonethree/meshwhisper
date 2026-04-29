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
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Database from 'better-sqlite3';

// ============================================================
// Configuration
// ============================================================

const PORT = parseInt(process.env.PORT ?? '8080', 10);
const BLOB_TTL_HOURS = parseInt(process.env.BLOB_TTL_HOURS ?? '72', 10);
const MAX_BLOB_SIZE = parseInt(process.env.MAX_BLOB_SIZE ?? String(256 * 1024), 10); // 256 KB
const MAX_BLOBS_PER_HASH = parseInt(process.env.MAX_BLOBS_PER_HASH ?? '500', 10);
const MEDIA_TTL_HOURS = parseInt(process.env.MEDIA_TTL_HOURS ?? String(7 * 24), 10); // 7 days
const MAX_MEDIA_SIZE = parseInt(process.env.MAX_MEDIA_SIZE ?? String(50 * 1024 * 1024), 10); // 50 MB
const PRUNE_INTERVAL_MS = 5 * 60 * 1000; // prune expired blobs every 5 minutes
const PUSH_WEBHOOK_URL = process.env.PUSH_WEBHOOK_URL ?? null;
const DB_PATH = process.env.DB_PATH ?? './meshwhisper.db';
// Rate limiting (per IP, sliding window)
const RATE_WINDOW_MS = 60_000; // 1 minute window
const RATE_LIMIT_MEDIA = parseInt(process.env.RATE_LIMIT_MEDIA ?? '20', 10);   // uploads/min
const RATE_LIMIT_DIR   = parseInt(process.env.RATE_LIMIT_DIR   ?? '60', 10);   // registrations/min
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
  CREATE UNIQUE INDEX IF NOT EXISTS prekey_username_idx
    ON prekey_bundles (namespace, username)
    WHERE username IS NOT NULL;
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

/** Returns true if the request is within limits, false if it should be rejected. */
function checkRateLimit(ip: string, bucket: string, maxPerWindow: number): boolean {
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const entry = rateLimitState.get(key);

  if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
    rateLimitState.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= maxPerWindow) return false;
  entry.count++;
  return true;
}

function getClientIp(req: IncomingMessage): string {
  // Respect X-Forwarded-For when behind a proxy
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

function pruneRateLimitState(): void {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [key, entry] of rateLimitState.entries()) {
    if (entry.windowStart < cutoff) rateLimitState.delete(key);
  }
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

const registerPrekeyTx = db.transaction((
  namespace: string,
  publicKey: string,
  bundle: string,
  username: string | null,
): boolean => {
  const key = directoryKey(namespace, publicKey);
  // Remove any existing entry for this username so the new key can take over.
  // With password-derived keys, re-registration with the same credentials is
  // idempotent; a different key means the user rotated or recovered their identity.
  if (username) {
    const existing = stmts.getPrekeyByUsername.get(namespace, username) as
      | { key: string }
      | undefined;
    if (existing && existing.key !== key) {
      db.prepare('DELETE FROM prekey_bundles WHERE key = ?').run(existing.key);
    }
  }
  stmts.upsertPrekey.run(key, bundle, username, namespace);
  return true;
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
      }
      // On error: blob remains in store for reconnect delivery
    });
  } else {
    // Recipient offline (or same socket) — already stored above.
    // Wake the recipient via push if they have a registered token.
    const pushReg = getPushRegistration(destHash);
    if (pushReg) notifyPush(destHash, pushReg);
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
}

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost`);
  const method = req.method ?? 'GET';

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
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
    });
    return;
  }

  // Register prekey bundle
  // POST /directory  { namespace, publicKey, bundle, username? }
  if (url.pathname === '/directory' && method === 'POST') {
    if (!checkRateLimit(getClientIp(req), 'dir', RATE_LIMIT_DIR)) {
      sendJson(res, 429, { error: 'Too many requests' });
      return;
    }
    let body: { namespace?: string; publicKey?: string; bundle?: string; username?: string };
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

    registerPrekeyTx(namespace, publicKey, bundle, username);
    sendJson(res, 200, { ok: true });
    return;
  }

  // Lookup prekey bundle
  // GET /directory?namespace=&publicKey=
  // GET /directory?namespace=&username=alice
  if (url.pathname === '/directory' && method === 'GET') {
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
    if (!checkRateLimit(getClientIp(req), 'dir', RATE_LIMIT_DIR)) {
      sendJson(res, 429, { error: 'Too many requests' });
      return;
    }
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

  // Claim one one-time pre-key for a user (atomic — removes it from the pool)
  // GET /opks/claim?namespace=&publicKey=
  if (url.pathname === '/opks/claim' && method === 'GET') {
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
    if (!checkRateLimit(getClientIp(req), 'media', RATE_LIMIT_MEDIA)) {
      sendJson(res, 429, { error: 'Too many requests' });
      return;
    }
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

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws: WebSocket) => {
  handleWebSocketConnection(ws);
});

httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
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
