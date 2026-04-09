# Product Requirements Document
## MeshWhisper: Serverless P2P E2EE Messaging SDK

**Version:** 1.0  
**Authors:** Kevin (Build) / Anton (Concept & Architecture)  
**Date:** April 2026  
**Status:** Draft  
**Foundation:** MeshWhisper Foundation, Ireland  
**Commercial Entity:** GestureLoop Ltd  

---

## 1. Executive Summary

MeshWhisper is an open-source, serverless Peer-to-Peer (P2P) End-to-End Encrypted (E2EE) messaging protocol, delivered as a plug-and-play SDK for mobile and web developers.

The core proposition: any developer who embeds the SDK into their app gets free, secure, real-time messaging for their users forever, with zero server infrastructure to manage. In return, their users' devices contribute to a global, decentralized relay mesh that makes the network stronger for everyone. The more apps that adopt it, the better it works for all of them.

MeshWhisper is not a consumer app. It is infrastructure — a layer that sits beneath any application, from a fitness tracker to a football coaching tool, and provides messaging as a utility. It handles all transport, routing, encryption, and offline delivery transparently, leaving the developer to focus only on their product.

The protocol's defining principle, articulated by Anton:

> "Relay promiscuously, connect selectively."

Every device running the SDK — regardless of which app embedded it — participates in the global relay mesh. Devices forward encrypted packets they cannot read for other apps, but only decrypt and surface messages belonging to their own application namespace. All other packets are relayed silently and ephemerally, never stored to disk.

---

## 2. Problem Statement

### 2.1. The Developer Messaging Problem

Adding real-time messaging to an application is disproportionately difficult and expensive. Developers face a trilemma:

**Option A — Build it yourself.** WebSocket servers are painful to build, scale, and maintain. Most small teams simply skip messaging entirely because of this burden.

**Option B — Pay for a managed service.** Sendbird starts at $349/month. PubNub charges from $98/month per 1,000 MAUs. Stream Chat begins at $119/month. These costs scale aggressively and become prohibitive for indie developers and small startups.

**Option C — Use a general-purpose platform.** Firebase Realtime Database is free at small scale but introduces vendor lock-in, complex pricing at scale, and centralizes user data in a way that creates compliance and security liability.

The result is that many apps that *want* messaging simply do not have it, or they push users to WhatsApp — a fragmented, privacy-hostile workaround.

### 2.2. The Opportunity

There is no open, embeddable, serverless messaging protocol that a developer can drop into any app in under 10 lines of code. The closest prior art — Meshtastic, Bitchat, Nostr, Ditto — are either consumer apps, hardware-specific, commercially licensed, or not designed as embeddable SDKs for arbitrary applications. This gap is the opportunity.

---

## 3. Vision & Goals

MeshWhisper's vision: **free, secure, resilient messaging for every app, forever, with no servers.**

| Goal | Description |
| :--- | :--- |
| **Zero Infrastructure** | No developer should ever need to provision, pay for, or maintain a messaging server. The network is the collective behaviour of devices running the SDK. |
| **10-Line Integration** | The SDK must be embeddable in any app with a minimal, clean API. Complexity lives inside the library, not in the developer's code. |
| **True E2EE** | No relay node, including the developers of this protocol, can ever read a message payload or identify who is communicating with whom. |
| **Invisible to Users** | A person using a fitness app with MeshWhisper embedded should never know they're on a mesh network. The experience should feel identical to any other in-app chat. |
| **Offline Resilience** | Messages must be deliverable even when the internet is unavailable, using platform-native P2P transports. |
| **Network Effects** | Every new app that adopts the SDK makes the relay mesh denser and more reliable for every other app. |
| **Endpoint Neutrality** | The protocol governs transport only. What happens at the endpoint — logging, moderation, compliance — is the app developer's decision. The protocol has no opinion. |
| **Open Source** | The protocol specification and SDK are fully open source. The business model is Red Hat-style: open core, paid support and enterprise tooling. |

---

## 4. Core Architecture

### 4.1. The Four-Layer Model

The protocol operates across four distinct, independently replaceable layers:

