// ============================================================
// Relay rate limiting
//
// Verifies the per-IP sliding-window limits on each bucket and the
// shape of the 429 response (Retry-After header, retryAfter in body).
// Also pins the X-Forwarded-For trust gate so we don't regress on
// the spoof-evasion fix.
//
// Each test spawns a relay with custom RATE_LIMIT_* env vars to keep
// the limits small enough to hit quickly in CI without hammering the
// default budgets.
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

// ---- Relay harness ----

async function waitForRelay(port: number, proc: childProcess.ChildProcess, timeoutMs = 10000): Promise<void> {
  let exited = false;
  let exitCode: number | null = null;
  proc.once('exit', (code) => { exited = true; exitCode = code; });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`Relay exited early (code ${exitCode})`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Relay did not start within ${timeoutMs}ms`);
}

function spawnRelay(
  port: number,
  env: Record<string, string> = {},
): { proc: childProcess.ChildProcess; dbPath: string } {
  const dbPath = path.join(os.tmpdir(), `mw-ratelimit-${port}-${Date.now()}.db`);
  const nodeDir = path.resolve(__dirname, '../node');
  const distEntry = path.join(nodeDir, 'dist/index.js');
  const srcEntry = path.join(nodeDir, 'src/index.ts');
  const useCompiled = fs.existsSync(distEntry);
  const proc = childProcess.spawn(
    useCompiled ? 'node' : 'npx',
    useCompiled ? [distEntry] : ['tsx', srcEntry],
    {
      cwd: nodeDir,
      env: {
        ...process.env,
        PORT: String(port),
        DB_PATH: dbPath,
        NODE_ENV: 'test',
        ...env,
      },
      stdio: 'pipe',
    },
  );
  return { proc, dbPath };
}

function stopRelay(proc: childProcess.ChildProcess, dbPath: string): void {
  proc.kill('SIGTERM');
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + ext); } catch { /* ignore */ }
  }
}

// ---- Suite ----

describe('Relay rate limiting', () => {
  describe('write bucket (RATE_LIMIT_DIR)', () => {
    const PORT = 19890;
    const BASE = `http://127.0.0.1:${PORT}`;
    let proc: childProcess.ChildProcess;
    let dbPath: string;

    beforeAll(async () => {
      // Limit of 3 lets us hit the cap fast.
      ({ proc, dbPath } = spawnRelay(PORT, { RATE_LIMIT_DIR: '3' }));
      await waitForRelay(PORT, proc, 15000);
    }, 15000);

    afterAll(() => stopRelay(proc, dbPath));

    async function poke(): Promise<Response> {
      return fetch(`${BASE}/namespace-policy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          namespace: `com.test.rl.${Math.random()}`,
          usernamePolicy: 'signed-transfer',
        }),
      });
    }

    it('first N writes succeed, N+1 returns 429', async () => {
      for (let i = 0; i < 3; i++) {
        const res = await poke();
        expect(res.status).toBe(200);
      }
      const blocked = await poke();
      expect(blocked.status).toBe(429);
    });

    it('429 response carries Retry-After header and retryAfter field', async () => {
      const blocked = await poke();
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('retry-after')).not.toBeNull();
      const seconds = Number(blocked.headers.get('retry-after'));
      expect(seconds).toBeGreaterThan(0);
      expect(seconds).toBeLessThanOrEqual(60);
      const body = await blocked.json();
      expect(body.error).toBeDefined();
      expect(body.retryAfter).toBeGreaterThan(0);
    });
  });

  describe('read bucket (RATE_LIMIT_READ)', () => {
    const PORT = 19891;
    const BASE = `http://127.0.0.1:${PORT}`;
    let proc: childProcess.ChildProcess;
    let dbPath: string;

    beforeAll(async () => {
      ({ proc, dbPath } = spawnRelay(PORT, { RATE_LIMIT_READ: '4' }));
      await waitForRelay(PORT, proc, 15000);
    }, 15000);

    afterAll(() => stopRelay(proc, dbPath));

    it('read bucket gates GET /directory separately from write bucket', async () => {
      const ns = `com.test.rl.read.${Date.now()}`;
      // 4 lookups OK, 5th 429. Lookups against a non-existent user return 404
      // but still count against the rate limit.
      for (let i = 0; i < 4; i++) {
        const res = await fetch(`${BASE}/directory?namespace=${ns}&username=user${i}`);
        expect([200, 404]).toContain(res.status);
      }
      const blocked = await fetch(`${BASE}/directory?namespace=${ns}&username=blocked`);
      expect(blocked.status).toBe(429);
    });
  });

  describe('TRUST_PROXY gate', () => {
    const PORT_OFF = 19892;
    const PORT_ON = 19893;
    let procOff: childProcess.ChildProcess;
    let procOn: childProcess.ChildProcess;
    let dbOff: string;
    let dbOn: string;

    beforeAll(async () => {
      ({ proc: procOff, dbPath: dbOff } = spawnRelay(PORT_OFF, { RATE_LIMIT_READ: '2' }));
      ({ proc: procOn,  dbPath: dbOn }  = spawnRelay(PORT_ON,  { RATE_LIMIT_READ: '2', TRUST_PROXY: '1' }));
      await Promise.all([
        waitForRelay(PORT_OFF, procOff, 15000),
        waitForRelay(PORT_ON,  procOn,  15000),
      ]);
    }, 30000);

    afterAll(() => {
      stopRelay(procOff, dbOff);
      stopRelay(procOn,  dbOn);
    });

    async function pokeWithSpoofedIp(port: number, ip: string): Promise<Response> {
      return fetch(`http://127.0.0.1:${port}/namespace-policy?namespace=spoof.test`, {
        headers: { 'X-Forwarded-For': ip },
      });
    }

    it('TRUST_PROXY=off: spoofed X-Forwarded-For does NOT bypass limits', async () => {
      // First two requests with random IPs should hit the limit because
      // the relay tracks by the real socket address, not the header.
      await pokeWithSpoofedIp(PORT_OFF, '1.1.1.1');
      await pokeWithSpoofedIp(PORT_OFF, '2.2.2.2');
      const blocked = await pokeWithSpoofedIp(PORT_OFF, '3.3.3.3');
      expect(blocked.status).toBe(429);
    });

    it('TRUST_PROXY=on: distinct X-Forwarded-For IPs ARE tracked separately', async () => {
      // Each spoofed IP gets its own budget — proves the header is honored.
      const a1 = await pokeWithSpoofedIp(PORT_ON, '10.0.0.1');
      const a2 = await pokeWithSpoofedIp(PORT_ON, '10.0.0.1');
      const a3 = await pokeWithSpoofedIp(PORT_ON, '10.0.0.1');
      expect(a1.status).toBe(200);
      expect(a2.status).toBe(200);
      expect(a3.status).toBe(429); // 10.0.0.1 exhausted its 2-budget
      // A different IP still has fresh budget.
      const b1 = await pokeWithSpoofedIp(PORT_ON, '10.0.0.2');
      expect(b1.status).toBe(200);
    });
  });
});
