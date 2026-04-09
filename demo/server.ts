// ============================================================
// MeshWhisper Demo Server
// ============================================================
//
// A lightweight WebSocket bridge that lets browser-based test UIs
// interact with multiple MeshWhisper SDK instances (simulated peers).
//
// Usage:
//   npx tsx demo/server.ts [port] [peer-name]
//
// Examples:
//   Terminal 1: npx tsx demo/server.ts 3001 Alice
//   Terminal 2: npx tsx demo/server.ts 3002 Bob
//
// Each instance serves a static UI from demo/public/ and exposes a
// WebSocket endpoint on the same port.  Browser clients send JSON
// commands; the server bridges them to the peer mesh.
//
// Dependencies: ws (already in package.json)
// Dev dependency needed: tsx (add to devDependencies)
//
// NOTE: This server uses a lightweight fallback mode that works
// independently of the full SDK, so the demo UI is functional even
// while the SDK is still being developed/debugged.
// ============================================================

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';

// ============================================================
// CLI Arguments
// ============================================================

const PORT = parseInt(process.argv[2] || '3001', 10);
const PEER_NAME = process.argv[3] || `Peer-${PORT}`;

// ============================================================
// Logging Helpers
// ============================================================

const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
};

function log(category: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(
    `${COLORS.dim}[${ts}]${COLORS.reset} ${COLORS.cyan}[${category}]${COLORS.reset} ${msg}`
  );
}

function logEvent(msg: string): void {
  log('EVENT', `${COLORS.green}${msg}${COLORS.reset}`);
}

function logWarn(msg: string): void {
  log('WARN', `${COLORS.yellow}${msg}${COLORS.reset}`);
}

function logError(msg: string): void {
  log('ERROR', `${COLORS.red}${msg}${COLORS.reset}`);
}

// ============================================================
// MIME type map for static file serving
// ============================================================

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

// ============================================================
// Peer Registry (Fallback Mode)
// ============================================================
//
// Each demo server instance maintains:
//   - Its own identity (peerId, peerName)
//   - A list of connected remote peers (other demo servers)
//   - A list of connected browser clients
//
// When a browser sends a "connect" command, this server opens a
// WebSocket to the other demo server.  Both sides exchange identity
// info so they can route messages between browsers.
// ============================================================

/** Unique peer ID for this server instance. */
const LOCAL_PEER_ID = generatePeerId();

/** Information about a connected remote peer (another demo server). */
interface RemotePeer {
  peerId: string;
  peerName: string;
  address: string;
  ws: WebSocket;
  connectedAt: number;
}

/** Registry of remote peers, keyed by peerId. */
const remotePeers = new Map<string, RemotePeer>();

/** Set of addresses we are currently connecting to (prevents duplicate connections). */
const pendingConnections = new Set<string>();

/** Set of browser WebSocket clients attached to this server. */
const browserClients = new Set<WebSocket>();

// ============================================================
// Peer ID Generation
// ============================================================

function generatePeerId(): string {
  // Generate a 16-byte random hex string as peer ID
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ============================================================
// Static File Server
// ============================================================

const PUBLIC_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/i, '$1'),
  'public'
);

function serveStaticFile(
  req: IncomingMessage,
  res: http.ServerResponse
): void {
  let urlPath = req.url || '/';

  // Strip query string
  const qIdx = urlPath.indexOf('?');
  if (qIdx !== -1) urlPath = urlPath.slice(0, qIdx);

  // Default to index.html
  if (urlPath === '/') urlPath = '/index.html';

  // Decode and resolve the path, preventing directory traversal
  const decoded = decodeURIComponent(urlPath);
  const filePath = path.resolve(PUBLIC_DIR, '.' + decoded);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('500 Internal Server Error');
      }
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// ============================================================
// HTTP Server
// ============================================================

const httpServer = http.createServer((req, res) => {
  // CORS headers for development convenience
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  serveStaticFile(req, res);
});

// ============================================================
// WebSocket Server — Browser Clients
// ============================================================
//
// Browser clients connect to ws://localhost:<PORT> and send JSON
// commands.  The server processes them and sends JSON responses.
// ============================================================

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const clientAddr = req.socket.remoteAddress || 'unknown';
  log('WS', `Browser client connected from ${clientAddr}`);
  browserClients.add(ws);

  // Send initial status to the browser
  sendToBrowser(ws, {
    type: 'status',
    peerId: LOCAL_PEER_ID,
    peerName: PEER_NAME,
    transport: 'websocket-fallback',
    connections: remotePeers.size,
  });

  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
    try {
      const raw = data.toString();
      const msg = JSON.parse(raw);
      handleBrowserMessage(ws, msg);
    } catch (err) {
      logError(`Failed to parse browser message: ${err}`);
      sendToBrowser(ws, {
        type: 'system',
        text: 'Invalid JSON message',
      });
    }
  });

  ws.on('close', () => {
    log('WS', `Browser client disconnected from ${clientAddr}`);
    browserClients.delete(ws);
  });

  ws.on('error', (err) => {
    logError(`Browser WebSocket error: ${err.message}`);
    browserClients.delete(ws);
  });
});

