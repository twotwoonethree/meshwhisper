#!/usr/bin/env node
// ============================================================
// MeshWhisper CLI
//
//   npx @meshwhisper/cli init      scaffold a project: node deployment + SDK skeleton
//   npx @meshwhisper/cli doctor    health-check a MeshWhisper node
//   npx @meshwhisper/cli vapid     generate Web Push VAPID keys
//
// The init command is the front door described in docs/direction.md:
// npm install → running node + SDK skeleton in under 30 minutes.
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { generateKeyPairSync } from 'node:crypto';
import { stdin as input, stdout as output } from 'node:process';
import pc from 'picocolors';

const FOUNDATION_RELAY = 'wss://relay.meshwhisper.org';
const FOUNDATION_FEDERATION_PUBKEY =
  '34904664a3b5b0b35a8eb41bd3b1d493b79981af2a47069e246db28854d6ce23';
const DOCS_URL = 'https://github.com/twotwoonethree/meshwhisper/tree/main/docs';

// ============================================================
// Prompter
// ============================================================

// Line-queue prompter: unlike readline/promises, this buffers lines that
// arrive before a question is asked, so piped stdin (CI, tests, heredocs)
// works the same as an interactive TTY.
class Prompter {
  private queue: string[] = [];
  private waiters: Array<(line: string) => void> = [];
  private closed = false;
  private iface: readline.Interface;

  constructor() {
    this.iface = readline.createInterface({ input, output, terminal: input.isTTY ?? false });
    this.iface.on('line', (line) => {
      const waiter = this.waiters.shift();
      if (waiter) waiter(line);
      else this.queue.push(line);
    });
    this.iface.on('close', () => {
      this.closed = true;
      for (const waiter of this.waiters) waiter('');
      this.waiters = [];
    });
  }

  async question(prompt: string): Promise<string> {
    output.write(prompt);
    if (this.queue.length > 0) {
      const line = this.queue.shift()!;
      if (!input.isTTY) output.write(line + '\n');
      return line;
    }
    if (this.closed) {
      output.write('\n');
      return '';
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    if (!this.closed) this.iface.close();
  }
}

// ============================================================
// Output helpers
// ============================================================

function banner(): void {
  console.log('');
  console.log(pc.bold(pc.cyan('  MeshWhisper CLI')));
  console.log(pc.dim('  Self-hostable E2EE messaging — SDK + relay node'));
  console.log('');
}

function step(n: number, text: string): void {
  console.log('');
  console.log(pc.bold(pc.green(`  ${n}.`)) + ' ' + pc.bold(text));
}

function note(text: string): void {
  console.log(pc.dim(`     ${text}`));
}

function wrote(file: string): void {
  console.log(`  ${pc.green('✓')} wrote ${pc.cyan(file)}`);
}

function cmd(text: string): void {
  console.log(`       ${pc.yellow(text)}`);
}

// ============================================================
// VAPID key generation (Web Push, RFC 8292) — no dependencies.
// Same output format as `npx web-push generate-vapid-keys`.
// ============================================================

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pub = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const priv = privateKey.export({ format: 'jwk' }) as { d: string };
  const x = Buffer.from(pub.x, 'base64url');
  const y = Buffer.from(pub.y, 'base64url');
  // Uncompressed EC point: 0x04 || X || Y (65 bytes)
  const point = Buffer.concat([Buffer.from([0x04]), x, y]);
  return { publicKey: b64url(point), privateKey: priv.d };
}

// ============================================================
// Generated file templates
// ============================================================

function dockerfileNode(): string {
  return `# MeshWhisper Node — relay, store-and-forward, push forwarding, media
# storage, encrypted archive, username directory, federation.
# Installs the published @meshwhisper/node package; no repo checkout needed.

FROM node:22-alpine AS builder
# python3/make/g++ compile better-sqlite3's native bindings
RUN apk add --no-cache python3 make g++ \\
 && npm install -g --prefix /opt/meshwhisper @meshwhisper/node

FROM node:22-alpine
ENV NODE_ENV=production
ENV DB_PATH=/data/meshwhisper.db
COPY --from=builder /opt/meshwhisper /opt/meshwhisper
# sqlite CLI enables the documented hot-backup procedure:
#   docker compose exec node sqlite3 /data/meshwhisper.db ".backup /data/backup.db"
RUN apk add --no-cache sqlite \\
 && mkdir -p /data \\
 && addgroup -S meshwhisper && adduser -S meshwhisper -G meshwhisper \\
 && chown meshwhisper:meshwhisper /data
USER meshwhisper
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \\
  CMD wget -qO- http://localhost:\${PORT:-8080}/health || exit 1
CMD ["/opt/meshwhisper/bin/meshwhisper-node"]
`;
}

