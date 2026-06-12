# P2P Transport — Opportunistic Direct Paths

**Status:** v1 draft — design specification, not yet scheduled for implementation. Written so that adopters (and we) know exactly what the device-to-device layer will look like before any of it is built, the same spec-before-implementation discipline used for [federation](federation.md). Implementation is demand-gated: see [ADR-004](adr/004-opportunistic-transport-upgrade.md) for the decision record and the triggers.

This document specifies how MeshWhisper clients establish direct device-to-device transport — LAN, proximity radio (Bluetooth/Multipeer/Nearby), and internet WebRTC — as an *opportunistic upgrade* over the always-available relay path.

---

## 1. The core requirement: relay-equivalent semantics

Everything in this spec is subordinate to one rule:

> **A direct path may only ever make delivery faster or cheaper. It must never make delivery less reliable, and its absence or failure must be invisible to the application.**

Concretely:

- The relay path remains permanently eligible for every message. Direct transports short-circuit it; they never replace it.
- Transport failure is silent. A blocked mDNS probe, a failed ICE negotiation, a dropped BLE link — none of these surface to the app. The message arrives via relay exactly as it would today.
- The developer-facing API is unchanged. `MeshWhisper.init({...})` with no new required fields. Apps that want to surface transport state get an optional callback (§7); everyone else never knows the layer exists.
- Receivers deduplicate (packet-ID `SeenPacketSet` + messageId), so senders may transmit on multiple bearers simultaneously without coordination.

This is progressive enhancement, transport edition: works where it can, silently doesn't where it can't.

## 2. What already exists

The SDK was built transport-agnostic from the start; much of this layer is wiring, not greenfield:

| Component | Location | State |
|---|---|---|
| Bearer abstraction (`platform_p2p` / `local_net` / `internet`) | `src/types.ts`, `src/transport/` | Implemented |
| `BearerNegotiator` — priority-ordered bearer selection, capability probing, payload fragmentation | `src/transport/negotiator/` | Implemented |
| `LocalTransport` — LAN bearer: UDP-broadcast discovery + framed TCP transfer | `src/transport/local/` | Implemented (Node.js only), instantiated by default |
| `PlatformP2PTransport` + `PlatformP2PBridge` — interface for native proximity modules (Multipeer/Nearby semantics) | `src/transport/p2p/` | Interface + transport shell implemented; **zero bridge implementations exist** |
| Receiver-side destHash matching | packet layer | Implemented — broadcast-to-all-LAN-peers is safe; only the intended recipient can match a packet |
| Browser bearers | `src/sdk/index.ts` init | `NoOpTransport` for `local_net`/`internet` direct — **no WebRTC exists** |
| Client mesh-relay logic (`SocialGraphRouter`, `RelayLedger`, sybil checks) | `src/routing/`, `src/sdk/` | Implemented but gated off for the `internet` bearer ([ADR-002](adr/002-relay-first-not-p2p-first.md)) |

What does not exist: WebRTC (any environment), any native proximity bridge (Swift/Kotlin), contact-recognizable beacons (§5), delivery-confirmed relay suppression (§6), and tests/examples for the LAN bearer.

**One precise gap in the LAN bearer, found by tracing the send path:** discovery, TCP connection, and the receive path all work — and chaff is genuinely broadcast across LAN links today — but *real messages never traverse them*. `routeAndSend` addresses the negotiator by peerId, while LAN connections are keyed by the anonymous per-session device ID, with (correctly) no mapping between the two. The send always misses and falls through to the relay. The fix is the §6 dual-send model: also broadcast outbound packets to connected LAN peers and let receiver-side destHash matching deliver them — identical to how chaff already flows. Phase 1 is this wiring plus tests, not just verification.

## 3. Transport tiers and the privacy rule

Direct connections have different privacy costs depending on what they reveal and to whom. The tiering rule:

> **Proximity with anyone. Internet directly with contacts only (app-configurable). Strangers via relay, always.**

