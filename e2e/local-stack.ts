// Spin up a fresh local relay + Prudence dev server for e2e tests.
// Kills both children on exit. Each call creates a new isolated stack.
//
// Usage:
//   const stack = await startLocalStack();
//   process.env.PRUDENCE_URL = stack.prudenceUrl;
//   ... run tests ...
//   await stack.stop();

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const REPO_ROOT = join(import.meta.dirname, '..');

export interface LocalStack {
  relayPort: number;
  relayWsUrl: string;
  prudencePort: number;
  prudenceUrl: string;
  stop: () => Promise<void>;
}

/** Bind 0 to ask the OS for a free port, then close and return it. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr && addr.port) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('could not allocate port')));
      }
    });
  });
}

/** Wait until an HTTP probe returns 200. */
async function waitForHealth(url: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${url}`);
}

/** Wait until a TCP port is accepting connections. */
async function waitForPort(port: number, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      // Vite returns 200 for the root.
      if (res.ok || res.status < 500) return;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for port ${port}`);
}

export async function startLocalStack(): Promise<LocalStack> {
  const relayPort = await freePort();
  const prudencePort = await freePort();

  const dbDir = mkdtempSync(join(tmpdir(), 'mw-relay-db-'));
  const dbPath = join(dbDir, 'relay.db');

  const children: ChildProcess[] = [];

  const relayCwd = join(REPO_ROOT, 'node');
  const relay = spawn('node', ['dist/index.js'], {
    cwd: relayCwd,
    env: {
      ...process.env,
      PORT: String(relayPort),
      BASE_URL: `http://127.0.0.1:${relayPort}`,
      DB_PATH: dbPath,
      // Relax rate limits for tests — production defaults of 60/min for
      // directory ops choke a multi-user e2e run within seconds.
      RATE_LIMIT_DIR: '10000',
      RATE_LIMIT_BLOB: '100000',
      RATE_LIMIT_MEDIA: '10000',
      // No push-service URL — tests don't need push.
      PUSH_WEBHOOK_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(relay);
  relay.stdout?.on('data', (b) => process.stdout.write(`[relay] ${b}`));
  relay.stderr?.on('data', (b) => process.stderr.write(`[relay] ${b}`));

  await waitForHealth(`http://127.0.0.1:${relayPort}/health`);

  const prudenceCwd = join(REPO_ROOT, 'prudence');
  const vite = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(prudencePort), '--strictPort'], {
    cwd: prudenceCwd,
    env: {
      ...process.env,
      VITE_RELAY_URL: `ws://127.0.0.1:${relayPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(vite);
  vite.stdout?.on('data', (b) => process.stdout.write(`[vite] ${b}`));
  vite.stderr?.on('data', (b) => process.stderr.write(`[vite] ${b}`));

  await waitForPort(prudencePort);

  const stop = async () => {
    for (const child of children) {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }
    // Give them a moment, then SIGKILL anything still alive.
    await new Promise((r) => setTimeout(r, 500));
    for (const child of children) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* ok */ }
  };

  // Tear down on parent exit signals.
  for (const sig of ['SIGINT', 'SIGTERM', 'exit'] as const) {
    process.once(sig, () => { void stop(); });
  }

  return {
    relayPort,
    relayWsUrl: `ws://127.0.0.1:${relayPort}`,
    prudencePort,
    prudenceUrl: `http://127.0.0.1:${prudencePort}`,
    stop,
  };
}
