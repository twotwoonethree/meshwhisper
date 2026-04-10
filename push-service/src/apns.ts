// ============================================================
// APNs dispatch
// Uses the HTTP/2 APNs provider API with a .p8 auth key.
//
// Required env vars:
//   APNS_KEY_ID      — 10-char key ID from Apple Developer Portal
//   APNS_TEAM_ID     — 10-char team ID from Apple Developer Portal
//   APNS_KEY_PATH    — path to the .p8 private key file
//   APNS_BUNDLE_ID   — app bundle ID (used as topic if not provided per-push)
//   APNS_PRODUCTION  — set to "true" for production, omit for sandbox
// ============================================================

import * as http2 from 'node:http2';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

const APNS_HOST_SANDBOX    = 'api.sandbox.push.apple.com';
const APNS_HOST_PRODUCTION = 'api.push.apple.com';

// ---- JWT token generation ----

let cachedToken: { jwt: string; generatedAt: number } | null = null;

function generateApnsJwt(keyId: string, teamId: string, privateKeyPem: string): string {
  // Reuse the token for up to 55 minutes (APNs tokens expire after 60)
  if (cachedToken && Date.now() - cachedToken.generatedAt < 55 * 60 * 1000) {
    return cachedToken.jwt;
  }

  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: teamId,
    iat: Math.floor(Date.now() / 1000),
  })).toString('base64url');

  const signingInput = `${header}.${payload}`;
  const sign = crypto.createSign('SHA256');
  sign.update(signingInput);
  const signature = sign.sign({ key: privateKeyPem, dsaEncoding: 'ieee-p1363' })
    .toString('base64url');

  const jwt = `${signingInput}.${signature}`;
  cachedToken = { jwt, generatedAt: Date.now() };
  return jwt;
}

// ---- HTTP/2 session pool (one per host) ----

let h2Session: http2.ClientHttp2Session | null = null;
let h2Host: string | null = null;

function getH2Session(host: string): http2.ClientHttp2Session {
  if (h2Session && !h2Session.destroyed && h2Host === host) return h2Session;
  h2Session?.destroy();
  h2Session = http2.connect(`https://${host}`);
  h2Session.on('error', () => { h2Session = null; });
  h2Host = host;
  return h2Session;
}

// ---- Public API ----

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  keyPath: string;
  bundleId: string;
  production: boolean;
}

export function loadApnsConfig(): ApnsConfig | null {
  const keyId     = process.env.APNS_KEY_ID;
  const teamId    = process.env.APNS_TEAM_ID;
  const keyPath   = process.env.APNS_KEY_PATH;
  const bundleId  = process.env.APNS_BUNDLE_ID;
  if (!keyId || !teamId || !keyPath || !bundleId) return null;
  if (!fs.existsSync(keyPath)) {
    console.warn(`[APNs] Key file not found: ${keyPath}`);
    return null;
  }
  return {
    keyId,
    teamId,
    keyPath,
    bundleId,
    production: process.env.APNS_PRODUCTION === 'true',
  };
}

/**
 * Send a silent background push to an APNs device token.
 * Resolves when APNs accepts the request. Throws on rejection.
 */
export async function sendApns(
  config: ApnsConfig,
  token: string,
  topic: string,
): Promise<void> {
  const privateKey = fs.readFileSync(config.keyPath, 'utf-8');
  const jwt = generateApnsJwt(config.keyId, config.teamId, privateKey);

  const host = config.production ? APNS_HOST_PRODUCTION : APNS_HOST_SANDBOX;
  const session = getH2Session(host);

  return new Promise<void>((resolve, reject) => {
    const req = session.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      ':scheme': 'https',
      ':authority': host,
      'authorization': `bearer ${jwt}`,
      'apns-push-type': 'background',
      'apns-priority': '5',       // 5 = low priority, required for background
      'apns-topic': topic,
      'content-type': 'application/json',
    });

    const body = JSON.stringify({ aps: { 'content-available': 1 } });
    req.end(body);

    let statusCode = 0;
    let responseBody = '';

    req.on('response', (headers) => {
      statusCode = headers[':status'] as number;
    });

    req.on('data', (chunk: Buffer) => {
      responseBody += chunk.toString();
    });

    req.on('end', () => {
      if (statusCode === 200) {
        resolve();
      } else {
        reject(new Error(`APNs error ${statusCode}: ${responseBody}`));
      }
    });

    req.on('error', reject);
  });
}
