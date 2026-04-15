#!/usr/bin/env npx tsx
// ============================================================
// MeshWhisper Demo Server — SDK Edition
// ============================================================
//
// A WebSocket bridge that lets browser-based UIs interact with
// a real MeshWhisper SDK instance.  Uses the full SDK for
// identity, X3DH key exchange, Double Ratchet encryption, and
// relay-based store-and-forward.
//
// Usage:
//   npx tsx demo/server.ts [ui-port] [peer-name] [relay-url]
//
// Examples:
//   Terminal 1: npx tsx demo/server.ts 3001 Alice ws://127.0.0.1:8080
//   Terminal 2: npx tsx demo/server.ts 3002 Bob  ws://127.0.0.1:8080
//
// The relay (node/) must be running before the demo servers start.
// Start it with:  cd node && npm start
//
// Browser WebSocket protocol (unchanged from previous version):
//   Browser → Server:
//     { type: "send",           to: string, text: string }
//     { type: "get_peers" }
//     { type: "connect",        address: string }  (HTTP URL of another demo server)
//     { type: "get_status" }
//     { type: "get_contact_info" }
//     { type: "accept_contact", data: string }     (base64 QR from another server)
//     { type: "get_debug" }
//   Server → Browser:
//     { type: "message",      from, fromName, text, timestamp }
//     { type: "peers",        list: [{ id, name, status }] }
//     { type: "status",       peerId, peerName, transport, connections }
//     { type: "sent",         to, text, timestamp }
//     { type: "system",       text }
//     { type: "contact_info", data: string }       (base64 QR)
//     { type: "debug",        routing, relay }
// ============================================================

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { MeshWhisper } from '../src/sdk/index.js';
import { NodeStorage } from '../src/persistence/node-storage.js';

// ============================================================
// CLI Arguments
// ============================================================

const PORT = parseInt(process.argv[2] || '3001', 10);
const PEER_NAME = process.argv[3] || `Peer-${PORT}`;
const RELAY_URL = process.argv[4] || 'ws://127.0.0.1:8080';
const NAMESPACE = 'com.meshwhisper.demo';

// Persistent storage in a temp dir keyed by port so re-runs reuse identity
const STORAGE_DIR = path.join(os.tmpdir(), `meshwhisper-demo-${PORT}`);
fs.mkdirSync(STORAGE_DIR, { recursive: true });

// ============================================================
// Logging Helpers
// ============================================================

const C = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
};

function log(category: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`${C.dim}[${ts}]${C.reset} ${C.cyan}[${category}]${C.reset} ${msg}`);
}
function logEvent(msg: string): void { log('EVENT', `${C.green}${msg}${C.reset}`); }
function logWarn(msg: string): void  { log('WARN',  `${C.yellow}${msg}${C.reset}`); }
function logError(msg: string): void { log('ERROR', `${C.red}${msg}${C.reset}`); }

// ============================================================
// SDK instance (initialized below, referenced globally)
// ============================================================

let sdk: MeshWhisper | null = null;

// peerId → peerName mapping (populated when contacts are accepted)
const peerNames = new Map<string, string>();

// ============================================================
// Browser client tracking
// ============================================================

const browserClients = new Set<WebSocket>();

function sendToBrowser(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastToBrowsers(msg: unknown): void {
  const payload = JSON.stringify(msg);
  for (const client of browserClients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

// ============================================================
// MIME type map for static file serving
// ============================================================

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

const PUBLIC_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/i, '$1'),
  'public',
);

function serveStaticFile(req: IncomingMessage, res: http.ServerResponse): void {
  let urlPath = req.url || '/';
  const qIdx = urlPath.indexOf('?');
  if (qIdx !== -1) urlPath = urlPath.slice(0, qIdx);
  if (urlPath === '/') urlPath = '/index.html';

  const decoded = decodeURIComponent(urlPath);
  const filePath = path.resolve(PUBLIC_DIR, '.' + decoded);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('403 Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      res.end(err.code === 'ENOENT' ? '404 Not Found' : '500 Error');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' });
    res.end(data);
  });
}

