# linked-devices · MeshWhisper example

A focused tiny app demonstrating the **Model-3 multi-device pairing flow** from [`docs/multi-device.md`](../../docs/multi-device.md). About 200 lines of code total.

**What it shows:** how a "secondary" device with a fresh keypair gets linked into an existing user's "primary" account, sharing the contact list and a single account identity going forward. The protocol uses `createDeviceLinkOffer` / `acceptDeviceLinkOffer` / the `onDeviceLinked` callback.

**What it isn't:** this is not a messenger UI. It's a minimal scaffold to make the protocol calls visible and verify the link succeeds. For a real product you would:

- Render the `DeviceLinkOffer` as a QR code instead of as JSON text.
- Drive the camera with `BarcodeDetector` or a QR library.
- Persist a "linked, ready to chat" flag on the secondary and navigate to a real message view.

The SDK itself does none of those — they're app/UX choices.

## Roles

- **Secondary** — a brand-new device with no prior account. Inits the SDK with a random keypair, mints a `DeviceLinkOffer`, waits for the primary to accept.
- **Primary** — an existing device that already has an account. Pastes the offer, calls `acceptDeviceLinkOffer`, which establishes a ratchet session with the secondary and streams the bootstrap payload (signed `device_added` announcement + contact list).

After the exchange, both devices share an account: their `accountKey` is the primary's peerId, and each has its own `deviceKey`. Sends from a contact fan out to all known devices of the account (see phase C in [`docs/multi-device.md`](../../docs/multi-device.md)).

## Run locally

```sh
cd examples/linked-devices
npm install
npm run dev
```

Open the printed URL in **two browser tabs** (or in two different browsers on the same machine). Pick a role in each.

By default the app talks to `wss://relay.meshwhisper.org`. Override with `?node=` if you're running your own relay:

```
http://localhost:5180/?node=ws://localhost:8080
```

You can also override the demo namespace with `?ns=com.your.namespace` — useful if you want to test against a fresh namespace each time.

## Try the cross-device flow

To actually test "scan a QR with a phone":

1. Add QR rendering and scanning libraries (any of your choice — keep them as app dependencies, not SDK dependencies).
2. Deploy the build output to a server you can reach from your phone.
3. Use the secondary view from the phone, the primary view from the laptop.

The protocol is identical in both flows — JSON over QR is just a transport for the offer payload.

## SDK API surface

```ts
import { MeshWhisper, type DeviceLinkOffer } from '@meshwhisper/sdk';

// Secondary
const offer: DeviceLinkOffer = await MeshWhisper.createDeviceLinkOffer({
  ttlMs: 5 * 60_000, // default 5 minutes
});
// → render offer as QR / share / paste

await MeshWhisper.init({
  // ...
  onDeviceLinked: (accountPeerId, contactCount) => {
    // Fired on the secondary when the primary accepts.
  },
});

// Primary
await MeshWhisper.acceptDeviceLinkOffer(offer);
// → secondary's onDeviceLinked fires once the bootstrap payload arrives
```

## Limitations

- `pendingLinkOffer` is in-memory only on the secondary. Reloading the page invalidates an offer that hasn't been accepted yet.
- This example doesn't render a real message list — it just verifies the link.
- See "What's NOT in QR pairing v1" in [`docs/multi-device.md`](../../docs/multi-device.md) for protocol limitations (persistent LWW timestamps, per-device signing certificates).
