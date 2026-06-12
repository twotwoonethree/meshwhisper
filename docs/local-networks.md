# MeshWhisper on Isolated Networks

End-to-end encrypted messaging on a network that never touches the internet — a factory floor, a ship, a hospital wing, a mine site, a defense network, an air-gapped office. This page covers the two deployment shapes and what each one gives you.

Most hosted messaging products structurally cannot do this: they are clients for someone else's cloud. MeshWhisper's relay is a process you run, and the SDK's LAN bearer doesn't need a relay at all once peers know each other.

## Shape 1 — A node on the local network (full features, works today)

Run `meshwhisper-node` on any box on the network. It needs no internet access, no domain, no TLS certificate authority — it's just a process listening on a port:

```bash
# On any machine on the LAN (a Raspberry Pi is plenty):
npm install -g @meshwhisper/node
BASE_URL=http://192.168.1.50:8080 DB_PATH=/var/lib/meshwhisper.db meshwhisper-node
```

Clients connect to `ws://192.168.1.50:8080`. You get everything a cloud deployment gets: store-and-forward for offline devices, the username directory for first contact, encrypted media, encrypted archives, group messaging. Content is end-to-end encrypted, so even your own on-site node can't read it.

For TLS on an isolated network (recommended if the network has untrusted devices), use an internal CA or a self-signed certificate with your reverse proxy — the SDK speaks `wss://` to whatever you give it.

This is the shape to start with: it is ordinary self-hosting (see [self-hosting.md](self-hosting.md)) minus the public-internet steps.

## Shape 2 — Peer-to-peer over the LAN (no node in the conversation path)

The SDK's LAN bearer ([p2p-transport.md](p2p-transport.md)) discovers peers on the subnet via UDP broadcast and connects them directly over TCP. Every outbound message is **dual-sent** — offered to connected LAN peers *and* sent via the relay — and receivers deduplicate. The consequence:

> Once two peers have established a session, their conversation no longer depends on any infrastructure. Kill the node, unplug the router — if the devices can reach each other on the subnet, messages keep flowing, end-to-end encrypted.

What still needs a node, and when:

| Operation | Needs a node? |
|---|---|
| First contact (username lookup → prekey bundle → X3DH) | Yes — pair while a node is reachable (the Shape-1 on-site node is fine) |
| Messaging between established contacts, both online | No |
| Delivery to a peer that is currently offline | Yes — store-and-forward queues at the node, not at LAN peers |
| Media beyond LAN-frame sizes, archives, push | Yes |

So the practical pattern is **Shape 1 + Shape 2 together**: an on-site node for bootstrap and offline queueing, with live conversations flowing peer-to-peer and surviving any node outage automatically. There is no mode switch — degradation and recovery are silent (`docs/p2p-transport.md` §1).

The LAN bearer is enabled by default in Node.js environments and needs no permissions or configuration. Disable or tune it via `transports: { lan: ... }` in `MeshWhisper.init`. Browsers cannot do LAN discovery (no API exists); browser peers always need the node — see the transport spec for the WebRTC path.

## Machine-to-machine

Nothing about a MeshWhisper peer assumes a human. On-site machines — PLCs, robots, kiosks, sensors, badge readers, LLM agents — can each run a peer and exchange encrypted traffic with each other or with monitoring stations, with the same survive-the-node-outage property. The [local-first example](../examples/local-first/) demonstrates both shapes: a human chat and a sensor fleet emitting encrypted telemetry that keeps arriving after the relay is killed.

Things that make M2M deployments pleasant:

- **Identity is just a keypair** — provision each machine with a username (`pump-7`, `agv-12`) at install time; no account system, no certificate infrastructure to operate.
- **The directory is your inventory**: machines find each other by `@name` through the on-site node once, then talk directly.
- **Compliance/monitoring hooks**: the SDK's `onBeforeSend`/`onAfterReceive` patterns (see [supervised-chat](../examples/supervised-chat/)) apply to machine traffic the same as human traffic.

## Privacy properties on a LAN

LAN delivery is promiscuous by design: packets are offered to every connected LAN peer, and only the addressee can recognize theirs (unlinkable destination hashes; ratchet-encrypted payloads). A device on your network learns *that MeshWhisper devices are present* and sees ciphertext volume — it does not learn who is talking to whom, or about what. Discovery beacons use random per-session identifiers, so devices aren't trackable across restarts.

## Quick demo

```bash
cd examples/local-first && npm install
npx @meshwhisper/node                                # terminal 1 — pairing relay
npx tsx src/chat.ts alice --lan-port 19401           # terminal 2
npx tsx src/chat.ts bob   --lan-port 19402           # terminal 3 — /add @alice, chat
# now Ctrl-C terminal 1 and keep typing
```