function dockerfilePush(): string {
  return `# MeshWhisper push service — Web Push (VAPID) / APNs / FCM wake signals.
FROM node:22-alpine AS builder
RUN npm install -g --prefix /opt/meshwhisper @meshwhisper/push-service

FROM node:22-alpine
ENV NODE_ENV=production
COPY --from=builder /opt/meshwhisper /opt/meshwhisper
RUN addgroup -S meshwhisper && adduser -S meshwhisper -G meshwhisper
USER meshwhisper
EXPOSE 4000
CMD ["/opt/meshwhisper/bin/meshwhisper-push"]
`;
}

function dockerCompose(opts: { push: boolean; federation: boolean }): string {
  const lines: string[] = [];
  lines.push('# Generated by `npx @meshwhisper/cli init`.');
  lines.push('# Copy this directory to your server, review .env, then: docker compose up -d');
  lines.push('# Full operator guide: docs/self-hosting.md in the MeshWhisper repo.');
  lines.push('');
  lines.push('services:');
  lines.push('  node:');
  lines.push('    build:');
  lines.push('      context: .');
  lines.push('      dockerfile: Dockerfile.node');
  lines.push('    restart: unless-stopped');
  lines.push('    ports:');
  lines.push('      # Bound to localhost — your reverse proxy (Caddy/nginx) terminates TLS.');
  lines.push('      - "127.0.0.1:8080:8080"');
  lines.push('    environment:');
  lines.push('      PORT: "8080"');
  lines.push('      BASE_URL: "${BASE_URL}"');
  lines.push('      DB_PATH: "/data/meshwhisper.db"');
  lines.push('      BLOB_TTL_HOURS: "720"');
  lines.push('      MEDIA_TTL_HOURS: "168"');
  lines.push('      # Trust X-Forwarded-For from the reverse proxy for rate limiting');
  lines.push('      TRUST_PROXY: "1"');
  if (opts.push) {
    lines.push('      PUSH_WEBHOOK_URL: "http://push:4000/notify"');
  }
  if (opts.federation) {
    lines.push('      # Open federation: forward packets for any relay that completes');
    lines.push('      # the handshake. See docs/federation.md for the threat model.');
    lines.push('      FEDERATION_MODE: "open"');
  }
  lines.push('    volumes:');
  lines.push('      - node_data:/data');
  if (opts.federation) {
    lines.push('      - ./federation-peers.json:/data/federation-peers.json:ro');
  }
  lines.push('    healthcheck:');
  lines.push('      test: ["CMD", "wget", "-qO-", "http://localhost:8080/health"]');
  lines.push('      interval: 30s');
  lines.push('      timeout: 5s');
  lines.push('      retries: 3');
  if (opts.push) {
    lines.push('');
    lines.push('  push:');
    lines.push('    build:');
    lines.push('      context: .');
    lines.push('      dockerfile: Dockerfile.push');
    lines.push('    restart: unless-stopped');
    lines.push('    environment:');
    lines.push('      PUSH_PORT: "4000"');
    lines.push('      VAPID_PUBLIC_KEY: "${VAPID_PUBLIC_KEY}"');
    lines.push('      VAPID_PRIVATE_KEY: "${VAPID_PRIVATE_KEY}"');
    lines.push('      VAPID_SUBJECT: "${VAPID_SUBJECT}"');
  }
  lines.push('');
  lines.push('volumes:');
  lines.push('  node_data:');
  lines.push('');
  return lines.join('\n');
}