// ============================================================
// HTTP Server
// ============================================================

const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // JSON API: GET /api/contact → returns this peer's QR contact string
  if (req.url === '/api/contact' && req.method === 'GET') {
    try {
      const qr = MeshWhisper.generateContactQR();
      const data = JSON.stringify({
        peerId: sdk?.getLocalPeerId() ?? '',
        peerName: PEER_NAME,
        qr,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    } catch {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'SDK not ready' }));
    }
    return;
  }

  serveStaticFile(req, res);
});

// ============================================================
// Browser WebSocket Server
// ============================================================

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const addr = req.socket.remoteAddress ?? 'unknown';
  log('WS', `Browser client connected from ${addr}`);
  browserClients.add(ws);

  // Send initial status
  sendToBrowser(ws, {
    type: 'status',
    peerId: sdk?.getLocalPeerId() ?? '(initializing)',
    peerName: PEER_NAME,
    transport: 'meshwhisper-sdk',
    connections: peerNames.size,
  });

  ws.on('message', (data) => {
    try {
      handleBrowserMessage(ws, JSON.parse(data.toString()));
    } catch (err) {
      logError(`Bad browser message: ${err}`);
      sendToBrowser(ws, { type: 'system', text: 'Invalid JSON' });
    }
  });

  ws.on('close', () => {
    log('WS', `Browser client disconnected from ${addr}`);
    browserClients.delete(ws);
  });

  ws.on('error', (err) => {
    logError(`Browser WS error: ${err.message}`);
    browserClients.delete(ws);
  });
});

// ============================================================
// Browser Message Handler
// ============================================================

function handleBrowserMessage(ws: WebSocket, msg: Record<string, unknown>): void {
  switch (msg.type) {
    case 'send':            handleSend(ws, msg); break;
    case 'get_peers':       handleGetPeers(ws); break;
    case 'connect':         handleConnect(ws, msg); break;
    case 'get_status':      handleGetStatus(ws); break;
    case 'get_contact_info': handleGetContactInfo(ws); break;
    case 'accept_contact':  handleAcceptContact(ws, msg); break;
    case 'get_debug':       handleGetDebug(ws); break;
    default:
      logWarn(`Unknown browser message type: ${String(msg.type)}`);
      sendToBrowser(ws, { type: 'system', text: `Unknown message type: ${String(msg.type)}` });
  }
}

// ---- send ----

function handleSend(ws: WebSocket, msg: Record<string, unknown>): void {
  if (!sdk) { sendToBrowser(ws, { type: 'system', text: 'SDK not ready' }); return; }
  const to = String(msg.to ?? '');
  const text = String(msg.text ?? '');
  if (!to || !text) {
    sendToBrowser(ws, { type: 'system', text: 'Missing "to" or "text"' }); return;
  }

  // Accept peer ID or peer name
  const peerId = resolvePeer(to);
  if (!peerId) {
    sendToBrowser(ws, { type: 'system', text: `Peer not found: ${to}` }); return;
  }

  sdk.sendMessage(peerId, new TextEncoder().encode(text))
    .then(() => {
      logEvent(`Sent to ${peerNames.get(peerId) ?? peerId.slice(0, 8)}: "${text.slice(0, 60)}"`);
      sendToBrowser(ws, { type: 'sent', to: peerId, text, timestamp: Date.now() });
    })
    .catch((err: Error) => {
      logError(`Send failed: ${err.message}`);
      sendToBrowser(ws, { type: 'system', text: `Send failed: ${err.message}` });
    });
}

// ---- get_peers ----

function handleGetPeers(ws: WebSocket): void {
  const list = [...peerNames.entries()].map(([id, name]) => ({
    id, name, status: 'connected',
  }));
  sendToBrowser(ws, { type: 'peers', list });
}

// ---- connect ----

