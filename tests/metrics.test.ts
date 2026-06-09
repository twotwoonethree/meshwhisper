// ============================================================
// Relay /metrics endpoint
//
// Pins the Prometheus text-format contract and verifies counters
// actually increment on observed traffic. Operators wiring this into
// Prometheus / Grafana depend on the metric names staying stable, so
// the explicit name assertions here are deliberate — renaming a
// metric is a contract break that should require a deliberate test
// update.
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

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
  const dbPath = path.join(os.tmpdir(), `mw-metrics-${port}-${Date.now()}.db`);
  const nodeDir = path.resolve(__dirname, '../node');
  const distEntry = path.join(nodeDir, 'dist/index.js');
  const srcEntry = path.join(nodeDir, 'src/index.ts');
  const useCompiled = fs.existsSync(distEntry);
  const proc = childProcess.spawn(
    useCompiled ? 'node' : 'npx',
    useCompiled ? [distEntry] : ['tsx', srcEntry],
    {
      cwd: nodeDir,
      env: { ...process.env, PORT: String(port), DB_PATH: dbPath, NODE_ENV: 'test', ...env },
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

/** Parse a single counter/gauge value from Prometheus text by metric name (no labels). */
function readBareMetric(text: string, name: string): number | null {
  const re = new RegExp(`^${name}\\s+(-?\\d+(?:\\.\\d+)?)$`, 'm');
  const m = text.match(re);
  return m ? Number(m[1]) : null;
}

/** Parse a labelled metric value. */
function readLabeledMetric(text: string, name: string, labelName: string, labelValue: string): number | null {
  const re = new RegExp(`^${name}\\{${labelName}="${labelValue}"\\}\\s+(-?\\d+(?:\\.\\d+)?)$`, 'm');
  const m = text.match(re);
  return m ? Number(m[1]) : null;
}

describe('/metrics endpoint', () => {
  const PORT = 19895;
  const BASE = `http://127.0.0.1:${PORT}`;
  let proc: childProcess.ChildProcess;
  let dbPath: string;

  beforeAll(async () => {
    // Tight rate-limit budgets so the rejection counter is easy to exercise.
    ({ proc, dbPath } = spawnRelay(PORT, { RATE_LIMIT_READ: '2' }));
    await waitForRelay(PORT, proc, 15000);
  }, 15000);

  afterAll(() => stopRelay(proc, dbPath));

  it('serves text/plain with a Prometheus v0.0.4 content-type', async () => {
    const res = await fetch(`${BASE}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain.*version=0\.0\.4/);
    const body = await res.text();
    expect(body).toMatch(/# HELP meshwhisper_uptime_seconds/);
    expect(body).toMatch(/# TYPE meshwhisper_clients_connected gauge/);
  });

  it('emits each documented metric name at least once', async () => {
    const body = await (await fetch(`${BASE}/metrics`)).text();
    const expected = [
      'meshwhisper_uptime_seconds',
      'meshwhisper_clients_connected',
      'meshwhisper_stored_blobs',
      'meshwhisper_prekey_entries',
      'meshwhisper_push_registrations',
      'meshwhisper_media_entries',
      'meshwhisper_opk_entries',
      'meshwhisper_archive_entries',
      'meshwhisper_http_requests_total',
      'meshwhisper_http_responses_total',
      'meshwhisper_rate_limit_rejections_total',
      'meshwhisper_websocket_connections_total',
    ];
    for (const name of expected) {
      expect(body).toContain(`# HELP ${name} `);
    }
  });

  it('http_requests_total increments on observed traffic', async () => {
    const before = readBareMetric(
      await (await fetch(`${BASE}/metrics`)).text(),
      'meshwhisper_http_requests_total',
    );
    expect(before).not.toBeNull();
    // Generate 5 health requests; each should bump the counter.
    for (let i = 0; i < 5; i++) await fetch(`${BASE}/health`);
    const after = readBareMetric(
      await (await fetch(`${BASE}/metrics`)).text(),
      'meshwhisper_http_requests_total',
    );
    expect(after).not.toBeNull();
    // +5 for the health calls + 1 each for the two /metrics calls themselves
    expect(after! - before!).toBeGreaterThanOrEqual(5);
  });

  it('rate_limit_rejections counter increments per bucket when 429 fires', async () => {
    // Burst the read bucket (limit 2 from beforeAll).
    const ns = `metrics-rl-${Date.now()}`;
    for (let i = 0; i < 5; i++) {
      await fetch(`${BASE}/directory?namespace=${ns}&username=u${i}`);
    }
    const body = await (await fetch(`${BASE}/metrics`)).text();
    const readBucketCount = readLabeledMetric(
      body, 'meshwhisper_rate_limit_rejections_total', 'bucket', 'read',
    );
    expect(readBucketCount).not.toBeNull();
    expect(readBucketCount!).toBeGreaterThan(0);

    // Other buckets should still be at zero.
    expect(readLabeledMetric(body, 'meshwhisper_rate_limit_rejections_total', 'bucket', 'media')).toBe(0);
    expect(readLabeledMetric(body, 'meshwhisper_rate_limit_rejections_total', 'bucket', 'archive')).toBe(0);
  });

  it('http_responses_total breaks down by status family', async () => {
    const body = await (await fetch(`${BASE}/metrics`)).text();
    // 2xx must be non-zero (health checks during waitForRelay).
    const twoXX = readLabeledMetric(body, 'meshwhisper_http_responses_total', 'status', '2xx');
    expect(twoXX).not.toBeNull();
    expect(twoXX!).toBeGreaterThan(0);
    // 429 should also have fired from the previous rate-limit test.
    const four29 = readLabeledMetric(body, 'meshwhisper_http_responses_total', 'status', '429');
    expect(four29).not.toBeNull();
    expect(four29!).toBeGreaterThan(0);
  });
});