function envFile(opts: {
  baseUrl: string;
  push: boolean;
  vapid?: { publicKey: string; privateKey: string };
  contactEmail: string;
}): string {
  const lines: string[] = [];
  lines.push('# MeshWhisper node environment — do NOT commit this file.');
  lines.push(`BASE_URL=${opts.baseUrl}`);
  if (opts.push && opts.vapid) {
    lines.push('');
    lines.push('# Web Push (generated by `npx @meshwhisper/cli init`; regenerate with `npx @meshwhisper/cli vapid`)');
    lines.push(`VAPID_PUBLIC_KEY=${opts.vapid.publicKey}`);
    lines.push(`VAPID_PRIVATE_KEY=${opts.vapid.privateKey}`);
    lines.push(`VAPID_SUBJECT=mailto:${opts.contactEmail}`);
  }
  lines.push('');
  return lines.join('\n');
}

function federationPeersFile(): string {
  return JSON.stringify(
    {
      peers: [
        {
          pubkey: FOUNDATION_FEDERATION_PUBKEY,
          url: FOUNDATION_RELAY,
        },
      ],
    },
    null,
    2,
  ) + '\n';
}

function browserSkeleton(opts: { namespace: string; nodeUrl: string; push: boolean }): string {
  const pushSetup = opts.push
    ? `
  // -- Web Push: wakes the app when a message arrives while it's closed --
  // Serve meshwhisper-sw.js from your domain root:
  //   cp node_modules/@meshwhisper/service-worker/dist/meshwhisper-sw.js public/
  const registration = await navigator.serviceWorker.register('/meshwhisper-sw.js');
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  });
`
    : '';
  const pushConfig = opts.push
    ? `
    push: {
      platform: 'webpush',
      subscription: subscription.toJSON() as WebPushSubscription,
    },`
    : '';
  const pushImport = opts.push ? `\nimport type { WebPushSubscription } from '@meshwhisper/sdk';` : '';
  const vapidConst = opts.push
    ? `\n// Your VAPID *public* key (same value as VAPID_PUBLIC_KEY in the node's .env)\nconst VAPID_PUBLIC_KEY = 'paste_your_vapid_public_key_here';\n
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}\n`
    : '';

  return `// Generated by \`npx @meshwhisper/cli init\` — browser/PWA messaging module.
// Everything is encrypted on-device; the node never holds a decryption key.

import { MeshWhisper } from '@meshwhisper/sdk';${pushImport}

const NAMESPACE = ${JSON.stringify(opts.namespace)};
const NODE_URL = ${JSON.stringify(opts.nodeUrl)};
${vapidConst}
export async function initMessaging(
  onText: (senderId: string, text: string) => void,
  onStatus?: (messageId: string, status: string) => void,
) {${pushSetup}
  const mw = await MeshWhisper.init({
    namespace: NAMESPACE,
    node: NODE_URL,${pushConfig}
    onMessage: async (message) => {
      const media = await MeshWhisper.downloadMedia(message);
      if (media) {
        console.log('media from', message.senderId, '-', media.byteLength, 'bytes');
        await MeshWhisper.markRead(message.id, message.senderId);
        return;
      }
      onText(message.senderId, new TextDecoder().decode(new Uint8Array(message.payload)));
      await MeshWhisper.markRead(message.id, message.senderId);
    },
    onMessageStatus: (messageId, status) => onStatus?.(messageId, status),
    onConnectionStatus: (status) => console.log('[meshwhisper]', status),
  });

  return mw;
}

// Your peer ID — share it (or register a username) so contacts can reach you
export function myId(): string {
  return MeshWhisper.instance.getLocalPeerId();
}

export async function send(recipientId: string, text: string): Promise<void> {
  await MeshWhisper.send(recipientId, new TextEncoder().encode(text));
}

export async function history(peerId: string) {
  return MeshWhisper.getMessages(peerId, { limit: 50 });
}
`;
}

