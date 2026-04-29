/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

self.addEventListener('push', (event) => {
  const data = event.data?.json() as { type?: string } | undefined;
  if (data?.type !== 'meshwhisper:wake') return;

  event.waitUntil(
    self.registration.showNotification('Prudence', {
      body: 'You have a new message',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'new-message',
    } as NotificationOptions)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ('focus' in client) return client.focus();
        }
        return self.clients.openWindow('/');
      }),
  );
});