// ============================================================
// Browser Message Handler
// ============================================================
//
// Protocol (browser -> server):
//   { type: "send", to: string, text: string }
//   { type: "get_peers" }
//   { type: "connect", address: string }
//   { type: "get_status" }
//   { type: "get_contact_info" }
//   { type: "accept_contact", data: string }
//   { type: "get_debug" }
//
// Protocol (server -> browser):
//   { type: "message", from: string, fromName: string, text: string, timestamp: number }
//   { type: "peers", list: [{ id, name, status }] }
//   { type: "status", peerId: string, peerName: string }
//   { type: "sent", to: string, text: string, timestamp: number }
//   { type: "system", text: string }
//   { type: "contact_info", data: string }
//   { type: "debug", reciprocity: {...}, routing: {...}, relay: {...} }
// ============================================================

function handleBrowserMessage(ws: WebSocket, msg: any): void {
  switch (msg.type) {
    case 'send':
      handleSendMessage(ws, msg);
      break;

    case 'get_peers':
      handleGetPeers(ws);
      break;

    case 'connect':
      handleConnect(ws, msg);
      break;

    case 'get_status':
      handleGetStatus(ws);
      break;

    case 'get_contact_info':
      handleGetContactInfo(ws);
      break;

    case 'accept_contact':
      handleAcceptContact(ws, msg);
      break;

    case 'get_debug':
      handleGetDebug(ws);
      break;

    default:
      logWarn(`Unknown browser message type: ${msg.type}`);
      sendToBrowser(ws, {
        type: 'system',
        text: `Unknown message type: ${msg.type}`,
      });
  }
}

// ---- send ----

function handleSendMessage(ws: WebSocket, msg: any): void {
  const { to, text } = msg;

  if (!to || !text) {
    sendToBrowser(ws, {
      type: 'system',
      text: 'Missing "to" or "text" field in send message',
    });
    return;
  }

  // Find the remote peer by peerId or peerName
  const peer = findPeer(to);

  if (!peer) {
    sendToBrowser(ws, {
      type: 'system',
      text: `Peer not found: ${to}. Use "get_peers" to see connected peers.`,
    });
    return;
  }

  // Forward the message to the remote peer's demo server
  const envelope = {
    type: 'relay_message',
    from: LOCAL_PEER_ID,
    fromName: PEER_NAME,
    to: peer.peerId,
    text,
    timestamp: Date.now(),
  };

  if (peer.ws.readyState === WebSocket.OPEN) {
    peer.ws.send(JSON.stringify(envelope));
    logEvent(`Message sent to ${peer.peerName} (${peer.peerId.slice(0, 8)}...): "${text.slice(0, 50)}"`);

    // Echo back to sender as confirmation (UI expects type: "sent")
    sendToBrowser(ws, {
      type: 'sent',
      to: peer.peerId,
      text,
      timestamp: Date.now(),
    });
  } else {
    sendToBrowser(ws, {
      type: 'system',
      text: `Peer ${peer.peerName} is not connected (WebSocket not open)`,
    });
  }
}

// ---- get_peers ----

function handleGetPeers(ws: WebSocket): void {
  const list = Array.from(remotePeers.values()).map((p) => ({
    id: p.peerId,
    name: p.peerName,
    status: p.ws.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
    address: p.address,
  }));

  sendToBrowser(ws, { type: 'peers', list });
}

/** Send a refreshed peer list to ALL browser clients. */
function broadcastPeerList(): void {
  const list = Array.from(remotePeers.values()).map((p) => ({
    id: p.peerId,
    name: p.peerName,
    status: p.ws.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
    address: p.address,
  }));

  broadcastToBrowsers({ type: 'peers', list });
}

// ---- connect ----

