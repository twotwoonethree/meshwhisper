#!/usr/bin/env node
// ============================================================
// MeshWhisper Push Service
// Accepts webhook POSTs from the MeshWhisper Node and dispatches
// silent wake notifications via APNs and/or FCM.
//
// Usage:
//   PUSH_PORT=4000 \
//   APNS_KEY_ID=XXXXXXXXXX \
//   APNS_TEAM_ID=YYYYYYYYYY \
//   APNS_KEY_PATH=./AuthKey_XXXXXXXXXX.p8 \
//   APNS_BUNDLE_ID=com.example.myapp \
//   FCM_SERVICE_ACCOUNT_PATH=./firebase-service-account.json \
//   FCM_PROJECT_ID=my-firebase-project \
//   node dist/index.js
//
// Configure the MeshWhisper Node to point at this service:
//   PUSH_WEBHOOK_URL=http://localhost:4000/notify
//
// Webhook payload (from Node):
//   { token: string, platform: "apns" | "fcm", topic?: string, destHash: string }
// ============================================================

import * as http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadApnsConfig, sendApns } from './apns.js';
import { loadFcmConfig, sendFcm } from './fcm.js';
import { loadWebPushConfig, sendWebPush, type WebPushSubscription } from './webpush.js';

// ============================================================
// Configuration
// ============================================================

const PORT = parseInt(process.env.PUSH_PORT ?? '4000', 10);

const apnsConfig    = loadApnsConfig();
const fcmConfig     = loadFcmConfig();
const webPushConfig = loadWebPushConfig();

if (!apnsConfig && !fcmConfig && !webPushConfig) {
  console.warn('[push-service] WARNING: No push provider configured.');
  console.warn('[push-service] Set APNS_*, FCM_*, or VAPID_* environment variables to enable push delivery.');
}

// ============================================================
// Webhook handler
// ============================================================

interface WebhookPayload {
  /** APNs / FCM device token, or for webpush a JSON-serialised PushSubscription. */
  token: string;
  platform: 'apns' | 'fcm' | 'webpush';
  topic?: string;
  destHash: string;
  /** Pre-parsed Web Push subscription (sent by Node when platform=webpush). */
  pushSubscription?: WebPushSubscription;
}

async function handleNotify(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Read body
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', resolve);
    req.on('error', reject);
  });

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    res.writeHead(400).end('Invalid JSON');
    return;
  }

  const { token, platform, topic, destHash } = payload;
  if (!token || !platform || !destHash) {
    res.writeHead(400).end('Missing required fields: token, platform, destHash');
    return;
  }

  // Dispatch — best effort
  try {
    if (platform === 'apns') {
      if (!apnsConfig) {
        console.warn(`[push-service] APNs not configured — dropping push for ${destHash}`);
      } else {
        const apnsTopic = topic ?? apnsConfig.bundleId;
        await sendApns(apnsConfig, token, apnsTopic);
        console.log(`[push-service] APNs sent for destHash=${destHash}`);
      }
    } else if (platform === 'fcm') {
      if (!fcmConfig) {
        console.warn(`[push-service] FCM not configured — dropping push for ${destHash}`);
      } else {
        await sendFcm(fcmConfig, token);
        console.log(`[push-service] FCM sent for destHash=${destHash}`);
      }
    } else if (platform === 'webpush') {
      if (!webPushConfig) {
        console.warn(`[push-service] Web Push not configured — dropping push for ${destHash}`);
      } else {
        // Subscription may arrive as a pre-parsed object or as a JSON string in token
        let subscription: WebPushSubscription | null = payload.pushSubscription ?? null;
        if (!subscription && token) {
          try { subscription = JSON.parse(token) as WebPushSubscription; } catch { /* bad token */ }
        }
        if (!subscription) {
          console.warn(`[push-service] webpush: no valid subscription for ${destHash}`);
        } else {
          await sendWebPush(webPushConfig, subscription, destHash);
          console.log(`[push-service] Web Push sent for destHash=${destHash}`);
        }
      }
    } else {
      console.warn(`[push-service] Unknown platform: ${platform}`);
    }
  } catch (err) {
    console.error(`[push-service] Push failed for destHash=${destHash}:`, err);
    // Still return 200 — the Node shouldn't retry on push failures
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

// ============================================================
// HTTP server
// ============================================================

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/notify') {
    handleNotify(req, res).catch((err) => {
      console.error('[push-service] Handler error:', err);
      res.writeHead(500).end();
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      apns: !!apnsConfig,
      fcm: !!fcmConfig,
      webpush: !!webPushConfig,
    }));
    return;
  }

  res.writeHead(404).end();
});

server.listen(PORT, () => {
  console.log(`MeshWhisper Push Service listening on port ${PORT}`);
  console.log(`  APNs:     ${apnsConfig    ? `enabled (${apnsConfig.production ? 'production' : 'sandbox'})` : 'disabled'}`);
  console.log(`  FCM:      ${fcmConfig     ? `enabled (project: ${fcmConfig.projectId})` : 'disabled'}`);
  console.log(`  Web Push: ${webPushConfig ? 'enabled' : 'disabled (set VAPID_* to enable)'}`);
  console.log(`  Webhook endpoint: POST http://localhost:${PORT}/notify`);
});

function shutdown(): void {
  console.log('\nShutting down...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