```
┌─────────────────────────────────────────────┐
│  APPLICATION LAYER                          │
│  App-specific logic, UI, permissions,       │
│  content moderation, compliance hooks       │
├─────────────────────────────────────────────┤
│  SESSION LAYER                              │
│  Namespace isolation, contact permissioning,│
│  conversation management, key exchange      │
├─────────────────────────────────────────────┤
│  ROUTING LAYER                              │
│  Social-graph routing, relay selection,     │
│  store-and-forward, reciprocity engine      │
├─────────────────────────────────────────────┤
│  TRANSPORT LAYER                            │
│  Platform-native P2P, local network,        │
│  internet (WebSocket/QUIC over port 443)    │
└─────────────────────────────────────────────┘
```

Each layer is independent. A developer integrating the SDK interacts only with the Application and Session layers. The Routing and Transport layers are fully autonomous.

### 4.2. Namespace Isolation

Each app integrating the SDK registers a **namespace** — a 256-bit cryptographic identifier derived from:

```
namespace_id = BLAKE3(app_bundle_id || developer_public_key || salt)
```

All session-layer operations are scoped to a namespace. A user in Namespace A cannot discover, contact, or receive messages from a user in Namespace B.

**Critical: transport-layer relaying is namespace-blind.** A device relays encrypted blobs without knowing or checking which namespace they belong to. This is what allows the shared mesh to work across apps — namespace blind at the messaging layer, namespace isolated at the application layer.

### 4.3. Destination Hashing

To prevent metadata leakage, recipient addresses are never transmitted in cleartext. Each message carries a **destination hash**:

```
dest_hash = BLAKE3(recipient_public_key || epoch_hour)
```

The hash rotates every hour (keyed to the current epoch hour). A device recognises messages intended for it by computing its own destination hash for the current and previous epoch hours and comparing against incoming traffic. External observers cannot correlate destination hashes across time periods.

---

## 5. Transport Layer

### 5.1. Core Philosophy: Stateless and Ephemeral

The protocol is architecturally the opposite of blockchain. There is no ledger, no chain, no accumulating state. A message is an encrypted blob that exists temporarily on relay devices, gets delivered, and disappears. No device permanently stores anything that isn't its own messages. The network is a transient medium — messages flow through it like sound through air. The air doesn't remember what was said.

This is what makes the protocol scale. Bitcoin gets slower as it grows because everyone processes everything. MeshWhisper gets *better* as it grows because mesh density increases, relay paths multiply, and delivery latency drops — while each individual device's workload stays flat. Each device only handles traffic for people near it in the social topology, not for the entire network.

### 5.2. Multi-Bearer Transport

The transport layer is bearer-agnostic. It selects the best available channel automatically, in order of preference:

1. **Direct local connection** — Platform-native P2P (Apple Multipeer Connectivity on iOS, Google Nearby Connections API on Android). These frameworks use BLE for discovery and Wi-Fi for data transfer under the hood, but are fully sanctioned by both platforms. App-store approved, background-capable with proper entitlements, and maintained by the platform vendors themselves. Used when both peers are nearby and running the same app.

2. **Local network** — Standard sockets on the same subnet. Used for device self-clustering (phone to laptop in the same home) and for peers discoverable on the local network.

3. **Internet — WebSocket over HTTPS (port 443)** — The primary transport for most messages. Every NAT, firewall, carrier network, and corporate proxy on earth passes HTTPS on port 443. No NAT traversal, no hole-punching, no STUN, no TURN. The protocol uses the front door, not a side window. Devices that can accept inbound connections (laptops on broadband, desktops, home devices) advertise this capability. Devices that can't (most phones on cellular) maintain outbound WebSocket connections to connectable peers in their social graph. Messages route from non-connectable devices through connectable ones.

4. **Hybrid** — Large messages fragment across bearers. A photo might begin transferring over local P2P when devices are proximate and complete over internet when connectivity returns.

### 5.3. Bearer Negotiation

On initialisation, the SDK probes available bearers and registers capabilities:

```
Device Capability Advertisement:
  - bearer_platform_p2p: true/false    // Multipeer / Nearby Connections
  - bearer_local_net: true/false
  - bearer_internet: true/false
  - inbound_connectable: true/false    // can accept incoming WebSocket
  - battery_state: [charging | high | medium | low | critical]
  - relay_willingness: [eager | willing | reluctant | unavailable]
```

`relay_willingness` is computed from battery state, current bearer, and the device's reciprocity balance (see §7.3). A device on a charger with Wi-Fi defaults to `eager`. A device at 10% on cellular defaults to `unavailable`.

