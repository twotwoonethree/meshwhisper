# @meshwhisper/service-worker

Web Push service worker for [MeshWhisper](https://github.com/twotwoonethree/meshwhisper) PWAs. Receives the content-free wake signal sent by [`@meshwhisper/push-service`](https://www.npmjs.com/package/@meshwhisper/push-service), shows a notification, and routes clicks back into your app — where the SDK pulls and decrypts the actual message.

## Install

```bash
npm install @meshwhisper/service-worker
cp node_modules/@meshwhisper/service-worker/dist/meshwhisper-sw.js public/
```

The worker must be served from your domain **root** (`https://myapp.com/meshwhisper-sw.js`). Register it and subscribe before initializing the SDK:

```ts
const registration = await navigator.serviceWorker.register('/meshwhisper-sw.js');
const subscription = await registration.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: vapidPublicKeyBytes,
});

await MeshWhisper.init({
  // ...
  push: { platform: 'webpush', subscription: subscription.toJSON() },
});
```

The full wiring is generated for you by `npx @meshwhisper/cli init` (browser/PWA option) and walked through in the [getting-started guide](https://github.com/twotwoonethree/meshwhisper/blob/main/docs/getting-started.md).

MIT