| Tier | Bearer | Who may connect | What the peer learns | Why that's acceptable |
|---|---|---|---|---|
| LAN | `local_net` | any MeshWhisper device on the subnet | link-local address, device presence | they're on your network already |
| Proximity radio | `platform_p2p` | any device in radio range | hardware-level presence | they're physically in the room |
| Internet direct (WebRTC) | `internet` (direct) | **established contacts only**, and only if the app enables it | your public IP ≈ coarse location | bounded (first hop only), consented (contact + app policy) |
| Internet, strangers | relay | n/a | nothing — relay mediates | no new exposure taken |

The IP-exposure property of direct paths is strictly first-hop: a peer you connect to learns your address; nobody beyond that connection does. In any future multi-hop scheme each node learns only its adjacent neighbors.

Apps whose threat model includes the user's own contacts (e.g. serving abuse survivors) keep internet-direct disabled — that is the default.

## 4. Discovery: per-platform constraints

Discovery is the hard 80% of this layer. The constraints that shape the design:

- **LAN (mDNS / UDP broadcast):** works for Node/desktop. Fails silently on networks with AP/client isolation (cafés, hotels, offices) — which the design must treat as the common case, not the exception. Browsers cannot do LAN discovery at all; no API exists. iOS requires the Local Network permission prompt.
- **BLE:** the only cross-platform ambient radio, and the most constrained. ~31-byte legacy advertising payload (service UUID + almost nothing); real exchange requires a GATT connection. iOS background advertising is intentionally crippled (overflow-area UUIDs visible only to foregrounded iOS scanners) — two backgrounded iPhones will effectively never find each other. Android throttles scanning and vendors kill background processes. Browsers: Web Bluetooth needs a user gesture per device and cannot advertise — unusable for ambient discovery. Post-connection throughput ~10–50 KB/s: fine for messages, hand off to Wi-Fi for media.
- **Platform frameworks:** Multipeer Connectivity (iOS↔iOS) and Nearby Connections (Android↔Android) are each good foregrounded — and mutually invisible. **iOS↔Android ambient discovery has no vendor path**; it requires a custom raw-BLE protocol carrying every constraint above at once (the Briar/Bridgefy swamp), or "both join the same Wi-Fi."
- **Browsers:** can hold direct connections (WebRTC, including LAN host candidates) but can never *discover*. Introductions must come from the relay (already a connected WebSocket hub on both ends — it is the signaling channel) or a QR code for fully-offline pairing.

Design consequence: every discovery mechanism is a *probe that is expected to fail*, and the failure handling is "do nothing."

## 5. Identity and beacons

Discovering a device must not deanonymize a person. Rules:

1. **Never beacon a peerId** or any stable identifier. A persistent broadcast identifier is a tracking beacon for anyone in radio range.
2. **Generic presence beacons are acceptable for the proximity tiers.** The existing `LocalTransport` announcement (magic + random per-session 16-byte device ID + port) is the model: it reveals "a MeshWhisper-capable device is here," nothing more. Routing privacy comes from receiver-side destHash matching — packets are offered to everyone, only the addressee can recognize theirs. The residual leak ("that device runs a MeshWhisper app") is mitigated by per-session random IDs and, where the radio allows, namespace-generic service IDs.
3. **Contact-recognizable beacons** (future, for selective discovery): advertise `H(pairwise_secret, epoch)` per contact — each of your contacts can compute the expected value and recognize you; observers cannot link beacons across epochs. Structurally identical to the existing destHash epoch scheme. Required only when a transport can't afford promiscuous packet-offering (BLE's tiny payloads); the LAN bearer doesn't need it.
4. A separate generic **"forwarder" capability beacon** (the `PeerInfo.capabilities` field, already in the bridge interface) advertises relay willingness without identity, preserving the relay-promiscuous role for strangers.

## 6. Send strategy

- **v1: dual-send.** When a live direct link to the recipient exists, send on it *and* on the relay path. Receiver dedup makes this safe; the cost is duplicate bytes. No new failure modes, no confirmation protocol — ship this first.
- **v2: confirm-then-suppress.** After N consecutive direct deliveries to a peer (acknowledged at the message layer, which already exists via delivery receipts), suppress the relay copy for that peer while the link stays live; resume dual-send on the first timeout. The relay store-and-forward path also remains the offline queue — direct links only ever serve currently-reachable peers.
- Chaff continues to flow on the relay path regardless, so suppression does not turn traffic-shape into a signal for the relay operator.