### 5.4. Platform-Native P2P Specifics

**iOS — Multipeer Connectivity Framework.** Apple's official API for peer-to-peer communication between nearby devices. Uses BLE for discovery and Wi-Fi Direct for data transfer. Works in the background with proper entitlements. AirDrop is built on it. Every app using it sails through App Store review because Apple designed and encourages its use.

**Android — Nearby Connections API.** Google's equivalent, part of Google Play Services. Wraps Wi-Fi Aware (Neighbor Awareness Networking) into a clean interface that works across Bluetooth and Wi-Fi automatically, choosing the best available channel.

**Limitation:** Platform-native P2P is scoped to the same app (or shared service identifier). A fitness app's users cannot relay for a marketplace app's users through these APIs. Cross-app relay only occurs over the internet-based mesh. This means the offline mesh is same-app and local, while the online mesh is cross-app and global.

### 5.5. Connectable vs. Non-Connectable Devices

The internet transport avoids all NAT traversal complexity by using a simple principle: connections flow outward from non-connectable devices toward connectable ones.

**Connectable devices** are those that can accept inbound WebSocket connections on port 443 — typically laptops on home broadband, desktops, dedicated home relay nodes, or any device behind a router with UPnP/NAT-PMP or manual port forwarding. The SDK automatically detects connectability by attempting to open a listening socket and verifying reachability.

**Non-connectable devices** (most phones on cellular) maintain persistent outbound WebSocket connections to connectable peers in their social graph. These connections serve as message delivery channels in both directions — the outbound connection is bidirectional once established.

This mirrors how WhatsApp works, decentralised. WhatsApp works because your phone maintains a persistent outbound connection to WhatsApp's servers, which bridge two clients. MeshWhisper does the same thing, but the "server" is another user's device that happens to have a connectable network position.

### 5.6. Device Self-Clustering

When a user has multiple devices (phone, tablet, laptop), they form a **personal availability cluster**:

1. Devices are linked via a shared cluster key derived from the user's identity key.
2. Clustered devices maintain persistent connections to each other when on shared networks.
3. Any device in the cluster can accept messages on behalf of the user.
4. The device most "available" (best battery, strongest connectivity, relay willingness = eager) becomes the cluster's **primary receiver**.
5. Messages received by any cluster member are synchronised to all others when connectivity allows.

**Practical effect:** Your laptop plugged in at home acts as your personal always-on relay node. Your phone can sleep. When you pick up your phone, messages sync from the laptop instantly over local network.

### 5.7. Sideloaded Variant for Raw BLE

For specific use cases — protest communications, disaster response, environments with no internet infrastructure — a dedicated sideloaded app can be built on the same protocol with raw BLE mesh enabled. This variant operates outside app store distribution (Android sideloading, EU DMA-mandated sideloading on iOS, alternative ROMs like GrapheneOS/CalyxOS).

The sideloaded variant participates in the same mesh as all mainstream SDK-embedded apps. Messages destined for a sideloaded app user travel through the internet-based relay network — bouncing through fitness apps, marketplace apps, gaming apps — until they reach a device physically near the recipient. The sideloaded app handles the final BLE hop.

The mainstream apps do 99% of the delivery work using sanctioned internet relay. The sideloaded app only needs raw BLE for the last metre. Every commercial app using the SDK unknowingly provides relay infrastructure. This works because relay is namespace-blind and transport-agnostic — relayed blobs are opaque.

---

## 6. Session Layer

### 6.1. Key Generation

Each user generates a long-term identity keypair on first launch using **X25519** (Curve25519). The private key never leaves the device. The public key serves as the user's identity within the protocol.

### 6.2. Key Exchange (X3DH)

Peer-to-peer key exchange uses the **X3DH protocol** (Extended Triple Diffie-Hellman), the same foundation as Signal's key exchange, adapted for decentralised operation.

X3DH provides:
- **Mutual authentication** — both parties prove they hold their private keys.
- **Forward secrecy** — compromise of long-term keys does not expose past sessions.
- **Deniability** — messages cannot be cryptographically attributed to a sender after the fact.

**The serverless prekey problem:** X3DH typically requires a server to host prekey bundles. In MeshWhisper, prekey bundles are distributed through the mesh itself. When a user installs an app using the SDK, their device generates a prekey bundle and gossips it to their social graph (contacts, group members). Each contact's device caches prekey bundles for known peers.