function handleConnect(ws: WebSocket, msg: any): void {
  const { address } = msg;

  if (!address) {
    sendToBrowser(ws, {
      type: 'system',
      text: 'Missing "address" field. Provide a WebSocket URL like ws://localhost:3002',
    });
    return;
  }

  // Normalize address
  let wsUrl = address.trim();
  if (!wsUrl.startsWith('ws://') && !wsUrl.startsWith('wss://')) {
    // Assume it is a host:port or just a port number
    if (/^\d+$/.test(wsUrl)) {
      wsUrl = `ws://localhost:${wsUrl}`;
    } else {
      wsUrl = `ws://${wsUrl}`;
    }
  }

  // Append the /peer path for inter-server connections
  if (!wsUrl.endsWith('/peer')) {
    wsUrl = wsUrl.replace(/\/+$/, '') + '/peer';
  }

  connectToRemotePeer(wsUrl, ws);
}

// ---- get_status ----

function handleGetStatus(ws: WebSocket): void {
  sendToBrowser(ws, {
    type: 'status',
    peerId: LOCAL_PEER_ID,
    peerName: PEER_NAME,
    transport: 'websocket-fallback',
    connections: remotePeers.size,
  });
}

// ---- get_contact_info ----

function handleGetContactInfo(ws: WebSocket): void {
  // In fallback mode, contact info is a simple JSON blob with our address
  const contactData = {
    peerId: LOCAL_PEER_ID,
    peerName: PEER_NAME,
    address: `ws://localhost:${PORT}/peer`,
  };

  sendToBrowser(ws, {
    type: 'contact_info',
    data: Buffer.from(JSON.stringify(contactData)).toString('base64'),
  });
}

// ---- accept_contact ----

function handleAcceptContact(ws: WebSocket, msg: any): void {
  try {
    const decoded = JSON.parse(
      Buffer.from(msg.data, 'base64').toString('utf-8')
    );

    if (decoded.address) {
      log('CONTACT', `Accepting contact from ${decoded.peerName || decoded.peerId}`);
      connectToRemotePeer(decoded.address, ws);
    } else {
      sendToBrowser(ws, {
        type: 'system',
        text: 'Invalid contact data: missing address',
      });
    }
  } catch (err) {
    sendToBrowser(ws, {
      type: 'system',
      text: `Failed to parse contact data: ${err}`,
    });
  }
}

// ---- get_debug ----

function handleGetDebug(ws: WebSocket): void {
  const peers = Array.from(remotePeers.values());

  sendToBrowser(ws, {
    type: 'debug',
    reciprocity: {
      totalPeers: peers.length,
      peers: peers.map((p) => ({
        peerId: p.peerId,
        peerName: p.peerName,
        connected: p.ws.readyState === WebSocket.OPEN,
        connectedAt: p.connectedAt,
        uptimeMs: Date.now() - p.connectedAt,
      })),
    },
    routing: {
      localPeerId: LOCAL_PEER_ID,
      localPeerName: PEER_NAME,
      port: PORT,
      mode: 'fallback-direct',
      knownPeers: peers.length,
    },
    relay: {
      mode: 'disabled-in-fallback',
      storedBlobs: 0,
    },
  });
}

// ============================================================
// Peer-to-Peer WebSocket Server (Inter-Server Communication)
// ============================================================
//
// Other demo server instances connect to /peer to form the mesh.
// This is a separate upgrade path on the same HTTP server.
// ============================================================

const peerWss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
  const pathname = new URL(req.url || '/', `http://${req.headers.host}`).pathname;

  if (pathname === '/peer') {
    // Inter-server peer connection
    peerWss.handleUpgrade(req, socket as any, head, (ws) => {
      peerWss.emit('connection', ws, req);
    });
  } else {
    // Browser client connection — handled by the default wss
    wss.handleUpgrade(req, socket as any, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  }
});

peerWss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const remoteAddr = req.socket.remoteAddress || 'unknown';
  log('PEER', `Incoming peer connection from ${remoteAddr}`);

  // Send our identity
  ws.send(
    JSON.stringify({
      type: 'identity',
      peerId: LOCAL_PEER_ID,
      peerName: PEER_NAME,
      address: `ws://localhost:${PORT}/peer`,
    })
  );

  // Wait for the remote side's identity
  let identified = false;

  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
    try {
      const msg = JSON.parse(data.toString());

      if (!identified && msg.type === 'identity') {
        identified = true;
        handlePeerIdentified(ws, msg, 'inbound');
        return;
      }

      if (identified) {
        handlePeerProtocolMessage(msg);
      }
    } catch (err) {
      logError(`Failed to parse peer message: ${err}`);
    }
  });

  ws.on('close', () => {
    handlePeerDisconnected(ws);
  });

  ws.on('error', (err) => {
    logError(`Peer WebSocket error: ${err.message}`);
    handlePeerDisconnected(ws);
  });
});