function nodeSkeleton(opts: { namespace: string; nodeUrl: string }): string {
  return `// Generated by \`npx @meshwhisper/cli init\` — minimal terminal chat.
//
// Run two of these (different usernames) and message each other:
//   npx tsx meshwhisper-chat.mts alice
//   npx tsx meshwhisper-chat.mts bob
// Then in alice's terminal:   /add @bob
// and start typing.

import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { MeshWhisper } from '@meshwhisper/sdk';
import { NodeStorage } from '@meshwhisper/sdk/persistence/node';

const NAMESPACE = ${JSON.stringify(opts.namespace)};
const NODE_URL = ${JSON.stringify(opts.nodeUrl)};

const username = process.argv[2];
if (!username) {
  console.error('usage: npx tsx meshwhisper-chat.mts <username>');
  process.exit(1);
}

const mw = await MeshWhisper.init({
  namespace: NAMESPACE,
  node: NODE_URL,
  username,
  storage: new NodeStorage(\`./.meshwhisper/\${username}\`),
  onMessage: async (message) => {
    const text = new TextDecoder().decode(new Uint8Array(message.payload));
    console.log(\`\\n  \${message.senderId.slice(0, 8)}…  \${text}\`);
    await MeshWhisper.markRead(message.id, message.senderId);
  },
  onConnectionStatus: (status) => console.log(\`  [\${status}]\`),
});

console.log(\`  you are @\${username}  (\${mw.getLocalPeerId().slice(0, 16)}…)\`);
console.log('  /add @name   add a contact by username');
console.log('  anything else is sent to the last-added contact\\n');

let currentPeer: string | null = null;
const rl = readline.createInterface({ input, output });

for (;;) {
  const line = (await rl.question('> ')).trim();
  if (!line) continue;
  if (line === '/quit') break;
  if (line.startsWith('/add ')) {
    const target = line.slice(5).trim();
    const peerId = await MeshWhisper.addContactByKey(target);
    if (peerId) {
      currentPeer = peerId;
      console.log(\`  added \${target} → \${peerId.slice(0, 16)}…\`);
    } else {
      console.log(\`  could not find \${target}\`);
    }
    continue;
  }
  if (!currentPeer) {
    console.log('  no contact yet — /add @name first');
    continue;
  }
  await MeshWhisper.send(currentPeer, new TextEncoder().encode(line));
}

rl.close();
process.exit(0);
`;
}

// ============================================================
// File-writing helpers
// ============================================================

function writeIfAbsent(filePath: string, content: string, mode?: number): boolean {
  if (fs.existsSync(filePath)) {
    console.log(`  ${pc.yellow('!')} ${pc.cyan(path.relative(process.cwd(), filePath))} already exists — left untouched`);
    return false;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, mode !== undefined ? { mode } : undefined);
  wrote(path.relative(process.cwd(), filePath));
  return true;
}

function appendGitignore(entries: string[]): void {
  const gitignorePath = path.join(process.cwd(), '.gitignore');
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
  const missing = entries.filter((e) => !existing.split('\n').some((l) => l.trim() === e));
  if (missing.length === 0) return;
  const block = `${existing.endsWith('\n') || existing === '' ? '' : '\n'}\n# MeshWhisper — secrets and local identity stores\n${missing.join('\n')}\n`;
  fs.appendFileSync(gitignorePath, block);
  wrote('.gitignore (updated)');
}

// ============================================================
// init
// ============================================================

