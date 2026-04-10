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
// Self-hosted: one Docker container, one VPS, everything included.
// Foundation-hosted: same binary, run by the Foundation as public infra.
// ============================================================

import * as http from 'node:http';
import * as https from 'node:https';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { IncomingMessage, ServerResponse } from 'node:http';

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
// Rate limiter — sliding window counter per IP
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

// Prune stale rate limit entries alongside blobs
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
// Blob store — in-memory, TTL-based
// ============================================================

interface StoredBlob {
  data: Uint8Array;
  receivedAt: number;
}

/** Map from destHash (hex) → list of queued blobs. */
const blobStore = new Map<string, StoredBlob[]>();

function storeBlob(destHash: string, data: Uint8Array): void {
  let queue = blobStore.get(destHash);
  if (!queue) {
    queue = [];
    blobStore.set(destHash, queue);
  }
  if (queue.length >= MAX_BLOBS_PER_HASH) {
    queue.shift(); // drop oldest when full
  }
  queue.push({ data, receivedAt: Date.now() });
}

function pullBlobs(destHash: string): Uint8Array[] {
  const queue = blobStore.get(destHash);
  if (!queue || queue.length === 0) return [];
  blobStore.delete(destHash);
  return queue.map((b) => b.data);
}

function pruneExpiredBlobs(): void {
  const cutoff = Date.now() - BLOB_TTL_HOURS * 60 * 60 * 1000;
  for (const [hash, queue] of blobStore.entries()) {
    const fresh = queue.filter((b) => b.receivedAt > cutoff);
    if (fresh.length === 0) {
      blobStore.delete(hash);
      // Also expire the push token for this dest hash — if no blobs have
      // arrived within the blob TTL window, the device has likely rotated
      // its dest hashes and the token is stale.
      pushTokens.delete(hash);
    } else {
      blobStore.set(hash, fresh);
    }
  }
}

// ============================================================
// Push token store — dest hash → push registration
// ============================================================

interface PushRegistration {
  token: string;
  platform: 'apns' | 'fcm' | 'webpush';
  topic?: string;
  /** Serialised Web Push subscription JSON (platform=webpush only). */
  pushSubscription?: string;
}

/** Map from destHash (hex) → push registration for offline wake signals. */
const pushTokens = new Map<string, PushRegistration>();

function registerPushTokens(destHashes: string[], reg: PushRegistration): void {
  for (const hash of destHashes) {
    pushTokens.set(hash, reg);
  }
}

function deregisterPushTokens(destHashes: Iterable<string>): void {
  for (const hash of destHashes) {
    pushTokens.delete(hash);
  }
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
// Prekey directory — in-memory, namespace-scoped
// ============================================================

/** Map from `${namespace}:${publicKeyHex}` → serialized bundle (base64). */
const prekeyDirectory = new Map<string, string>();

function directoryKey(namespace: string, publicKey: string): string {
  return `${namespace}:${publicKey}`;
}

function registerPrekey(namespace: string, publicKey: string, bundle: string): void {
  prekeyDirectory.set(directoryKey(namespace, publicKey), bundle);
}

function lookupPrekey(namespace: string, publicKey: string): string | null {
  return prekeyDirectory.get(directoryKey(namespace, publicKey)) ?? null;
}

// ============================================================
// Media store — in-memory, TTL-based encrypted blob storage
// ============================================================

interface MediaEntry {
  data: Buffer;
  storedAt: number;
}

/** Map from random media ID (hex) → encrypted media blob. */
const mediaStore = new Map<string, MediaEntry>();

function generateMediaId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('hex');
}

function storeMedia(data: Buffer): { id: string; expiresAt: number } {
  const id = generateMediaId();
  const storedAt = Date.now();
  mediaStore.set(id, { data, storedAt });
  return { id, expiresAt: storedAt + MEDIA_TTL_HOURS * 60 * 60 * 1000 };
}

function fetchMedia(id: string): Buffer | null {
  const entry = mediaStore.get(id);
  if (!entry) return null;
  const expiresAt = entry.storedAt + MEDIA_TTL_HOURS * 60 * 60 * 1000;
  if (Date.now() > expiresAt) {
    mediaStore.delete(id);
    return null;
  }
  return entry.data;
}

function pruneExpiredMedia(): void {
  const cutoff = Date.now() - MEDIA_TTL_HOURS * 60 * 60 * 1000;
  for (const [id, entry] of mediaStore.entries()) {
    if (entry.storedAt < cutoff) mediaStore.delete(id);
  }
}

// ============================================================
// Connected clients — map from destHash (hex) → WebSocket
// ============================================================

/** A client may register multiple dest hashes (current + previous epoch). */
const clientsByHash = new Map<string, WebSocket>();

