// ============================================================
// FCM v1 API dispatch (Firebase Cloud Messaging)
//
// Required env vars:
//   FCM_SERVICE_ACCOUNT_PATH — path to the Firebase service account JSON file
//   FCM_PROJECT_ID           — Firebase project ID (also in the service account file)
// ============================================================

import * as fs from 'node:fs';
import * as https from 'node:https';
import { GoogleAuth } from 'google-auth-library';

const FCM_ENDPOINT = 'https://fcm.googleapis.com/v1/projects';

export interface FcmConfig {
  projectId: string;
  auth: GoogleAuth;
}

export function loadFcmConfig(): FcmConfig | null {
  const serviceAccountPath = process.env.FCM_SERVICE_ACCOUNT_PATH;
  const projectId = process.env.FCM_PROJECT_ID;
  if (!serviceAccountPath || !projectId) return null;
  if (!fs.existsSync(serviceAccountPath)) {
    console.warn(`[FCM] Service account file not found: ${serviceAccountPath}`);
    return null;
  }
  const auth = new GoogleAuth({
    keyFile: serviceAccountPath,
    scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
  });
  return { projectId, auth };
}

/**
 * Send a silent data-only push to an FCM registration token.
 * Resolves when FCM accepts the request. Throws on rejection.
 */
export async function sendFcm(
  config: FcmConfig,
  token: string,
): Promise<void> {
  const accessToken = await config.auth.getAccessToken();
  if (!accessToken) throw new Error('FCM: failed to obtain access token');

  const url = `${FCM_ENDPOINT}/${config.projectId}/messages:send`;
  const payload = JSON.stringify({
    message: {
      token,
      // Data-only message — no notification key means no visible alert
      data: { source: 'meshwhisper' },
      android: { priority: 'normal' },
      apns: {
        headers: { 'apns-priority': '5' },
        payload: { aps: { 'content-available': 1 } },
      },
    },
  });

  return new Promise<void>((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          reject(new Error(`FCM error ${res.statusCode}: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