async function cmdInit(): Promise<void> {
  banner();
  console.log(pc.bold('  Scaffolding a MeshWhisper project\n'));

  const rl = new Prompter();

  // -- Namespace --
  let suggestedNs = 'com.example.myapp';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8')) as { name?: string };
    if (pkg.name) suggestedNs = `com.example.${pkg.name.replace(/^@[^/]+\//, '')}`;
  } catch { /* no package.json */ }

  const namespace =
    (await rl.question(pc.bold('  App namespace / bundle ID ') + pc.dim(`(${suggestedNs}): `))).trim() || suggestedNs;

  // -- Node choice --
  console.log('');
  console.log(pc.bold('  Which node should your app connect to?'));
  console.log(`    ${pc.cyan('1)')} Foundation relay ${pc.dim('— zero setup, fine for development and small deployments')}`);
  console.log(`    ${pc.cyan('2)')} Self-hosted ${pc.dim('— your own node on your own server (recommended for production)')}`);
  const nodeChoice = (await rl.question(pc.bold('  Choice ') + pc.dim('(1): '))).trim() || '1';
  const selfHosted = nodeChoice === '2';

  let nodeUrl = FOUNDATION_RELAY;
  let wantPush = false;
  let wantFederation = false;
  let contactEmail = 'you@example.com';

  if (selfHosted) {
    const urlAnswer = (await rl.question(pc.bold('  Node WebSocket URL ') + pc.dim('(wss://relay.myapp.com): '))).trim();
    nodeUrl = urlAnswer || 'wss://relay.myapp.com';
    if (!/^wss?:\/\//.test(nodeUrl)) nodeUrl = `wss://${nodeUrl}`;

    const pushAnswer = (await rl.question(pc.bold('  Enable Web Push notifications? ') + pc.dim('[Y/n]: '))).trim().toLowerCase();
    wantPush = pushAnswer === '' || pushAnswer === 'y' || pushAnswer === 'yes';
    if (wantPush) {
      contactEmail = (await rl.question(pc.bold('  Contact email for VAPID ') + pc.dim('(you@example.com): '))).trim() || contactEmail;
    }

    const fedAnswer = (await rl.question(
      pc.bold('  Join the relay mesh? ') + pc.dim('open federation — your node forwards packets for other relays [Y/n]: '),
    )).trim().toLowerCase();
    wantFederation = fedAnswer === '' || fedAnswer === 'y' || fedAnswer === 'yes';
  }

  // -- App platform --
  console.log('');
  console.log(pc.bold('  What kind of app are you building?'));
  console.log(`    ${pc.cyan('1)')} Browser / PWA`);
  console.log(`    ${pc.cyan('2)')} Node.js ${pc.dim('— bot, backend, CLI')}`);
  const platformChoice = (await rl.question(pc.bold('  Choice ') + pc.dim('(1): '))).trim() || '1';
  const isBrowser = platformChoice !== '2';

  rl.close();
  console.log('');

  // -- Write node deployment (self-hosted only) --
  if (selfHosted) {
    const deployDir = path.join(process.cwd(), 'meshwhisper-node');
    const baseUrl = nodeUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
    const vapid = wantPush ? generateVapidKeys() : undefined;

    writeIfAbsent(path.join(deployDir, 'docker-compose.yml'), dockerCompose({ push: wantPush, federation: wantFederation }));
    writeIfAbsent(path.join(deployDir, 'Dockerfile.node'), dockerfileNode());
    if (wantPush) writeIfAbsent(path.join(deployDir, 'Dockerfile.push'), dockerfilePush());
    writeIfAbsent(path.join(deployDir, '.env'), envFile({ baseUrl, push: wantPush, vapid, contactEmail }), 0o600);
    if (wantFederation) writeIfAbsent(path.join(deployDir, 'federation-peers.json'), federationPeersFile());
  }

  // -- Write SDK skeleton --
  const skeletonPath = isBrowser
    ? path.join(process.cwd(), 'src', 'meshwhisper.ts')
    : path.join(process.cwd(), 'meshwhisper-chat.mts');
  writeIfAbsent(
    skeletonPath,
    isBrowser
      ? browserSkeleton({ namespace, nodeUrl, push: selfHosted && wantPush })
      : nodeSkeleton({ namespace, nodeUrl }),
  );

  appendGitignore([
    ...(selfHosted ? ['meshwhisper-node/.env'] : []),
    '.meshwhisper/',
  ]);

  // -- Health-check the chosen node --
  if (!selfHosted) {
    const healthUrl = nodeUrl.replace(/^wss/, 'https').replace(/^ws(?!s)/, 'http') + '/health';
    try {
      const resp = await fetch(healthUrl, { signal: AbortSignal.timeout(4000) });
      if (resp.ok) console.log(`  ${pc.green('✓')} node reachable at ${pc.cyan(nodeUrl)}`);
      else console.log(`  ${pc.yellow('!')} node at ${nodeUrl} returned HTTP ${resp.status}`);
    } catch {
      console.log(`  ${pc.yellow('!')} could not reach ${nodeUrl} — check connectivity`);
    }
  }

  // -- Next steps --
  console.log('');
  console.log(pc.bold(pc.green('  Done. Next steps:')));
  let n = 1;

  step(n++, 'Install the SDK');
  cmd(`npm install @meshwhisper/sdk${isBrowser && selfHosted && wantPush ? ' @meshwhisper/service-worker' : ''}`);

  if (selfHosted) {
    step(n++, 'Deploy your node');
    note('Copy meshwhisper-node/ to your server, put TLS in front of port 8080');
    note('(Caddy: `reverse_proxy localhost:8080` — done), then:');
    cmd('docker compose up -d');
    note(`Verify: npx @meshwhisper/cli doctor ${nodeUrl}`);
    if (wantFederation) {
      note('Your node will auto-generate its federation identity at /data/federation-key.json');
      note('and peer with the Foundation relay. docs/federation.md has the details.');
    }
  }

  if (isBrowser) {
    step(n++, 'Wire src/meshwhisper.ts into your app');
    cmd(`import { initMessaging, myId, send } from './meshwhisper';`);
    if (selfHosted && wantPush) {
      note('Paste your VAPID public key (meshwhisper-node/.env) into src/meshwhisper.ts');
      note('and copy the service worker to your public dir:');
      cmd('cp node_modules/@meshwhisper/service-worker/dist/meshwhisper-sw.js public/');
    }
  } else {
    step(n++, 'Try it — two terminals, two identities');
    cmd('npx tsx meshwhisper-chat.mts alice');
    cmd('npx tsx meshwhisper-chat.mts bob');
    note('In alice: /add @bob — then chat. End-to-end encrypted via your node.');
  }

  console.log('');
  console.log(pc.dim(`  Docs: ${DOCS_URL}`));
  console.log('');
}

