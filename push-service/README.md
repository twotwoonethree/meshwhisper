# @meshwhisper/push-service

Push-notification dispatcher for [MeshWhisper](https://github.com/twotwoonethree/meshwhisper). When a message arrives at a `@meshwhisper/node` for an offline device, the node calls this service's webhook and it fires a **silent, content-free wake signal** via Web Push (VAPID), APNs, or FCM. The device wakes, the SDK pulls the encrypted blobs, the app displays the message. No message content ever touches the push provider.

## Run

```bash
npm install -g @meshwhisper/push-service
PUSH_PORT=4000 VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com meshwhisper-push
```

Point your node at it: `PUSH_WEBHOOK_URL=http://localhost:4000/notify`.

`npx @meshwhisper/cli init` scaffolds this as a Compose service with generated VAPID keys — you rarely need to set it up by hand.

## Environment

| Variable | Purpose |
|---|---|
| `PUSH_PORT` | Listen port (default 4000) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web Push (generate with `npx @meshwhisper/cli vapid`) |
| `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_KEY_PATH` / `APNS_BUNDLE_ID` | iOS (optional) |
| `FCM_SERVICE_ACCOUNT_PATH` / `FCM_PROJECT_ID` | Android (optional) |

Push tokens are the most sensitive metadata in a MeshWhisper deployment — this service is the only component that holds them, and you run it yourself.

MIT