// ============================================================
// Outbound Peer Connections
// ============================================================

function connectToRemotePeer(wsUrl: string, browserWs?: WebSocket): void {
  // Prevent self-connections
  if (wsUrl.includes(`:${PORT}/peer`)) {
    if (browserWs) {
      sendToBrowser(browserWs, {
        type: 'system',
        text: 'Cannot connect to self',
      });
    }
    return;
  }

  // Prevent duplicate connections
  if (pendingConnections.has(wsUrl)) {
    if (browserWs) {
      sendToBrowser(browserWs, {
        type: 'system',
        text: `Already connecting to ${wsUrl}`,
      });
    }
    return;
  }

  // Check if already connected to this address
  for (const peer of remotePeers.values()) {
    if (peer.address === wsUrl) {
      if (browserWs) {
        sendToBrowser(browserWs, {
          type: 'system',
          text: `Already connected to ${peer.peerName} at ${wsUrl}`,
        });
      }
      return;
    }
  }

  pendingConnections.add(wsUrl);
  log('PEER', `Connecting to remote peer at ${wsUrl}...`);

  const ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    log('PEER', `Connected to ${wsUrl}, sending identity...`);

    // Send our identity
    ws.send(
      JSON.stringify({
        type: 'identity',
        peerId: LOCAL_PEER_ID,
        peerName: PEER_NAME,
        address: `ws://localhost:${PORT}/peer`,
      })
    );
  });

  let identified = false;

  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
    try {
      const msg = JSON.parse(data.toString());

      if (!identified && msg.type === 'identity') {
        identified = true;
        pendingConnections.delete(wsUrl);
        handlePeerIdentified(ws, msg, 'outbound');

        if (browserWs) {
          sendToBrowser(browserWs, {
            type: 'system',
            text: `Connected to ${msg.peerName} (${msg.peerId.slice(0, 8)}...)`,
          });
        }
        return;
      }

      if (identified) {
        handlePeerProtocolMessage(msg);
      }
    } catch (err) {
      logError(`Failed to parse peer message: ${err}`);
    }
  });

  ws.on('close', () => {
    pendingConnections.delete(wsUrl);
    handlePeerDisconnected(ws);
  });

  ws.on('error', (err) => {
    pendingConnections.delete(wsUrl);
    logError(`Outbound peer connection error to ${wsUrl}: ${err.message}`);

    if (browserWs) {
      sendToBrowser(browserWs, {
        type: 'system',
        text: `Failed to connect to ${wsUrl}: ${err.message}`,
      });
    }
  });
}

// ============================================================
// Peer Lifecycle Handlers
// ============================================================

function handlePeerIdentified(
  ws: WebSocket,
  identity: { peerId: string; peerName: string; address: string },
  direction: 'inbound' | 'outbound'
): void {
  const { peerId, peerName, address } = identity;

  // If we already have a connection to this peer, close the duplicate
  // (keep whichever was established first)
  if (remotePeers.has(peerId)) {
    const existing = remotePeers.get(peerId)!;
    if (existing.ws.readyState === WebSocket.OPEN) {
      log('PEER', `Duplicate connection from ${peerName} — keeping existing`);
      ws.close(1000, 'Duplicate connection');
      return;
    }
    // Existing connection is dead; replace it
    remotePeers.delete(peerId);
  }

  const peer: RemotePeer = {
    peerId,
    peerName,
    address,
    ws,
    connectedAt: Date.now(),
  };

  remotePeers.set(peerId, peer);
  logEvent(
    `Peer ${direction === 'inbound' ? 'accepted' : 'connected'}: ` +
      `${COLORS.bright}${peerName}${COLORS.reset}${COLORS.green} (${peerId.slice(0, 8)}...) via ${address}`
  );

  // Notify all browser clients: send updated peer list + system message
  broadcastPeerList();
  broadcastToBrowsers({
    type: 'system',
    text: `${peerName} connected`,
  });
}

function handlePeerDisconnected(ws: WebSocket): void {
  // Find and remove the peer
  for (const [peerId, peer] of remotePeers.entries()) {
    if (peer.ws === ws) {
      remotePeers.delete(peerId);
      logEvent(`Peer disconnected: ${peer.peerName} (${peerId.slice(0, 8)}...)`);

      // Notify all browser clients: updated peer list + system message
      broadcastPeerList();
      broadcastToBrowsers({
        type: 'system',
        text: `${peer.peerName} disconnected`,
      });
      return;
    }
  }
}

