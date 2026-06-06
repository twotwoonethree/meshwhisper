// =============================================================================
// MeshWhisper · Linked Devices Example
//
// Demonstrates the Model-3 multi-device pairing flow end-to-end. Two roles:
//
//   - "Secondary": a fresh device with NO prior account. Inits the SDK with a
//     random keypair, mints a DeviceLinkOffer, shows it as text. When the
//     primary accepts, onDeviceLinked fires and we render success.
//
//   - "Primary":   an existing device. Pastes the secondary's offer, calls
//     acceptDeviceLinkOffer, which looks up the secondary's prekey bundle at
//     the relay, runs X3DH, sends the bootstrap payload (signed device_added
//     announcement + contact list), and broadcasts to other contacts.
//
// The whole demo is ~200 LOC. For a real product, the offer would be rendered
// as a QR code instead of text, but the SDK doesn't pick UI for you — the
// returned DeviceLinkOffer is just JSON.
//
// Try it locally:
//   npm install && npm run dev   (then open two tabs at the printed URL)
//
// Both tabs persist into separate IndexedDB databases (keyed by namespace),
// which means a single browser session simulates two independent devices.
// =============================================================================

import { MeshWhisper, IDBStorage } from '@meshwhisper/sdk/browser';
import type { DeviceLinkOffer } from '@meshwhisper/sdk';

const NAMESPACE_PRIMARY = 'com.example.linked-devices.primary';
const NAMESPACE_SECONDARY = 'com.example.linked-devices.secondary';
// IMPORTANT: in a real app primary and secondary use the SAME namespace.
// We diverge them here ONLY so the demo can run two roles in the same
// browser without colliding on IDB. To exercise a real cross-device link,
// open the secondary in one browser and the primary in another (same
// namespace), each pointing at the same relay.

// Default relay — override via ?node=wss://your.relay/
const params = new URLSearchParams(window.location.search);
const NODE = params.get('node') ?? 'wss://relay.meshwhisper.org';
// In single-browser demo mode (both roles in tabs of the same browser) we
// force a single shared namespace so the secondary's published bundle is
// reachable by the primary's lookup.
const SHARED_NS = params.get('ns') ?? 'com.example.linked-devices.demo';

const roleSelect = document.getElementById('role-select')!;
const appEl = document.getElementById('app')!;

roleSelect.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const role = target.dataset.role;
  if (role === 'primary') {
    void renderPrimary();
  } else if (role === 'secondary') {
    void renderSecondary();
  }
});

// ----- Helpers -----

function el<T extends keyof HTMLElementTagNameMap>(
  tag: T,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[T] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

function status(kind: 'ok' | 'err' | 'info', text: string): HTMLElement {
  const div = el('div', { class: `status ${kind}` }, text);
  return div;
}

// ----- Secondary role -----

async function renderSecondary(): Promise<void> {
  roleSelect.remove();
  appEl.innerHTML = '<h2>Secondary device · new install</h2>';
  appEl.appendChild(
    status('info', 'Initialising SDK with a fresh keypair…'),
  );

  // The SDK persists its keypair into IndexedDB. Clearing site data simulates
  // wiping the device — which would invalidate any prior link, by design.
  const sdk = await MeshWhisper.init({
    namespace: SHARED_NS,
    node: NODE,
    storage: new IDBStorage(`linked-devices-secondary-${SHARED_NS}`),
    onDeviceLinked: (accountPeerId, contactCount) => {
      const banner = status(
        'ok',
        `Linked to account ${accountPeerId.slice(0, 12)}… (imported ${contactCount} contacts).`,
      );
      appEl.appendChild(banner);
      appEl.appendChild(
        el(
          'p',
          { class: 'hint' },
          'This device is now part of the primary\'s account. In a real app you would now navigate to the main conversation list.',
        ),
      );
    },
  });

  appEl.appendChild(
    status('ok', `SDK ready. Our deviceKey is ${sdk.getLocalPeerId().slice(0, 12)}…`),
  );

  // Mint the offer. In a real app you'd render it as a QR.
  const offer = await MeshWhisper.createDeviceLinkOffer({ ttlMs: 5 * 60_000 });

  appEl.appendChild(el('h2', {}, 'Step 1 — show this offer to the primary'));
  const offerText = JSON.stringify(offer, null, 2);
  const pre = el('pre', {}, offerText);
  appEl.appendChild(pre);

  const copyBtn = el('button', {}, 'Copy offer');
  copyBtn.addEventListener('click', () => {
    void navigator.clipboard.writeText(offerText);
    copyBtn.textContent = 'Copied';
    setTimeout(() => { copyBtn.textContent = 'Copy offer'; }, 1200);
  });
  appEl.appendChild(copyBtn);

  appEl.appendChild(el('h2', {}, 'Step 2 — wait for the primary to accept'));
  appEl.appendChild(
    status(
      'info',
      `Offer expires in 5 minutes. Open this app's primary view in another tab/device and paste the offer there.`,
    ),
  );
}

// ----- Primary role -----

async function renderPrimary(): Promise<void> {
  roleSelect.remove();
  appEl.innerHTML = '<h2>Primary device · existing account</h2>';

  const sdk = await MeshWhisper.init({
    namespace: SHARED_NS,
    node: NODE,
    storage: new IDBStorage(`linked-devices-primary-${SHARED_NS}`),
  });
  appEl.appendChild(
    status('ok', `SDK ready. Our accountKey is ${sdk.getLocalPeerId().slice(0, 12)}…`),
  );

  appEl.appendChild(el('h2', {}, 'Paste the offer from the secondary device'));
  const textarea = el('textarea', {
    placeholder: 'Paste the DeviceLinkOffer JSON here…',
  }) as HTMLTextAreaElement;
  appEl.appendChild(textarea);

  const acceptBtn = el('button', {}, 'Accept link offer');
  appEl.appendChild(acceptBtn);
  const resultEl = el('div');
  appEl.appendChild(resultEl);

  acceptBtn.addEventListener('click', async () => {
    resultEl.innerHTML = '';
    let offer: DeviceLinkOffer;
    try {
      offer = JSON.parse(textarea.value);
    } catch {
      resultEl.appendChild(status('err', 'Could not parse the offer as JSON.'));
      return;
    }
    acceptBtn.setAttribute('disabled', 'true');
    acceptBtn.textContent = 'Accepting…';
    try {
      await MeshWhisper.acceptDeviceLinkOffer(offer);
      resultEl.appendChild(
        status(
          'ok',
          `Linked ${offer.deviceEdKey.slice(0, 12)}… as a device of our account. ` +
          `Switch to the secondary tab — it should now show "Linked to account…".`,
        ),
      );
      resultEl.appendChild(
        el(
          'p',
          { class: 'hint' },
          'Behind the scenes: looked up the secondary\'s prekey bundle, ran X3DH, signed a device_added announcement, sent the device_linked bootstrap payload (contact list + announcement) to the secondary, and (would) broadcast device_added to every other contact.',
        ),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      resultEl.appendChild(status('err', `Failed: ${msg}`));
    } finally {
      acceptBtn.removeAttribute('disabled');
      acceptBtn.textContent = 'Accept link offer';
    }
  });
}