First-contact messaging between strangers requires an introduction through a mutual connection or a brief synchronous exchange (QR code scan, NFC tap, or shared link).

### 6.3. Message Encryption (Double Ratchet)

Once X3DH establishes a shared secret, all subsequent messages use the **Double Ratchet algorithm** for forward secrecy and post-compromise security. Each message uses a unique key derived from the ratchet; compromising one message key reveals nothing about past or future messages.

### 6.4. Contact Permissioning

The SDK exposes a permissioning API that the app developer configures:

```
PermissionModel:
  - open: any user in the namespace can initiate contact
  - mutual: both users must add each other before messaging
  - introduction: a mutual contact must broker first contact
  - transactional: contact permitted only after an app-defined 
    event (purchase, match, group membership, etc.)
  - custom: developer-defined callback function
```

The permissioning logic executes at the endpoint. The protocol delivers the message attempt; the receiving device's SDK checks permissions before surfacing it to the app.

---

## 7. Routing Layer

### 7.1. Social Graph Routing

This is the protocol's core routing innovation. Traditional P2P networks use distributed hash tables (DHTs) or flooding for message routing. Both are inefficient and battery-hungry. MeshWhisper uses the social graph as a routing topology.

Each device maintains a **peer proximity table** — not geographic proximity, but social proximity. Your close contacts are "near" in the routing topology. Their contacts are one hop away. The table is built organically as the device observes which peers are frequently reachable through which relay paths. The table is local and ephemeral — no global state is required.

**Routing algorithm:**

When sending a message to a peer who is not directly reachable:

1. Check if any currently-connected peer has a recent relay path to the destination.
2. If not, gossip a **route request** (containing only the destination hash, not the sender's identity) to socially proximate peers.
3. Peers who recognise the destination hash (because the recipient is in their contact list) respond with a **route offer**.
4. The sender selects the shortest/fastest offered route and begins transmission.

**Why this works:** In real social networks, the average path length between any two people is approximately 6 hops (Milgram's small-world property). In a messaging context, most conversations happen between people who are 1–2 hops apart. The social graph is a naturally efficient routing topology. This is analogous to the **Bubble Rap** algorithm from Delay-Tolerant Networking research, adapted for the social graph implicit in a messaging application.

### 7.2. Store-and-Forward

When the destination peer is offline and no relay path exists:

1. The sending device identifies the **nearest available relay** — a device that is socially proximate to the recipient, currently online, and has a positive reciprocity balance.
2. The encrypted message blob is deposited with the relay.
3. The relay holds the blob for a configurable TTL (default: 72 hours).
4. When the recipient comes online, it announces its presence via its destination hash. Relays holding messages for that hash forward them.

**Multi-hop store-and-forward:** If no single relay has a direct path to the recipient, the message can be stored at intermediate relays, each holding it until a closer relay becomes available. The message "walks" toward the recipient through the social graph over time.

### 7.3. Reciprocity Engine

Every device maintains a local **relay ledger** — a record of how many bytes it has relayed for others and how many bytes others have relayed for it.

```
Reciprocity Score = bytes_relayed_for_others / bytes_others_relayed_for_me
```

- Score > 1.0: net contributor. Other devices prioritise your traffic.
- Score ~ 1.0: balanced. Normal service.
- Score < 0.5: net consumer. Relay priority decreases.
- Score < 0.1: free-rider. Only direct connections function; relay service effectively ceases.

The ledger is local and approximate — there is no global accounting. Peers track each other's contribution directly. This is analogous to BitTorrent's tit-for-tat choking algorithm: simple, local, and effective at discouraging free-riding without requiring a central authority.

**New device bootstrapping:** Fresh devices start with a grace period (configurable, default 48 hours) during which they receive normal relay service regardless of score.

---

## 8. Encryption & Security

Security is non-negotiable. The protocol must be designed so that even a malicious relay node — or the protocol developers themselves — cannot read a message or identify participants.

### 8.1. Cryptographic Primitives

| Primitive | Algorithm | Purpose |
| :--- | :--- | :--- |
| Key exchange | X25519 (Curve25519) | Identity keypairs, Diffie-Hellman |
| Session establishment | X3DH | Async key agreement with forward secrecy |
| Message ratchet | Double Ratchet | Per-message forward secrecy and break-in recovery |
| Symmetric encryption | AES-256-GCM | Message payload encryption |
| Hashing / KDF | BLAKE3 | Namespace IDs, destination hashes, key derivation |
| Group encryption | Sender Keys | Efficient group message encryption |

End-to-end encryption is on by default with no opt-out. There is no plaintext mode. This is a non-negotiable design decision.

### 8.2. Recommended Cryptography Libraries

| Platform | Library | Rationale |
| :--- | :--- | :--- |
| JavaScript / TypeScript | `@noble/curves` + `@noble/ciphers` | Audited, zero-dependency, tree-shakeable, minimal bundle size |
| Rust (core) | `ring` or `dalek-cryptography` | Battle-tested, `no_std` compatible for embedded targets |
| Swift (iOS) | `CryptoKit` (native) | Hardware-accelerated, no external dependency |
| Kotlin (Android) | `Tink` (Google) | Audited, straightforward API |

### 8.3. Relay Opacity

Relay nodes handle only opaque encrypted blobs. A relay can see:
- The destination hash (which rotates hourly and is unlinkable across periods)
- The blob size
- Timing metadata (when it received and forwarded the blob)

A relay **cannot** see:
- Message content
- Sender identity
- Recipient identity (only a rotating hash)
- Which namespace/app the message belongs to
- Whether the blob is a real message or chaff

### 8.4. Chaff Generation

Every device running the SDK emits a low, constant stream of encrypted chaff — random data indistinguishable from real messages. Chaff is addressed to random destination hashes that don't correspond to real users.

Traffic analysis becomes extremely difficult. An observer monitoring a device's network traffic cannot distinguish real messages from noise. The volume of chaff adapts to the device's relay willingness — eager relays emit more chaff, further obscuring real traffic patterns.

**Cost:** Approximately 1–3 KB/hour of additional data, negligible on any bearer.

### 8.5. Plausible Deniability

Messages are authenticated using **deniable authentication** (as in the OTR protocol). The recipient can verify the sender's identity, but cannot prove to a third party that the sender wrote any particular message. This is achieved by using MAC (message authentication codes) derived from the shared secret rather than digital signatures.

### 8.6. Metadata Protection Summary

- Chaff traffic obscures communication patterns.
- No plaintext sender/recipient identifiers in packet headers.
- Ephemeral destination hashes rotate hourly.
- Ephemeral sender session identifiers rotate regularly.

---

## 9. Packet Format

Each packet transmitted over the network conforms to a compact binary format to minimize overhead, especially on constrained transports.

| Field | Size | Description |
| :--- | :--- | :--- |
| `version` | 1 byte | Protocol version |
| `flags` | 1 byte | Packet type (data, ack, chaff, handshake, route_request, route_offer) |
| `dest_hash` | 8 bytes | Truncated BLAKE3 destination hash (rotates hourly) |
| `sender_ephemeral_id` | 16 bytes | Rotating ephemeral sender identifier |
| `ttl` | 1 byte | Time-to-live hop count (max 7) |
| `payload_length` | 2 bytes | Length of encrypted payload |
| `encrypted_payload` | Variable | AES-256-GCM ciphertext + tag |

Total minimum overhead: **29 bytes**. LZ4 compression is applied to the payload before encryption to minimise size.

---

## 10. Group Messaging

### 10.1. Dynamic Relay Trees

Group conversations do not require all-to-all connectivity. The protocol constructs a **dynamic relay tree** optimised for the group's current activity pattern:

1. When a group is created, one member is designated as the initial **tree root** (typically the creator).
2. As members send messages, the tree restructures so that the most active participants form the trunk, and less active members are leaves.
3. Active members relay messages to their connected branch of less active members.
4. The tree topology updates in real-time. If a previously quiet member becomes active, they migrate toward the trunk.

**Practical effect:** In a 20-person group where 3 people are having a rapid conversation and 17 are lurking, only the 3 active members maintain real-time connections. The 17 lurkers receive batched updates through the nearest active participant, with latency proportional to their social proximity in the group.

### 10.2. Group Key Management

Groups use the **Sender Keys** approach:
- Each group member generates a sender key and distributes it to all other members via pairwise encrypted channels.
- Messages are encrypted once with the sender key and delivered to all group members.
- When a member leaves, all sender keys are rotated.

This is the same approach used by Signal for group messaging and provides a good balance between security and efficiency.

---

## 11. Sybil Resistance

### 11.1. The Problem

In any P2P network, a malicious actor can spin up thousands of fake nodes to flood, disrupt, or surveil the network. Traditional solutions require identity verification, which conflicts with privacy goals.

### 11.2. Proof of Physical Device

MeshWhisper uses **hardware entropy challenges.** Periodically, peers challenge each other to produce entropy samples that demonstrate physical embodiment:

```
Challenge: "Provide 256 bytes of accelerometer data 
           captured over the next 3 seconds"
           
Response:  [raw sensor data]

Verification: Statistical analysis confirms the data exhibits
              characteristics of a physical device experiencing 
              gravity, micro-vibrations, and organic movement 
              patterns consistent with being carried or resting 
              on a surface.
```

A cloud VM running thousands of Sybil nodes cannot produce convincing accelerometer data at scale. The entropy patterns of a phone in a pocket, on a desk, or in a hand are statistically distinct from synthetic data.

This is probabilistic, not absolute. A determined attacker with physical devices can pass. But the economics change: attacking the network requires acquiring and operating thousands of physical phones, which is orders of magnitude more expensive than spinning up VMs.

### 11.3. Zero-Knowledge Relay Reputation

Nodes build reputation by proving relay behaviour without revealing identity:

```
ZK Proof: "I have successfully relayed more than N blobs 
           in the past M days, and my reciprocity score 
           exceeds threshold T."

Verification: Cryptographic proof is valid.

Result: Peer is treated as a reliable relay without 
        knowing who they are or what they relayed.
```

This uses a simplified zk-SNARK construction. Nodes with higher proven relay history receive routing preference, creating a positive feedback loop that rewards genuine participation.

---

## 12. SDK API Design

The SDK is deliberately simple. A mid-level mobile developer should be able to integrate messaging in under a day.

### 12.1. Initialisation

```typescript
import { MeshWhisper } from '@meshwhisper/sdk';

MeshWhisper.init({
  namespace: "com.example.fitnessapp",
  developerKey: "base64-encoded-public-key",
  permissionModel: "mutual",
  onMessage: (message) => { /* handle incoming */ },
  onPresence: (peer, status) => { /* handle presence changes */ },
  config: {
    relayWillingness: "auto",     // auto-adjusts based on battery
    chaffRate: "normal",           // low | normal | high
    storeTTL: 72,                  // hours to hold undelivered messages
    clusterEnabled: true           // enable multi-device clustering
  }
});
```

### 12.2. Core Operations

```typescript
// Send a message
MeshWhisper.send(recipientId, payload, {
  urgency: "normal",            // background | normal | urgent | critical
  expiry: 3600                  // seconds until message self-destructs
});

// Create a group
const group = MeshWhisper.createGroup({
  name: "Team Chat",
  members: [id1, id2, id3],
  permissionModel: "open"       // who can add new members
});

// Send to group
group.send(payload);

// Establish first contact
const contactRequest = MeshWhisper.generateContactQR();
// or
MeshWhisper.acceptContact(scannedQRData);
// or
MeshWhisper.introduceContacts(peerA, peerB);  // mutual contact brokers

// Presence
MeshWhisper.getPresence(peerId);
// returns: online | recently_seen | offline | unknown

// Connection events
MeshWhisper.onTransportChanged((transport) => {
  // 'platform_p2p' | 'local_net' | 'internet'
});
```

### 12.3. Compliance API

For regulated industries, the SDK provides optional hooks that the app developer can activate. These operate at the endpoint only:

```typescript
MeshWhisper.compliance({
  logging: true,               // log plaintext messages locally
  auditExport: "encrypted",   // export logs encrypted to compliance key
  retentionDays: 365,         // how long to retain logs
  contentScanning: (msg) => {
    // developer-implemented scanning function
    // e.g., CSAM hash matching, keyword filtering
    return { approved: true };
  }
});

// Middleware hooks
MeshWhisper.onBeforeSend((message) => {
  // developer can inspect, log, or block outgoing messages
  return approve(message);
});

MeshWhisper.onAfterReceive((message) => {
  // developer can inspect, log, moderate incoming messages
  return approve(message);
});
```

These hooks are entirely optional and entirely the app developer's responsibility. The protocol itself never has access to plaintext. The developer's app does, and what they do with it is governed by their jurisdiction's laws, not by the protocol.

---

## 13. Threat Model

### 13.1. What the Protocol Protects Against

- **Passive network surveillance:** Encryption + chaff + rotating destination hashes make traffic analysis impractical.
- **Server compromise:** No servers exist to compromise.
- **Legal compulsion of infrastructure:** No infrastructure provider holds user data or metadata.
- **Internet shutdowns:** Platform-native P2P operates independently of internet infrastructure for nearby devices. Sideloaded variant with raw BLE provides additional offline capability.
- **Sybil attacks:** Hardware entropy challenges raise the cost of fake node deployment.
- **NAT and firewall restrictions:** WebSocket on port 443 passes through every network on earth. No hole-punching required.

### 13.2. What the Protocol Does NOT Protect Against

- **Endpoint compromise:** If a device is physically seized or compromised with malware, messages in memory are accessible. This is true of all messaging systems.
- **App-layer logging:** If the app developer enables logging, messages are recorded at the endpoint. This is by design — it's how compliance works.
- **Targeted device surveillance:** A state actor targeting a specific device with spyware (Pegasus-style) can read messages as they're displayed. The protocol cannot defend against OS-level compromise.
- **Social engineering:** The protocol cannot prevent a user from screenshotting a conversation.
- **Both peers non-connectable with no mutual connectable peer:** If neither party has a connectable device in their social graph (both on cellular, no laptop, no home relay node), message delivery depends on finding a relay path through connectable devices further out in the social topology. In early adoption with low mesh density, this may cause delivery delays.

---

## 14. Performance Targets

| Metric | Target | Notes |
| :--- | :--- | :--- |
| Message delivery (both online, internet) | < 500ms | Comparable to existing chat apps |
| Message delivery (both online, platform P2P) | < 1s | Via Multipeer / Nearby Connections |
| Message delivery (recipient offline, relay) | < 5 min after recipient comes online | Dependent on mesh density |
| SDK binary size (iOS) | < 5 MB | Must not bloat host app |
| SDK binary size (Android) | < 3 MB | |
| Battery impact (non-relay mode) | < 2% daily | Comparable to background apps |
| Battery impact (eager relay mode) | < 8% daily | Opt-in only, charging-aware |
| RAM usage | < 30 MB | |
| Mesh density for reliable routing | > 100 devices per km² | Urban areas exceed this easily |

---

## 15. Prior Art & Differentiation

| Project | Type | Transport | Embeddable SDK | Namespace Isolation | Social Routing |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Meshtastic** | Consumer App | LoRa | No | No | No |
| **Bitchat** | Consumer App | BLE + Internet | No | No | No |
| **Nostr** | Protocol | Internet (Relays) | Partial | No | No |
| **Ditto SDK** | Commercial SDK | BLE + Wi-Fi + Internet | Yes | No | No |
| **libp2p** | Networking Library | Internet | Yes (complex) | No | No |
| **MeshWhisper** | Open SDK | Platform P2P + LAN + WebSocket | **Yes (10 lines)** | **Yes** | **Yes** |

The key differentiators are the combination of: a developer-first embeddable SDK, application-level namespace isolation that enables a shared relay mesh, social graph routing that avoids the scaling problems of broadcast flooding, and a WebSocket transport that works through every firewall on earth without NAT traversal.

---

## 16. Phased Delivery Roadmap

### Phase 1 — Protocol Spec & Reference Implementation (Months 1–6)

- Finalise protocol specification
- Build reference SDK for Android (Kotlin) and iOS (Swift)
- Platform-native P2P, local network, and WebSocket internet transport
- X3DH + Double Ratchet encryption
- Namespace isolation and destination hashing
- Social graph routing and store-and-forward relay
- Device self-clustering
- Reciprocity engine
- Contact permissioning
- Basic group messaging
- Publish spec and SDK as open source

**Deliverables:** Protocol spec v1.0, Android SDK, iOS SDK, TypeScript SDK (web), demo app.

### Phase 2 — Hardening & Security (Months 6–12)

- Implement chaff generation
- Implement zero-knowledge relay reputation
- Implement hardware entropy challenges (Sybil resistance)
- Plausible deniability (deniable authentication)
- Independent security audit
- Developer documentation and integration guides
- First partner app integrations

**Deliverables:** Security audit report, developer portal, documentation, npm/pub.dev/CocoaPods/Maven packages.

### Phase 3 — Adoption & Ecosystem (Months 12–18)

- Sideloaded variant with raw BLE for offline/activist use cases
- LZ4 message compression optimisation
- Battery optimisation with adaptive relay scheduling
- Present at DWeb Camp and relevant conferences
- Developer evangelism and community building
- Foundation incorporation and governance framework
- Protocol specification whitepaper

**Deliverables:** Sideloaded BLE app, whitepaper, foundation charter.

### Phase 4 — Commercial Layer (Months 18–24)

- Enterprise SDK with compliance tooling (logging, audit, retention)
- Hardware relay node (always-on home device, ~€50)
- Paid support and SLA tier for commercial developers
- Advanced analytics dashboard for SDK integrators

**Deliverables:** Enterprise SDK, hardware relay node, commercial support tier.

---

## 17. Open Questions & Risks

| Question / Risk | Current Thinking |
| :--- | :--- |
| **Adoption chicken-and-egg** | The internet transport mode works even with a single user (direct WebSocket), so the SDK has standalone value before the mesh is dense. |
| **Namespace governance** | Self-assigned (hash-based). Collisions are cryptographically improbable. Namespace squatting is possible but low-impact since namespaces are internal identifiers, not user-facing. |
| **Relay abuse by apps** | A malicious app developer could configure their SDK to maximise relay consumption and minimise contribution. The reciprocity engine mitigates at the device level, but app-level policy may be needed. |
| **Legal status** | In jurisdictions with mandatory data retention or lawful intercept requirements, does embedding the SDK create legal liability for the app developer? The endpoint compliance API addresses this, but per-jurisdiction legal analysis is needed. Legal exposure for relay nodes is analogous to an ISP carrying encrypted traffic. |
| **Key discovery without servers** | Gossip-based prekey distribution works within existing social graphs but makes cold-start contact between strangers harder than centralised alternatives. First contact requires QR/NFC/link exchange or mutual introduction. |
| **Connectable device density** | The WebSocket relay architecture depends on sufficient connectable devices (laptops, desktops, home relay nodes) in the social graph. The hardware relay node (Phase 4) mitigates this, but the cold-start period needs monitoring. |
| **Platform-native P2P limitations** | Apple Multipeer Connectivity and Google Nearby Connections are scoped to the same app/service identifier. Cross-app local relay is not possible. Offline mesh is same-app only. |
| **Battery drain** | Adaptive relay willingness; relay only when plugged in or above battery threshold. Eager relay capped at < 8% daily battery impact. |
| **Key management UX** | SDK handles key generation and storage internally. Developers and users never see raw keys. |
| **Regulatory communication** | The protocol's aggregate implications — making E2EE P2P messaging default infrastructure for any app — become apparent only at scale. The open spec ensures transparency, but proactive communication to regulators and platform vendors requires careful thought. |

---

## 18. References

[1] Sendbird Chat Pricing. https://sendbird.com/pricing/chat  
[2] PubNub Pricing Review. https://www.cometchat.com/blog/pubnub-pricing-plan-review  
[3] Stream Chat Pricing. https://getstream.io/blog/product-comparison-stream-vs-pubnub/  
[4] Understanding Firebase Realtime Database Pricing. https://airbyte.com/data-engineering-resources/firebase-database-pricing  
[5] Hui, P. et al. "Bubble Rap: Social-based Forwarding in Delay-Tolerant Networks." https://www.cl.cam.ac.uk/~jac22/camhor/bubble_tmc-sub.pdf  
[6] The X3DH Key Agreement Protocol. https://signal.org/docs/specifications/x3dh/  
[7] The Double Ratchet Algorithm. https://signal.org/docs/specifications/doubleratchet/  
[8] Noble Cryptography. https://paulmillr.com/noble/  
[9] Bitchat: Decentralized P2P Communication using Bluetooth. https://soln.tech/blog/bitchat  

---

*This document is a living specification. All technical decisions are subject to revision through community review, formal security analysis, and implementation experience.*

*Protocol & Foundation: MeshWhisper Foundation, Ireland*  
*Commercial Services: GestureLoop Ltd*  
*Contact: Anton Mannering*
