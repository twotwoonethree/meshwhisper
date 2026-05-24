// Minimal Node HTTP server that reads the supervisor bot's JSONL audit log
// and serves it as a single JSON array. The client polls this every few
// seconds and re-indexes with FlexSearch on update.
//
// Stateless by design — the log file is the source of truth. Restart the
// server, restart the client; nothing is lost.
//
// Production note: this server has NO AUTHENTICATION. It assumes you bind
// to localhost only. Anyone who can hit this port can read every chat the
// supervisor has been on. A real deployment must add auth (basic, OIDC,
// SSO, mTLS — pick what your portal already uses).

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PORT = Number(process.env.DASHBOARD_API_PORT ?? 5175);
const AUDIT_LOG = process.env.AUDIT_LOG_PATH ?? path.resolve('../data/supervisor/audit.jsonl');

interface AuditEntry {
  ts: string;
  observedAt: string;
  groupId: string;
  senderPeerId: string;
  groupSenderId?: string;
  text: string;
}

function readAuditLog(): AuditEntry[] {
  if (!fs.existsSync(AUDIT_LOG)) return [];
  const raw = fs.readFileSync(AUDIT_LOG, 'utf8');
  const out: AuditEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as AuditEntry);
    } catch {
      // Skip malformed lines — log rotation, partial writes, etc.
    }
  }
  return out;
}

const server = http.createServer((req, res) => {
  if (!req.url) {
    res.writeHead(400);
    res.end();
    return;
  }

  if (req.url === '/api/audit') {
    const entries = readAuditLog();
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ entries, count: entries.length }));
    return;
  }

  if (req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, logPath: AUDIT_LOG }));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[dashboard-api] listening on http://127.0.0.1:${PORT}`);
  console.log(`[dashboard-api] audit log: ${AUDIT_LOG}`);
});
