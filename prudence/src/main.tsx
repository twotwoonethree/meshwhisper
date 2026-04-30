import { Buffer } from 'buffer';
(globalThis as unknown as Record<string, unknown>).Buffer = Buffer;
(globalThis as unknown as Record<string, unknown>).process = { env: {}, versions: {}, platform: 'browser' };

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';

// Reload the page when a new service worker takes control so users always
// run the latest code without needing a manual second reload.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    window.location.reload();
  });

  // Aggressively poll for new versions. The default service-worker update
  // schedule is browser-dependent and can leave users on stale code for
  // hours or days. We force an update check whenever the tab becomes
  // visible and once a minute while visible. Combined with skipWaiting +
  // clientsClaim and the controllerchange handler above, a new deploy
  // typically activates within seconds of the user looking at the tab.
  navigator.serviceWorker.ready.then((registration) => {
    const checkForUpdate = () => {
      if (document.visibilityState === 'visible') {
        registration.update().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', checkForUpdate);
    window.addEventListener('focus', checkForUpdate);
    setInterval(checkForUpdate, 60_000);
    // First check immediately on boot.
    checkForUpdate();
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
