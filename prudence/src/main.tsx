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
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
