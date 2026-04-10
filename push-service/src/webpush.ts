// ============================================================
// MeshWhisper Push Service — Web Push (VAPID)
// Sends silent wake notifications to browser/PWA subscribers
// using the Web Push Protocol (RFC 8030) with VAPID auth.
//
// Environment variables:
//   VAPID_PUBLIC_KEY   — Base64url VAPID public key
//   VAPID_PRIVATE_KEY  — Base64url VAPID private key
//   VAPID_SUBJECT      — mailto: or https: contact URI (required by spec)
//
// Generate VAPID keys once and store them:
//   node -e "const wp = require('web-push'); console.log(wp.generateVAPIDKeys())"
// ============================================================

import webpush from 'web-push';

// ---- Types ----

export interface WebPushConfig {
  vapidPublicKey: string;
  vapidPrivateKey: string;
  subject: string;
}

export interface WebPushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

// ---- Config loading ----

export function loadWebPushConfig(): WebPushConfig | null {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;

  if (!pub || !priv || !subject) return null;

  webpush.setVapidDetails(subject, pub, priv);

  return { vapidPublicKey: pub, vapidPrivateKey: priv, subject };
}

// ---- Send ----

/**
 * Sends a silent data push to the subscriber's browser/PWA.
 * The payload is intentionally minimal — the app reconnects on wake
 * and pulls queued messages. E2EE content never passes through the
 * push service.
 */
export async function sendWebPush(
  _config: WebPushConfig,
  subscription: WebPushSubscription,
  destHash: string,
): Promise<void> {
  // Silent data message — just enough for the service worker to know
  // there is something to fetch. No E2EE content here.
  const payload = JSON.stringify({ type: 'meshwhisper:wake', destHash });

  await webpush.sendNotification(
    {
      endpoint: subscription.endpoint,
      expirationTime: subscription.expirationTime ?? null,
      keys: subscription.keys,
    },
    payload,
    {
      // TTL in seconds — keep alive for 24h so the device receives it
      // when it next comes online.
      TTL: 86400,
    },
  );
}
