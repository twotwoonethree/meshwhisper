// ================================================================
// @meshwhisper/cli — init scaffolding, vapid keygen
//
// Runs the CLI from cli/src/index.ts via tsx with piped answers and
// asserts on the generated files. No network required (the doctor
// command and the Foundation-relay health check are not exercised).
// ================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const CLI = path.join(__dirname, '..', 'cli', 'src', 'index.ts');
const TSX = path.join(__dirname, '..', 'node_modules', '.bin', 'tsx');

function runInit(cwd: string, answers: string[]): string {
  return execFileSync(TSX, [CLI, 'init'], {
    cwd,
    input: answers.join('\n') + '\n',
    encoding: 'utf-8',
    timeout: 30_000,
  });
}

function runCli(args: string[]): string {
  return execFileSync(TSX, [CLI, ...args], { encoding: 'utf-8', timeout: 30_000 });
}

describe('CLI — init (self-hosted, push, federation, browser)', () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-cli-a-'));
    runInit(dir, [
      'com.acme.chat', // namespace
      '2',             // self-hosted
      'wss://relay.acme.com',
      'y',             // web push
      'ops@acme.com',  // vapid contact
      'y',             // join federation
      '1',             // browser app
    ]);
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes the full node deployment directory', () => {
    for (const f of ['docker-compose.yml', 'Dockerfile.node', 'Dockerfile.push', '.env', 'federation-peers.json']) {
      expect(fs.existsSync(path.join(dir, 'meshwhisper-node', f)), f).toBe(true);
    }
  });

  it('compose wires push, federation, and hardening defaults', () => {
    const compose = fs.readFileSync(path.join(dir, 'meshwhisper-node', 'docker-compose.yml'), 'utf-8');
    expect(compose).toContain('FEDERATION_MODE: "open"');
    expect(compose).toContain('./federation-peers.json:/data/federation-peers.json:ro');
    expect(compose).toContain('PUSH_WEBHOOK_URL: "http://push:4000/notify"');
    expect(compose).toContain('TRUST_PROXY: "1"');
    expect(compose).toContain('BLOB_TTL_HOURS: "720"');
    expect(compose).toContain('127.0.0.1:8080:8080');
  });

  it('Dockerfiles install published packages, not repo paths', () => {
    const node = fs.readFileSync(path.join(dir, 'meshwhisper-node', 'Dockerfile.node'), 'utf-8');
    expect(node).toContain('npm install -g --prefix /opt/meshwhisper @meshwhisper/node');
    expect(node).not.toContain('COPY src');
    const push = fs.readFileSync(path.join(dir, 'meshwhisper-node', 'Dockerfile.push'), 'utf-8');
    expect(push).toContain('@meshwhisper/push-service');
  });

  it('.env has BASE_URL derived from the wss URL, VAPID keys, and mode 600', () => {
    const envPath = path.join(dir, 'meshwhisper-node', '.env');
    const env = fs.readFileSync(envPath, 'utf-8');
    expect(env).toContain('BASE_URL=https://relay.acme.com');
    expect(env).toMatch(/VAPID_PUBLIC_KEY=[A-Za-z0-9_-]{87}/);
    expect(env).toMatch(/VAPID_PRIVATE_KEY=[A-Za-z0-9_-]{43}/);
    expect(env).toContain('VAPID_SUBJECT=mailto:ops@acme.com');
    expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it('federation-peers.json bootstraps via the Foundation relay', () => {
    const peers = JSON.parse(fs.readFileSync(path.join(dir, 'meshwhisper-node', 'federation-peers.json'), 'utf-8'));
    expect(peers.peers).toHaveLength(1);
    expect(peers.peers[0].url).toBe('wss://relay.meshwhisper.org');
    expect(peers.peers[0].pubkey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('browser skeleton threads namespace, node URL, and push wiring', () => {
    const skeleton = fs.readFileSync(path.join(dir, 'src', 'meshwhisper.ts'), 'utf-8');
    expect(skeleton).toContain('const NAMESPACE = "com.acme.chat"');
    expect(skeleton).toContain('const NODE_URL = "wss://relay.acme.com"');
    expect(skeleton).toContain("platform: 'webpush'");
    expect(skeleton).toContain('MeshWhisper.init({');
  });

  it('gitignores the .env and local identity stores', () => {
    const gitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('meshwhisper-node/.env');
    expect(gitignore).toContain('.meshwhisper/');
  });

  it('is idempotent — re-running leaves existing files untouched', () => {
    const envBefore = fs.readFileSync(path.join(dir, 'meshwhisper-node', '.env'), 'utf-8');
    const out = runInit(dir, ['com.acme.chat', '2', 'wss://relay.acme.com', 'y', 'ops@acme.com', 'y', '1']);
    expect(out).toContain('already exists');
    const envAfter = fs.readFileSync(path.join(dir, 'meshwhisper-node', '.env'), 'utf-8');
    expect(envAfter).toBe(envBefore); // VAPID keys not regenerated
  });
});

describe('CLI — init (Foundation relay, Node.js app)', () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-cli-b-'));
    runInit(dir, ['org.test.demo', '1', '2']);
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes only the chat skeleton — no deployment dir', () => {
    expect(fs.existsSync(path.join(dir, 'meshwhisper-chat.mts'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'meshwhisper-node'))).toBe(false);
  });

  it('skeleton targets the Foundation relay and is ESM (.mts) for type-less projects', () => {
    const skeleton = fs.readFileSync(path.join(dir, 'meshwhisper-chat.mts'), 'utf-8');
    expect(skeleton).toContain('const NODE_URL = "wss://relay.meshwhisper.org"');
    expect(skeleton).toContain('const NAMESPACE = "org.test.demo"');
    expect(skeleton).toContain('new NodeStorage(');
    expect(skeleton).toContain('MeshWhisper.addContactByKey(');
  });
});

describe('CLI — vapid', () => {
  it('emits keys in web-push format', () => {
    const out = runCli(['vapid']);
    const pub = out.match(/VAPID_PUBLIC_KEY=([A-Za-z0-9_-]+)/)?.[1];
    const priv = out.match(/VAPID_PRIVATE_KEY=([A-Za-z0-9_-]+)/)?.[1];
    expect(pub).toBeDefined();
    expect(priv).toBeDefined();
    // Uncompressed P-256 point (65 bytes) and scalar (32 bytes), base64url unpadded
    expect(Buffer.from(pub!, 'base64url')).toHaveLength(65);
    expect(Buffer.from(pub!, 'base64url')[0]).toBe(0x04);
    expect(Buffer.from(priv!, 'base64url')).toHaveLength(32);
  });
});
