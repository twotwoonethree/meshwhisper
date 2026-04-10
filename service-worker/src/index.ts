// ============================================================
// MeshWhisper Service Worker
// Handles Web Push wake events and routes them to open app
// windows, or shows a generic "new message" notification when
// the app is closed.
//
// Installation (in your app's service worker registration):
//   navigator.serviceWorker.register('/meshwhisper-sw.js');
//
// Or if you already have a service worker, import this inline:
//   import '@meshwhisper/service-worker';
//
// The SDK auto-registers the push subscription when you pass
// push: { platform: 'webpush', subscription } to MeshWhisper.init().
// ============================================================

declare const self: ServiceWorkerGlobalScope;

// ---- Push event ----
// The payload is { type: 'meshwhisper:wake', destHash }.
// E2EE content never passes through here — we just wake the app.

self.addEventListener('push', (event: PushEvent) => {
  let destHash = '';

  if (event.data) {
    try {
      const data = event.data.json() as { type?: string; destHash?: string };
      if (data.type === 'meshwhisper:wake' && data.destHash) {
        destHash = data.destHash;
      }
    } catch {
      // Malformed payload — still wake the app
    }
  }

  event.waitUntil(wakeApp(destHash));
});

async function wakeApp(destHash: string): Promise<void> {
  const clients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });

  if (clients.length > 0) {
    // App is open — tell it to pull new messages
    for (const client of clients) {
      client.postMessage({ type: 'meshwhisper:wake', destHash });
    }
    return;
  }

  // App is closed — show a generic notification so the user knows
  // to open the app. The actual message content is never shown here
  // because we can't decrypt it without the ratchet state.
  await self.registration.showNotification('New message', {
    body: 'Open the app to read your messages.',
    tag: 'meshwhisper-wake', // collapse multiple wakes into one notification
    renotify: false,
    silent: true, // silent — user will see it when they check their device
  });
}

// ---- Notification click ----
// Clicking the "New message" notification opens (or focuses) the app.

self.addEventListener('notificationclick', (event: NotificationClickEvent) => {
  event.notification.close();

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        const existing = clients.find((c) => c.url && 'focus' in c);
        if (existing) {
          return (existing as WindowClient).focus();
        }
        return self.clients.openWindow('/');
      }),
  );
});

// ---- Message from app ----
// The app can confirm wake receipt to cancel the fallback notification.

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  if ((event.data as { type?: string })?.type === 'meshwhisper:ack') {
    self.registration.getNotifications({ tag: 'meshwhisper-wake' }).then((notes) => {
      notes.forEach((n) => n.close());
    });
  }
});
