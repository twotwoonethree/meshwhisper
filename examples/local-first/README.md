# local-first — on-site comms that survive losing the relay

**The pattern this example teaches:** messaging on an internal network — a factory floor, a ship, a clinic, an air-gapped office — where conversations keep working even when the relay (or the entire internet) is unreachable. Covers both **human chat** and **machine-to-machine telemetry**.

How it works: the SDK's LAN bearer discovers peers on the subnet (UDP broadcast) and connects them directly (TCP). Every outbound message is *dual-sent* — offered to connected LAN peers and sent via the relay — and receivers deduplicate. When the relay is up, you get store-and-forward for offline devices. When it's down, established conversations continue peer-to-peer, end-to-end encrypted, with zero infrastructure. See [docs/p2p-transport.md](../../docs/p2p-transport.md).

The one thing that needs a relay is **first contact**: looking up a username means querying the relay's prekey directory. Pair peers while a relay is reachable (a `meshwhisper-node` on any box on the LAN works — no internet required); after that, the relay is optional.

## Run it — human chat

```bash
npm install

# 1. A relay somewhere reachable — local is fine:
npx @meshwhisper/node          # ws://localhost:8080

# 2. Two peers (two terminals; --lan-port only needed on the same machine):
npx tsx src/chat.ts alice --lan-port 19401
npx tsx src/chat.ts bob   --lan-port 19402

# 3. In alice:  /add @bob   — then chat both ways.

# 4. Now kill the relay (Ctrl-C in terminal 1). Both peers print
#    [relay down — LAN-only mode]. Keep typing — messages still arrive,
#    marked "(peer-to-peer — no relay)".
```

## Run it — machine-to-machine

```bash
npx @meshwhisper/node                                  # relay for pairing
npx tsx src/monitor.ts monitor --lan-port 19404        # the receiving side
npx tsx src/sensor.ts pump-7 @monitor --lan-port 19403 # an emitting machine
npx tsx src/sensor.ts valve-2 @monitor --lan-port 19405  # add as many as you like

# Once you see readings flowing, kill the relay. They keep coming — the
# monitor's log switches from "(relay/lan)" to "(lan only)".
```

The sensors are stand-ins for anything on-site that talks: PLCs, robots, kiosks, badge readers, LLM agents. Each is a full MeshWhisper peer — its telemetry is end-to-end encrypted, so even the relay you used for pairing never saw a reading.

## Why this matters

- **No cloud dependency for the conversation path.** The relay is bootstrap + offline queueing, not a chokepoint. On an isolated network you can run the relay on-site too — then *nothing* leaves the building.
- **Privacy is structural on the LAN as well**: packets are offered to every LAN peer, but routing uses unlinkable destination hashes and the payload is ratchet ciphertext — a device on the network learns presence, not who is talking to whom about what.
- **Degradation is silent and automatic.** No mode switch, no reconfiguration. The app code in `chat.ts` doesn't handle "offline mode" — it just sends.

## Notes

- The LAN bearer is Node.js-only today (browsers can't do LAN discovery — see the [transport spec](../../docs/p2p-transport.md) for the WebRTC path).
- `--lan-port` overrides the TCP data port so several peers can share one machine for the demo. On separate devices, omit it.
- Store-and-forward needs the relay: a message sent while the *recipient* is offline waits at the relay, not at LAN peers. LAN delivery serves peers that are currently up.