// ============================================================
// Peer Protocol Message Handler
// ============================================================
//
// Messages between demo servers use the following protocol:
//
//   { type: "identity", peerId, peerName, address }
//     - Exchanged on connection to identify each side
//
//   { type: "relay_message", from, fromName, to, text, timestamp }
//     - A message from one peer's user to another
//
// ============================================================

function handlePeerProtocolMessage(msg: any): void {
  switch (msg.type) {
    case 'relay_message':
      handleIncomingRelayMessage(msg);
      break;

    default:
      logWarn(`Unknown peer protocol message type: ${msg.type}`);
  }
}

function handleIncomingRelayMessage(msg: any): void {
  const { from, fromName, text, timestamp } = msg;

  logEvent(
    `Message received from ${COLORS.bright}${fromName}${COLORS.reset}${COLORS.green} ` +
      `(${from.slice(0, 8)}...): "${text.slice(0, 80)}"`
  );

  // Forward to all connected browser clients
  broadcastToBrowsers({
    type: 'message',
    from,
    fromName: fromName || from.slice(0, 8),
    text,
    timestamp: timestamp || Date.now(),
  });
}

// ============================================================
// Helpers
// ============================================================

/** Send a JSON message to a specific browser client. */
function sendToBrowser(ws: WebSocket, msg: any): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/** Broadcast a JSON message to ALL connected browser clients. */
function broadcastToBrowsers(msg: any): void {
  const payload = JSON.stringify(msg);
  for (const client of browserClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

/** Find a peer by ID or by name (case-insensitive partial match). */
function findPeer(query: string): RemotePeer | undefined {
  // Exact peerId match
  const exact = remotePeers.get(query);
  if (exact) return exact;

  // Case-insensitive name match
  const lower = query.toLowerCase();
  for (const peer of remotePeers.values()) {
    if (peer.peerName.toLowerCase() === lower) return peer;
  }

  // Partial peerId prefix match
  for (const peer of remotePeers.values()) {
    if (peer.peerId.startsWith(query)) return peer;
  }

  // Partial name match
  for (const peer of remotePeers.values()) {
    if (peer.peerName.toLowerCase().includes(lower)) return peer;
  }

  return undefined;
}

// ============================================================
// Start the Server
// ============================================================

httpServer.listen(PORT, () => {
  console.log('');
  console.log(
    `${COLORS.bright}${COLORS.magenta}=== MeshWhisper Demo Server ===${COLORS.reset}`
  );
  console.log('');
  console.log(`  ${COLORS.bright}Peer Name:${COLORS.reset}  ${PEER_NAME}`);
  console.log(`  ${COLORS.bright}Peer ID:${COLORS.reset}    ${LOCAL_PEER_ID.slice(0, 16)}...`);
  console.log(`  ${COLORS.bright}HTTP/UI:${COLORS.reset}    http://localhost:${PORT}`);
  console.log(`  ${COLORS.bright}WS (browser):${COLORS.reset} ws://localhost:${PORT}`);
  console.log(`  ${COLORS.bright}WS (peers):${COLORS.reset}  ws://localhost:${PORT}/peer`);
  console.log(`  ${COLORS.bright}Mode:${COLORS.reset}       Fallback (direct WebSocket mesh)`);
  console.log('');
  console.log(
    `${COLORS.dim}  To connect another peer, run in a second terminal:${COLORS.reset}`
  );
  console.log(
    `${COLORS.dim}    npx tsx demo/server.ts ${PORT + 1} Bob${COLORS.reset}`
  );
  console.log(
    `${COLORS.dim}  Then in the UI, connect to: ws://localhost:${PORT}/peer${COLORS.reset}`
  );
  console.log('');
});

// ============================================================
// Graceful Shutdown
// ============================================================

function shutdown(): void {
  console.log('');
  log('SHUTDOWN', 'Closing connections...');

  // Close all peer connections
  for (const peer of remotePeers.values()) {
    peer.ws.close(1000, 'Server shutting down');
  }
  remotePeers.clear();

  // Close all browser clients
  for (const client of browserClients) {
    client.close(1000, 'Server shutting down');
  }
  browserClients.clear();

  // Close servers
  peerWss.close();
  wss.close();
  httpServer.close(() => {
    log('SHUTDOWN', 'Server stopped.');
    process.exit(0);
  });

  // Force exit after 3 seconds if graceful shutdown stalls
  setTimeout(() => {
    process.exit(1);
  }, 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