## 7. API surface

```ts
await MeshWhisper.init({
  namespace: 'com.example.app',
  node: 'wss://relay.example.com',
  // All optional. Defaults shown.
  transports: {
    lan: true,          // local_net bearer (no permissions involved)
    webrtcDirect: false, // internet direct paths with established contacts
    proximity: false,    // native BLE/Multipeer/Nearby bridges (OS permission prompts)
  },
  onTransportUpgrade: (peerId, bearer) => {
    // 'local_net' | 'platform_p2p' | 'internet-direct' | 'relay'
    // purely informational — show a ⚡ if you like
  },
});
```

- `lan` defaults on: it requires no permissions and no user-visible behavior.
- `proximity` defaults off because enabling it triggers OS permission dialogs (Local Network on iOS, Bluetooth/Nearby on Android) — the app decides when to ask, the SDK never springs a prompt.
- `webrtcDirect` defaults off pending the privacy default discussion in §3.
- Native apps provide proximity via the existing `registerPlatformBridge(bridge)` with a Swift/Kotlin implementation of `PlatformP2PBridge`.

## 8. WebRTC design sketch (browser/Node internet-direct)

- **Signaling:** the relay. Both peers already hold authenticated WebSockets to it; SDP offers/answers and ICE candidates travel as a new client-protocol message type, opaque to operators beyond "these two clients exchanged signaling." Only fires between established contacts (an existing ratchet session is the authorization).
- **Traversal:** ICE with host candidates (covers same-LAN browsers — this is how browsers get LAN-direct despite having no discovery) + STUN. **No TURN**: a TURN server is a relay with extra steps; when ICE fails, the actual relay is the fallback.
- **Security:** the DataChannel carries the same ratchet-encrypted packets as every other bearer. DTLS adds nothing we rely on; compromise of the direct link reveals exactly what relay compromise reveals — ciphertext and traffic timing. No transport is ever trusted.

## 9. Phases and triggers

| Phase | Scope | Effort | Trigger |
|---|---|---|---|
| 1 | Wire real-message delivery over the LAN bearer (dual-send broadcast — today only chaff traverses LAN links, see §2) + tests; `examples/local-first/` proving two devices messaging with the relay down; `onTransportUpgrade` | small | mostly built — finish it when an offline/local-first adopter use case appears |
| 2 | WebRTC direct paths (relay signaling, contacts-only, opt-in) | ~3–4 weeks | adopter pain on media bandwidth/latency, or a privacy-marketing need for "your messages can bypass even the relay" |
| 3 | Native proximity bridges (Multipeer, Nearby; Swift/Kotlin) | months | an adopter shipping a native app that needs offline proximity messaging — do not build speculatively; carries App Store review risk (see ADR-001 §risks) |
| 4 | Multi-hop device routing (activate `SocialGraphRouter` across direct links) | large | meaningful density of Phase 1–3 devices in real deployments |

## 10. Security considerations

- **No confidentiality or authenticity claims are delegated to any transport.** Every bearer carries ratchet-encrypted packets; a malicious LAN peer, BLE peer, or WebRTC peer sees ciphertext and learns presence + traffic timing, the same as a malicious relay.
- **IP exposure** is governed by the tiering rule (§3) and is first-hop-bounded.
- **Beacon tracking** is governed by §5: per-session random identifiers, no stable broadcast IDs, contact-recognizable beacons where selectivity is needed.
- **DoS on direct listeners** (LAN TCP port, GATT): per-peer rate limits and connection caps mirroring the relay's federation protections; a misbehaving direct peer is dropped and the relay path continues unaffected.
- **Dual-send and metadata:** sending on two paths reveals to the relay that the sender is online at the same moments a LAN peer sees it — no new linkage beyond what each party already observes.

## 11. Open questions

- Should `webrtcDirect` ever default on once contact-consent semantics are settled, or is opt-in permanent?
- LAN beacon namespace scoping: per-namespace service IDs improve isolation but worsen fingerprinting ("which app"); a protocol-generic beacon reveals less per device. Current implementation is protocol-generic; revisit with real adopter input.
- Battery/relay-willingness signals in `DeviceCapability` are currently static defaults; Phase 4 needs them real.
