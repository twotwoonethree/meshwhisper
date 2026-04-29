export interface WebPushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

const VAPID_PUBLIC_KEY = 'BLIjtrdfBe11oWhj5yYHFocCLXjwEaOchx76yEXKSHu8e4BibAOpB0guTEIoszwz6aTeZfNtLfGJXwcFm1TFYlY';

function urlBase64ToUint8Array(base64: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const buf = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buf;
}

export async function getPushSubscription(): Promise<WebPushSubscription | null> {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    return null;
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return null;

  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const sub = existing ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  });

  const json = sub.toJSON();
  if (!json.keys?.p256dh || !json.keys?.auth) return null;

  return {
    endpoint: sub.endpoint,
    expirationTime: sub.expirationTime,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  };
}
