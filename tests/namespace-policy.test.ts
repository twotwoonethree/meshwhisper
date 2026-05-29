// ============================================================
// Relay namespace-policy enforcement
//
// Covers stage 1 of the username-ownership change:
//   - default policy for an unrecorded namespace is 'signed-transfer'
//   - POST /namespace-policy is sticky (re-set with same value is fine,
//     re-set with different value returns 409)
//   - POST /directory rejects takeover under signed-transfer
//   - POST /directory allows takeover under last-writer-wins (opt-in)
//   - A 409'd takeover still leaves the new key discoverable by peerId
//     (graceful degradation handled in SDK; here we just assert relay
//     behavior at the HTTP boundary)
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

// ---- Helpers (kept local to avoid factoring tests/integration.test.ts) ----

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
  throw new Error(`Relay on port ${port} did not start within ${timeoutMs}ms`);
}

function spawnRelay(port: number): { proc: childProcess.ChildProcess; dbPath: string } {
  const dbPath = path.join(os.tmpdir(), `mw-policy-${port}-${Date.now()}.db`);
  const nodeDir = path.resolve(__dirname, '../node');
  const distEntry = path.join(nodeDir, 'dist/index.js');
  const srcEntry = path.join(nodeDir, 'src/index.ts');
  const useCompiled = fs.existsSync(distEntry);
  const proc = childProcess.spawn(
    useCompiled ? 'node' : 'npx',
    useCompiled ? [distEntry] : ['tsx', srcEntry],
    {
      cwd: nodeDir,
      env: { ...process.env, PORT: String(port), DB_PATH: dbPath, NODE_ENV: 'test' },
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

// Synthetic bundle payload — the relay treats `bundle` as opaque base64
// (no parsing), so any non-empty string passes validation. These tests
// only exercise the directory-policy code path, not bundle deserialisation.
const fakeBundle = (seed: string): string => Buffer.from(`bundle-for-${seed}`).toString('base64');
const fakeKey = (seed: string): string => seed.padEnd(64, '0').slice(0, 64);

// ---- Suite ----

describe('Relay namespace-policy enforcement', () => {
  const PORT = 19883;
  const NS = 'com.test.policy';
  let relayProc: childProcess.ChildProcess;
  let dbPath: string;
  const BASE = `http://127.0.0.1:${PORT}`;

  beforeAll(async () => {
    ({ proc: relayProc, dbPath } = spawnRelay(PORT));
    await waitForRelay(PORT, relayProc, 15000);
  }, 15000);

  afterAll(() => { stopRelay(relayProc, dbPath); });

  it('returns signed-transfer as the default for an unrecorded namespace', async () => {
    const res = await fetch(`${BASE}/namespace-policy?namespace=${NS}.default`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.usernamePolicy).toBe('signed-transfer');
  });

  it('POST /namespace-policy persists and re-POST with same value is idempotent', async () => {
    const ns = `${NS}.set-once`;
    const post = (policy: string) => fetch(`${BASE}/namespace-policy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ namespace: ns, usernamePolicy: policy }),
    });
    const first = await post('last-writer-wins');
    expect(first.status).toBe(200);
    const second = await post('last-writer-wins');
    expect(second.status).toBe(200);

    const read = await fetch(`${BASE}/namespace-policy?namespace=${ns}`);
    expect((await read.json()).usernamePolicy).toBe('last-writer-wins');
  });

  it('POST /namespace-policy rejects re-set with a different value (409)', async () => {
    const ns = `${NS}.conflict`;
    await fetch(`${BASE}/namespace-policy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ namespace: ns, usernamePolicy: 'signed-transfer' }),
    });
    const second = await fetch(`${BASE}/namespace-policy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ namespace: ns, usernamePolicy: 'last-writer-wins' }),
    });
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.currentPolicy).toBe('signed-transfer');
  });

  it('rejects invalid usernamePolicy values', async () => {
    const res = await fetch(`${BASE}/namespace-policy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ namespace: 'nope', usernamePolicy: 'whatever' }),
    });
    expect(res.status).toBe(400);
  });

  describe('POST /directory under signed-transfer (default)', () => {
    const ns = `${NS}.signed`;
    const username = 'alice';

    it('first claim succeeds', async () => {
      const res = await fetch(`${BASE}/directory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          namespace: ns,
          publicKey: fakeKey('aliceA'),
          bundle: fakeBundle('aliceA'),
          username,
        }),
      });
      expect(res.status).toBe(200);
    });

    it('re-publish from the same key keeps the username', async () => {
      const res = await fetch(`${BASE}/directory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          namespace: ns,
          publicKey: fakeKey('aliceA'),
          bundle: fakeBundle('aliceA-refreshed'),
          username,
        }),
      });
      expect(res.status).toBe(200);
      const lookup = await fetch(`${BASE}/directory?namespace=${ns}&username=${username}`);
      const body = await lookup.json();
      expect(body.publicKey).toBe(fakeKey('aliceA'));
    });

    it('takeover by a different key is rejected with 409', async () => {
      const res = await fetch(`${BASE}/directory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          namespace: ns,
          publicKey: fakeKey('aliceB'),
          bundle: fakeBundle('aliceB'),
          username,
        }),
      });
      expect(res.status).toBe(409);

      // The original owner is unchanged after the rejected takeover
      const lookup = await fetch(`${BASE}/directory?namespace=${ns}&username=${username}`);
      const body = await lookup.json();
      expect(body.publicKey).toBe(fakeKey('aliceA'));
    });

    it('a different key with NO username succeeds (peerId-only registration)', async () => {
      const res = await fetch(`${BASE}/directory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          namespace: ns,
          publicKey: fakeKey('aliceB'),
          bundle: fakeBundle('aliceB-noname'),
        }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe('POST /directory under last-writer-wins (opt-in)', () => {
    const ns = `${NS}.lww`;
    const username = 'robby';

    beforeAll(async () => {
      await fetch(`${BASE}/namespace-policy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ namespace: ns, usernamePolicy: 'last-writer-wins' }),
      });
    });

    it('first claim succeeds', async () => {
      const res = await fetch(`${BASE}/directory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          namespace: ns,
          publicKey: fakeKey('robbyA'),
          bundle: fakeBundle('robbyA'),
          username,
        }),
      });
      expect(res.status).toBe(200);
    });

    it('takeover by a different key succeeds and displaces the prior owner', async () => {
      const res = await fetch(`${BASE}/directory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          namespace: ns,
          publicKey: fakeKey('robbyB'),
          bundle: fakeBundle('robbyB'),
          username,
        }),
      });
      expect(res.status).toBe(200);

      const lookup = await fetch(`${BASE}/directory?namespace=${ns}&username=${username}`);
      const body = await lookup.json();
      expect(body.publicKey).toBe(fakeKey('robbyB'));
    });
  });
});