// Accepts:
//   "http://localhost:3002"        → fetches /api/contact
//   "localhost:3002" / "3002"      → normalised to http://localhost:PORT
//   A raw base64 QR string         → accepted directly
function handleConnect(ws: WebSocket, msg: Record<string, unknown>): void {
  if (!sdk) { sendToBrowser(ws, { type: 'system', text: 'SDK not ready' }); return; }
  const address = String(msg.address ?? '').trim();
  if (!address) {
    sendToBrowser(ws, { type: 'system', text: 'Missing "address"' }); return;
  }

  // If it looks like a base64 QR blob, accept it directly
  if (/^[A-Za-z0-9+/=]{32,}$/.test(address) && !address.includes('://')) {
    acceptQR(ws, address, null);
    return;
  }

  // Build an HTTP URL to fetch from
  let httpUrl = address;
  if (/^\d+$/.test(address)) {
    httpUrl = `http://127.0.0.1:${address}`;
  } else if (!address.startsWith('http://') && !address.startsWith('https://')) {
    // Strip ws:// prefix if someone pastes a WebSocket URL
    httpUrl = `http://${address.replace(/^ws(s?):\/\//, '').replace(/\/peer\/?$/, '')}`;
  }

  // Strip trailing slash and /peer suffix
  httpUrl = httpUrl.replace(/\/peer\/?$/, '').replace(/\/$/, '');

  log('CONTACT', `Fetching contact info from ${httpUrl}/api/contact`);
  fetch(`${httpUrl}/api/contact`)
    .then((r) => r.json() as Promise<{ peerId: string; peerName: string; qr: string }>)
    .then(({ qr, peerName }) => {
      acceptQR(ws, qr, peerName);
    })
    .catch((err: Error) => {
      logError(`Failed to fetch contact info from ${httpUrl}: ${err.message}`);
      sendToBrowser(ws, { type: 'system', text: `Failed to connect to ${httpUrl}: ${err.message}` });
    });
}

function acceptQR(ws: WebSocket, qr: string, peerName: string | null): void {
  if (!sdk) return;
  MeshWhisper.acceptContact(qr)
    .then(() => {
      // After acceptContact, the peer will appear once the session is established.
      // For immediate UI feedback we report success and refresh the peer list.
      const displayName = peerName ?? '(peer)';
      sendToBrowser(ws, { type: 'system', text: `Contact ${displayName} accepted. Establishing session...` });
      broadcastToBrowsers({ type: 'peers', list: [...peerNames.entries()].map(([id, name]) => ({ id, name, status: 'connected' })) });
    })
    .catch((err: Error) => {
      logError(`acceptContact failed: ${err.message}`);
      sendToBrowser(ws, { type: 'system', text: `Accept contact failed: ${err.message}` });
    });
}

// ---- get_status ----

function handleGetStatus(ws: WebSocket): void {
  sendToBrowser(ws, {
    type: 'status',
    peerId: sdk?.getLocalPeerId() ?? '(initializing)',
    peerName: PEER_NAME,
    transport: 'meshwhisper-sdk',
    connections: peerNames.size,
  });
}

// ---- get_contact_info ----

function handleGetContactInfo(ws: WebSocket): void {
  if (!sdk) { sendToBrowser(ws, { type: 'system', text: 'SDK not ready' }); return; }
  const qr = MeshWhisper.generateContactQR();
  sendToBrowser(ws, { type: 'contact_info', data: qr });
}

// ---- accept_contact ----

function handleAcceptContact(ws: WebSocket, msg: Record<string, unknown>): void {
  if (!sdk) { sendToBrowser(ws, { type: 'system', text: 'SDK not ready' }); return; }
  const data = String(msg.data ?? '');
  if (!data) { sendToBrowser(ws, { type: 'system', text: 'Missing "data"' }); return; }

  // Support both raw QR strings and the legacy { peerId, address } base64 JSON
  // (the old demo server encoded contact info as base64 JSON)
  let qr = data;
  try {
    const decoded = JSON.parse(Buffer.from(data, 'base64').toString('utf-8'));
    if (decoded.qr) qr = decoded.qr;
  } catch { /* treat data as raw QR */ }

  acceptQR(ws, qr, null);
}

// ---- get_debug ----