/** Reverse map so we can clean up on disconnect. */
const hashesPerClient = new Map<WebSocket, Set<string>>();

function registerClient(ws: WebSocket, destHashes: string[]): void {
  // Remove any previous registrations for this socket
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
    // Push tokens are intentionally kept after disconnect — they are needed
    // to wake the device when it is offline. They expire naturally alongside
    // the blobs in the prune cycle.
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

  const recipient = clientsByHash.get(destHash);
  if (recipient && recipient !== sender && recipient.readyState === WebSocket.OPEN) {
    // Recipient is connected — forward directly
    recipient.send(data, { binary: true });
  } else {
    // Recipient offline (or same socket) — store for later delivery
    storeBlob(destHash, data);

    // Wake the recipient via push if they have a registered token
    const pushReg = pushTokens.get(destHash);
    if (pushReg) notifyPush(destHash, pushReg);
  }
}

// ============================================================
// WebSocket server
// ============================================================

function handleWebSocketConnection(ws: WebSocket): void {
  ws.on('message', (raw: RawData) => {
    if (raw instanceof ArrayBuffer) {
      handleRelayPacket(new Uint8Array(raw), ws);
      return;
    }

    if (Buffer.isBuffer(raw)) {
      handleRelayPacket(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength), ws);
      return;
    }

    // JSON control message
    try {
      const msg = JSON.parse(raw.toString()) as {
        type: string;
        destHashes?: string[];
        pushToken?: string;
        pushPlatform?: string;
        pushTopic?: string;
        pushSubscription?: string; // Web Push: JSON-serialised PushSubscription
      };

      if (msg.type === 'hello' && Array.isArray(msg.destHashes)) {
        const hashes = msg.destHashes.filter(
          (h): h is string => typeof h === 'string' && /^[0-9a-f]{16}$/.test(h),
        );
        registerClient(ws, hashes);

        // Register push token/subscription if provided
        if (msg.pushPlatform === 'webpush' && typeof msg.pushSubscription === 'string') {
          const reg: PushRegistration = {
            token: msg.pushSubscription, // subscription JSON stored in token field
            platform: 'webpush',
            pushSubscription: msg.pushSubscription,
          };
          registerPushTokens(hashes, reg);
        } else if (
          typeof msg.pushToken === 'string' && msg.pushToken &&
          (msg.pushPlatform === 'apns' || msg.pushPlatform === 'fcm')
        ) {
          const reg: PushRegistration = {
            token: msg.pushToken,
            platform: msg.pushPlatform,
            ...(typeof msg.pushTopic === 'string' && msg.pushTopic ? { topic: msg.pushTopic } : {}),
          };
          registerPushTokens(hashes, reg);
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

  ws.on('close', () => {
    deregisterClient(ws);
  });

  ws.on('error', () => {
    deregisterClient(ws);
  });
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
      storedBlobs: [...blobStore.values()].reduce((n, q) => n + q.length, 0),
      prekeyEntries: prekeyDirectory.size,
      pushRegistrations: pushTokens.size,
      mediaEntries: mediaStore.size,
    });
    return;
  }

  // Register prekey bundle
  // POST /directory  { namespace, publicKey, bundle }
  if (url.pathname === '/directory' && method === 'POST') {
    if (!checkRateLimit(getClientIp(req), 'dir', RATE_LIMIT_DIR)) {
      sendJson(res, 429, { error: 'Too many requests' });
      return;
    }
    let body: { namespace?: string; publicKey?: string; bundle?: string };
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

    registerPrekey(namespace, publicKey, bundle);
    sendJson(res, 200, { ok: true });
    return;
  }

  // Lookup prekey bundle
  // GET /directory?namespace=&publicKey=
  if (url.pathname === '/directory' && method === 'GET') {
    const namespace = url.searchParams.get('namespace');
    const publicKey = url.searchParams.get('publicKey');

    if (!namespace || !publicKey) {
      sendJson(res, 400, { error: 'Missing query params: namespace, publicKey' });
      return;
    }

    const bundle = lookupPrekey(namespace, publicKey);
    if (!bundle) {
      sendJson(res, 404, { error: 'Prekey bundle not found' });
      return;
    }

    sendJson(res, 200, { bundle });
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
pruneInterval.unref(); // don't keep process alive for pruning alone

httpServer.listen(PORT, () => {
  console.log(`MeshWhisper Node listening on port ${PORT}`);
  console.log(`  Relay:     ws://localhost:${PORT}`);
  console.log(`  Directory: http://localhost:${PORT}/directory`);
  console.log(`  Media:     http://localhost:${PORT}/media`);
  console.log(`  Health:    http://localhost:${PORT}/health`);
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
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