// ============================================================
// doctor
// ============================================================

async function cmdDoctor(urlArg?: string): Promise<void> {
  banner();
  const raw = urlArg || FOUNDATION_RELAY;
  const base = raw.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://').replace(/\/+$/, '');
  const healthUrl = base.startsWith('http') ? `${base}/health` : `https://${base}/health`;

  console.log(`  checking ${pc.cyan(healthUrl)}\n`);
  let body: Record<string, unknown>;
  try {
    const resp = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) {
      console.log(`  ${pc.red('✗')} HTTP ${resp.status}`);
      process.exit(1);
    }
    body = (await resp.json()) as Record<string, unknown>;
  } catch (err) {
    console.log(`  ${pc.red('✗')} unreachable: ${(err as Error).message}`);
    process.exit(1);
  }

  const ok = body.status === 'ok';
  console.log(`  ${ok ? pc.green('✓') : pc.red('✗')} status: ${String(body.status)}`);
  for (const [key, value] of Object.entries(body)) {
    if (key === 'status') continue;
    console.log(`    ${pc.dim(key + ':')} ${String(value)}`);
  }

  if ('federationPeersConnected' in body) {
    const connected = Number(body.federationPeersConnected);
    console.log('');
    if (connected > 0) {
      console.log(`  ${pc.green('✓')} federating with ${connected} peer relay(s)`);
    } else {
      console.log(pc.dim('  not currently federating — see docs/federation.md to join the mesh'));
    }
  }
  console.log('');
  if (!ok) process.exit(1);
}

// ============================================================
// vapid
// ============================================================

function cmdVapid(): void {
  banner();
  const keys = generateVapidKeys();
  console.log(pc.bold('  Web Push VAPID keys') + pc.dim(' — public goes in your app AND node .env; private is server-only\n'));
  console.log(`  VAPID_PUBLIC_KEY=${keys.publicKey}`);
  console.log(`  VAPID_PRIVATE_KEY=${keys.privateKey}`);
  console.log('');
}

// ============================================================
// Entry point
// ============================================================

const [, , command, ...args] = process.argv;

switch (command) {
  case 'init':
    await cmdInit();
    break;

  case 'doctor':
    await cmdDoctor(args[0]);
    break;

  case 'vapid':
    cmdVapid();
    break;

  case undefined:
  case '--help':
  case '-h':
    banner();
    console.log('  Usage:');
    console.log('');
    console.log(`    ${pc.cyan('npx @meshwhisper/cli init')}           Scaffold a project: node deployment + SDK skeleton`);
    console.log(`    ${pc.cyan('npx @meshwhisper/cli doctor [url]')}   Health-check a MeshWhisper node`);
    console.log(`    ${pc.cyan('npx @meshwhisper/cli vapid')}          Generate Web Push VAPID keys`);
    console.log('');
    break;

  default:
    console.error(pc.red(`  Unknown command: ${command}`));
    console.error(`  Run ${pc.bold('npx @meshwhisper/cli --help')} for usage.`);
    process.exit(1);
}