function handleGetDebug(ws: WebSocket): void {
  sendToBrowser(ws, {
    type: 'debug',
    routing: {
      localPeerId: sdk?.getLocalPeerId() ?? '(not ready)',
      localPeerName: PEER_NAME,
      port: PORT,
      relay: RELAY_URL,
      knownPeers: peerNames.size,
      mode: 'meshwhisper-sdk',
    },
    relay: {
      url: RELAY_URL,
      mode: 'relay-backed-store-and-forward',
    },
  });
}

// ============================================================
// Helpers
// ============================================================

/** Resolve a "to" field that may be a peer ID, peer name, or ID prefix. */
function resolvePeer(query: string): string | null {
  if (peerNames.has(query)) return query;
  const lower = query.toLowerCase();
  for (const [id, name] of peerNames) {
    if (name.toLowerCase() === lower) return id;
    if (id.startsWith(query)) return id;
    if (name.toLowerCase().includes(lower)) return id;
  }
  return null;
}

// ============================================================
// HTTP upgrade routing (browser WS only)
// ============================================================

httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
  wss.handleUpgrade(req, socket as never, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// ============================================================
// Graceful shutdown
// ============================================================

async function shutdown(): Promise<void> {
  console.log('');
  log('SHUTDOWN', 'Closing connections...');
  for (const client of browserClients) client.close(1000, 'Server shutting down');
  browserClients.clear();
  if (sdk) await sdk.shutdown().catch(() => {});
  wss.close();
  httpServer.close(() => { log('SHUTDOWN', 'Server stopped.'); process.exit(0); });
  setTimeout(() => process.exit(1), 3000).unref();
}

process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });

// ============================================================
// Startup — SDK init first, then HTTP
// ============================================================

async function main(): Promise<void> {
  log('INIT', `Initialising MeshWhisper SDK (namespace=${NAMESPACE}, relay=${RELAY_URL})`);

  sdk = await MeshWhisper.init({
    namespace: NAMESPACE,
    node: RELAY_URL,
    storage: new NodeStorage(STORAGE_DIR),
    onMessage: (msg) => {
      const text = new TextDecoder().decode(new Uint8Array(msg.payload));
      const fromName = peerNames.get(msg.senderId) ?? msg.senderId.slice(0, 8);
      logEvent(`Message from ${C.bright}${fromName}${C.reset}${C.green}: "${text.slice(0, 80)}"`);

      broadcastToBrowsers({
        type: 'message',
        from: msg.senderId,
        fromName,
        text,
        timestamp: msg.timestamp,
      });
    },
    onConnectionStatus: (status) => {
      log('SDK', `Node connection: ${status}`);
      broadcastToBrowsers({ type: 'system', text: `Relay ${status}` });
    },
  });

  const localPeerId = sdk.getLocalPeerId();
  log('SDK', `Local peer ID: ${localPeerId.slice(0, 16)}...`);

  httpServer.listen(PORT, () => {
    console.log('');
    console.log(`${C.bright}${C.magenta}=== MeshWhisper Demo Server ===${C.reset}`);
    console.log('');
    console.log(`  ${C.bright}Peer Name:${C.reset}  ${PEER_NAME}`);
    console.log(`  ${C.bright}Peer ID:${C.reset}    ${localPeerId.slice(0, 16)}...`);
    console.log(`  ${C.bright}Relay:${C.reset}      ${RELAY_URL}`);
    console.log(`  ${C.bright}HTTP/UI:${C.reset}    http://localhost:${PORT}`);
    console.log(`  ${C.bright}WS:${C.reset}         ws://localhost:${PORT}`);
    console.log(`  ${C.bright}Contact API:${C.reset} http://localhost:${PORT}/api/contact`);
    console.log('');
    console.log(`${C.dim}  To connect another peer, run in a second terminal:${C.reset}`);
    console.log(`${C.dim}    npx tsx demo/server.ts ${PORT + 1} Bob ${RELAY_URL}${C.reset}`);
    console.log(`${C.dim}  Then in the UI, connect to: http://localhost:${PORT + 1}${C.reset}`);
    console.log('');
  });
}

main().catch((err: Error) => {
  logError(`Fatal startup error: ${err.message}`);
  console.error(err);
  process.exit(1);
});
