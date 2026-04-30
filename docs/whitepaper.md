# MeshWhisper: Messaging as Ambient Infrastructure

**April 2026**

---

## The problem with messaging infrastructure

Every application eventually needs messaging. A fitness app wants to connect athletes with coaches. A marketplace needs buyers to contact sellers. A coaching platform needs its members to coordinate. A community app needs its users to talk.

The developer faces the same choice every time.

**Build it yourself.** WebSocket servers are painful to build and expensive to scale. Real-time delivery, offline queuing, push notifications, media handling — each piece is a project on its own. Most small teams make a rational decision: skip messaging entirely, or redirect users to WhatsApp. The feature that would improve the product most is the one that never gets built.

**Pay for a managed service.** Sendbird starts at $349/month. PubNub charges from $98/month per thousand monthly active users. Stream Chat begins at $119/month. These costs scale aggressively. An indie developer with fifty thousand users is looking at a four-figure monthly bill for infrastructure they didn't want to build in the first place. For most apps, the economics never work.

**Use Firebase or a general-purpose platform.** Free at small scale, but every message passes through Google's infrastructure in readable form. Legal liability. GDPR complexity. Vendor lock-in. And eventually, at the scale that matters, a pricing cliff.

This trilemma has a structural cause. Traditional messaging infrastructure is expensive because it has to be. A centralised server receives every message, processes it, stores it, and delivers it. That server reads every message in order to route it. Scale requires more servers. More servers cost money. The bill lands on the developer.

The assumption embedded in this model — that a central server must understand a message to route it — is the assumption MeshWhisper breaks.

---

## The core insight

A relay does not need to read a message to forward it.

If messages are encrypted before they leave the sending device, a relay is just a pipe. It receives an opaque blob, identifies the intended recipient by a hash, and forwards the blob. It can't read the content. It doesn't need to. The message arrives at the recipient's device and is decrypted there, locally, with a key the relay never held.

This is not a novel observation in isolation. Signal uses end-to-end encryption. So does WhatsApp. The difference is that Signal and WhatsApp are *consumer products* with fixed namespaces. Their server knows which users it serves. It validates identity, enforces access, stores message history, and runs the business logic of the product.

MeshWhisper is not a product. It is transport infrastructure. It has no opinion about which users exist, which conversations are happening, or what is being said. It delivers opaque blobs between destination hashes and does nothing else.

The consequence is that the relay infrastructure for one application is identical, in every technical respect, to the relay infrastructure for every other application. A relay forwarding encrypted messages for a fitness app is indistinguishable from a relay forwarding encrypted messages for a marketplace. The relay cannot tell them apart. They use the same relay.

This is the protocol's defining principle:

> **Relay promiscuously, connect selectively.**

Every node in the MeshWhisper network — whether a server-side relay node deployed by an app developer, or a device running an SDK-embedded app — forwards encrypted packets regardless of which application they belong to. At the session layer, a device only decrypts and surfaces messages belonging to its own application namespace. Everything else passes through silently and ephemerally, never written to disk.

The relay mesh is shared. The application namespaces are isolated. These two properties together are what makes the economics work.

---

## How the mesh is structured

The network has two physical layers.

**The node layer** is the backbone. When a developer integrates the MeshWhisper SDK into their application, they also deploy a MeshWhisper Node — a single lightweight binary that provides four functions: packet relay and store-and-forward, push notification forwarding, encrypted media storage, and a prekey directory for first contact between strangers. One Docker container. One port. Everything included.

The node handles what phones cannot: it is always on, always connectable, and holds messages for offline recipients. When a user is not running the app, the node fires a silent content-free wake signal via APNs or FCM — the same mechanism Signal and WhatsApp use — and the device wakes, connects, and pulls its waiting messages. The node never holds a decryption key. The wake signal contains no message content. The node is, architecturally, a post box, not a postman.

Developers who prefer not to self-host can use a public-good relay — currently the first such node, live at `relay.meshwhisper.org` — or any other operator's relay they trust. Self-hosting is always free; the node binary is open source. The protocol behaves identically regardless of who operates the relay. Sustainability of public-good infrastructure is discussed later in the paper, in the section on operator economics.

**The device layer** is the mesh. Every device running any SDK-embedded application is simultaneously a potential relay for every other such device. When two devices are nearby, they relay for each other directly using platform-native P2P (Apple Multipeer Connectivity on iOS, Google Nearby Connections on Android). When they are further apart but on the same network, they relay over the local subnet. Over the internet, devices that can accept inbound connections — laptops on broadband, desktops, home relay hardware — act as connectable peers; phones on cellular maintain outbound connections to their deployed node.

**Namespace isolation.** Applications sharing relay infrastructure are isolated cryptographically, not by access control. Each application is identified by a namespace derived from the developer's public key and the application bundle identifier. Destination hashes — the routing identifiers on every packet — are computed as `BLAKE3(namespace_id || peer_key || epoch_hour)`. A relay node routing packets for multiple applications cannot tell them apart, cannot inject into any namespace without knowing the identifier, and cannot correlate traffic across namespaces even under active observation. The isolation is structural.

The routing algorithm is social-graph-based. Messages do not flood the network. Each device maintains a peer proximity table — not geographic, but social — tracking which relays reliably reach which destinations. A message travels through the topology the way rumours travel through a crowd: quickly when the sender and recipient share social context, through increasingly indirect paths when they don't. Average path length in a real social graph is approximately six hops. In practice, most conversations are one or two.

---

## Network effects, honestly

The central challenge of any mesh protocol is the bootstrap problem. A mesh that doesn't exist isn't useful. A network effect that requires a large network to deliver value is a circular dependency.

MeshWhisper separates the problem into two layers with different timelines.

The node layer has value from the first integration. A developer who deploys a MeshWhisper Node gets working E2EE relay infrastructure for their users immediately, before any other application has integrated the SDK. That is a real outcome. But it is worth being direct: a single developer with a single node has something structurally similar to what a self-hosted Matrix homeserver or a managed Sendbird deployment already provides — reliable delivery, push notifications, and end-to-end encryption for one application's users. The node layer sets a floor, not a ceiling.

The distinctive value is in the mesh layer, and the mesh layer requires adoption that does not exist on day one. Multi-node privacy routing, ambient relay capacity, and the privacy-improves-with-scale property are all functions of how many nodes and devices are participating. That is the honest statement of the bootstrap dependency.

The path through it is not a theory. GestureLoop deploys MeshWhisper in its own applications. Those deployments create real running infrastructure — nodes, real users, real message routing. A developer evaluating the SDK is evaluating something that exists and functions, not a proposal. Each additional developer integration adds a node and an active user base, shifting the aggregate relay topology further from "one operator's infrastructure" toward "shared mesh." The transition is incremental and each step has independent value, but the full value proposition requires the mesh that adoption builds.

This is the BitTorrent dynamic honestly applied. BitTorrent had no peers for the first torrent. MeshWhisper has no mesh for the first integration. What the architecture ensures is that each stage of adoption delivers real, usable value to the developer who integrates at that stage. The ceiling scales with adoption; the floor is set on day one.

---

## What this enables

The immediate consequence is economic. Messaging currently costs developers either months of engineering time or hundreds of dollars a month in perpetuity. MeshWhisper makes messaging the same kind of infrastructure decision as authentication or analytics — something you integrate in an afternoon with a library, not something you build or pay ongoing infrastructure costs to operate.

---

**Developer integration at a glance**

| Step | What you do |
|---|---|
| **1. Deploy** | `docker run -p 8080:8080 meshwhisper/node` — one container, one port |
| **2. Install** | `npm install @meshwhisper/sdk` |
| **3. Init** | `MeshWhisper.init({ namespace: 'com.myapp', node: 'wss://my-node.example.com' })` |
| **4. Send** | `await MeshWhisper.sendMessage(recipientId, payload)` |
| **5. Receive** | `onMessage: (msg) => display(msg)` |

| Your app owns | MeshWhisper owns |
|---|---|
| User accounts and identity | Cryptographic key exchange (PQXDH) |
| Message content (E2EE — no one sees it) | Session encryption (Double Ratchet) |
| Your deployed Node | Packet routing and relay logic |
| Your users' data | Store-and-forward for offline recipients |
| Your application UI and product | Push notification dispatch |
| | Post-quantum security stack |

---

The longer-term consequence is structural.

**The long tail of apps that should have messaging but don't.** The current economics of messaging mean that the feature is effectively rationed to apps with significant resources. Well-funded consumer apps can afford Sendbird. Enterprise software vendors can build custom infrastructure. Everyone else redirects users to WhatsApp or ships without the feature. MeshWhisper breaks this stratification. A solo developer building a niche community app, an NGO deploying a coordination tool, a researcher building a protocol study app — all have access to the same messaging infrastructure as a funded startup. The cost barrier disappears.

**Privacy as a default, not a premium.** Every message sent through MeshWhisper is end-to-end encrypted before it leaves the device. The protocol uses a hybrid classical and post-quantum cryptographic stack: X3DH key exchange extended with ML-KEM-768 encapsulation (PQXDH), followed by Double Ratchet session encryption. This meets what Apple calls Level 2 post-quantum security — the same class as the current shipping version of iMessage — protecting against adversaries who record encrypted traffic today and attempt to decrypt it with a future quantum computer. The next security milestone on the roadmap is Level 3: periodic ML-KEM injection into the ratchet itself, so that a session heals automatically after compromise rather than remaining exposed for its full lifetime. No relay node, including the Foundation and including self-hosted nodes, can read message content or identify participants beyond rotating hourly hashes. This is not a configuration option. There is no plaintext mode. A developer who integrates MeshWhisper has post-quantum E2EE messaging without having to understand cryptography, implement it, or make any decision about it. The default is privacy.

This matters beyond compliance. It changes the liability structure for developers. An app whose messaging layer provably cannot produce plaintext under legal compulsion is in a different legal position than one whose provider holds decryption keys as a business requirement. The endpoint compliance API allows developers to implement jurisdiction-specific requirements at the application layer, where they belong, without compromising the underlying transport guarantee.

**Resilient communication where infrastructure is unreliable.** The protocol's multi-bearer transport — platform-native P2P, local network, internet — degrades gracefully as connectivity degrades. Two devices on the same subnet can message each other when the internet is down. Two devices physically nearby can communicate without any network infrastructure at all using platform P2P. The sideloaded variant extends this to raw Bluetooth mesh, enabling communication in environments with no infrastructure whatsoever.

This is not primarily a disaster-response feature, though it applies there. It is a structural property of the protocol that means an app built on MeshWhisper functions in rural areas with intermittent connectivity, in buildings with poor cellular coverage, at events where networks are congested, and in the ordinary moments when a network connection is temporarily unavailable. Offline resilience is not something the developer needs to build. It is the default behaviour of the transport layer.

**The mesh as a side effect of existence.** As adoption grows, a device running any SDK-embedded application — whether the user knows it or not — is contributing to relay infrastructure for every other SDK-embedded application. A fitness app's users are part of the relay backbone for a marketplace app's users, and vice versa. This is the protocol's most unusual property: the infrastructure is built by participation, not by investment. Every new user of any participating app is, without any action on their part, improving message delivery for every other user of every other participating app.

The aggregate of this is an ambient messaging infrastructure that did not require anyone to build it directly. It emerged from the ordinary act of developers adding a messaging library to their applications.

---

## What it is not

MeshWhisper is not fully serverless in the engineering sense. The MeshWhisper Node is a server. Public-good relays are servers. Developers self-hosting their own nodes are running servers. The protocol is honest about this.

What it is serverless for is the developer experience. A developer integrating the SDK does not need to build, scale, or maintain messaging infrastructure. They deploy one Docker container (or point at any operator's relay) and add ten lines of code to their application. The infrastructure complexity is solved once, at the protocol level, and reused by every integration.

The distinction matters because honesty about infrastructure is what makes the trust model credible. A protocol that claimed to have no servers while quietly depending on them would be making a claim about its threat model that its architecture couldn't support. MeshWhisper's nodes are explicitly and openly part of the architecture, with a precisely defined threat model: they relay opaque encrypted blobs, hold rotating destination hashes, and store push tokens for offline delivery. They are ISPs carrying encrypted traffic, not parties to the conversation.

MeshWhisper is also not anonymous communication in the strong sense. It is not Tor. But its privacy properties are worth understanding precisely, because they are unusual: they strengthen automatically as the network grows.

A node operator can observe the devices directly connected to it — their source IPs, push tokens, and traffic timing. For a message that travels directly from Alice's device to a single node and on to Bob's device, that node sees both ends of the conversation and can correlate them. This is the weakest privacy case, and it applies at low mesh density when Alice and Bob happen to share the same node.

Traffic timing is partially obscured by a second mechanism. Every active device generates a continuous stream of random encrypted packets — chaff — regardless of whether the user is sending real messages. The rate is constant rather than activity-correlated. A node operator cannot distinguish real messages from background noise, and cannot infer from traffic volume whether a conversation is active. The side effect of this privacy measure is that total traffic volume is proportional to active devices rather than to message activity, which matters for capacity planning and billing.

As mesh density increases, this picture changes significantly. Nodes connect to each other as peers, not only to devices. A message that travels Alice's device → Alice's node → Bob's node → Bob's device is split across two nodes, neither of which sees both endpoints. Alice's node sees Alice but not Bob. Bob's node sees Bob but not Alice. At higher mesh density still, messages route through multiple intermediate nodes, and the path from sender to recipient passes through parties none of whom hold more than a fragment of the metadata.

The privacy guarantee strengthens as a side effect of adoption. More applications integrating the SDK means more nodes. More nodes means longer average paths. Longer paths means each node's view of any given conversation narrows. This is the inverse of centralised messaging, where scale concentrates metadata and creates an increasingly valuable surveillance target. In MeshWhisper, scale distributes metadata and makes any single node's position less useful to an adversary.

At low density, a node operator's view is approximately equivalent to a messaging service provider's. At high density, it is approximately equivalent to a backbone ISP's — aware that traffic is flowing, unable to say meaningfully between whom. Users who require stronger anonymity guarantees at any density level should use a VPN alongside the SDK. The protocol's privacy properties are real, bounded, and transparent about what they don't provide.

**Namespace isolation mechanism.** Applications sharing relay infrastructure are isolated cryptographically, not by access control. Each application is identified by a namespace derived from the developer's public key and application bundle identifier. Destination hashes — the routing identifiers on every packet — are computed as `BLAKE3(namespace_id || peer_key || epoch_hour)`. A relay node cannot determine which application a packet belongs to, cannot inject into any namespace without knowing the identifier, and cannot correlate traffic across namespaces even under active observation.

**How it compares to open alternatives.** A developer who knows the open-protocol landscape deserves a direct comparison.

*Matrix / Element* is federated, supports E2EE, and has real developer adoption. Matrix homeservers store full message history (and can read it if E2EE is misconfigured), have no device-layer mesh, and use a per-homeserver namespace model where federation makes users across servers co-visible in shared rooms. MeshWhisper's relay is content-blind and namespace-blind by construction — the node has no persistent message storage and cannot form a view of conversation graphs.

*Nostr* relays see public keys, content, and timestamps. It is designed for public broadcast; the privacy model for private messaging is fundamentally different.

*XMPP* shares the federated server model. E2EE via OMEMO is available but optional and inconsistently deployed. No device-layer mesh exists.

The closest comparison is Matrix. If the use case is a standalone federated messaging system and users will manage accounts directly, Matrix is a mature choice. MeshWhisper is designed for a different pattern: a library inside an existing application, using the application's existing identity model, invisible to users as infrastructure.

**Backup that doesn't betray the protocol.** Most messengers solve cross-device continuity by exporting an encrypted backup to a third-party cloud — Google Drive, iCloud, a homeserver, the developer's own backup service. The backup itself is opaque to that third party, but its existence is not. Cloud providers learn that a given user has a WhatsApp backup, when it was made, and how large it is. For a protocol that goes to architectural lengths to prevent any single party from holding both ends of a conversation, leaking that metadata to a separate provider is a significant give-back.

MeshWhisper's archive design avoids this. Backup colocates with the relay the user has already chosen to trust. The archive is a single AES-GCM blob, keyed by the user's peer ID, stored alongside the rest of the relay's opaque content. The relay sees no account, no email, no phone number, no username — only an unidentified peer-ID hash and an encrypted payload. The backup encryption key and the write-authentication token are both HKDF-derived from the user's identity key, which is itself derived from the username and password via PBKDF2. The user does not separately manage a recovery code, a security key, or a third-party account; the password they already use to unlock the application is sufficient to recover their full conversation history on any device. Sessions are intentionally excluded from the archive so that a stolen backup cannot decrypt past or future traffic — forward secrecy is preserved even at rest.

The result is a backup model with the same trust shape as the rest of the protocol. If the user self-hosts the relay, they self-host the backup. If they use a Foundation relay, the Foundation sees the same opaque blob it already routes for live traffic — nothing new becomes visible. This is qualitatively different from the standard pattern of "encrypted messaging app, plus a separate cloud account that knows you use it."

**Operator economics, in three layers.** Infrastructure economics and application economics are different problems and shouldn't be conflated. App developers monetise through their products. The protocol intentionally avoids any per-message-volume or per-user-count tax that an app would have to absorb out of its product margin. The same dynamic that makes Sendbird and PubNub painful — paying a layered cost to operate a feature your app needs — is exactly what MeshWhisper exists to escape.

The right question is how the *infrastructure* sustains itself, on its own terms, by parties with direct interest in operating infrastructure. Three layers, with their own economics:

*The protocol layer.* MIT-licensed, free, anyone can implement, anyone can extend. No commercial relationship with anyone is required to use it. This stays the case forever.

*The infrastructure layer.* Anyone runs a relay node. The first such node is live at `relay.meshwhisper.org`, alongside Prudence (the reference PWA at `prudence.meshwhisper.org`). A public-good Foundation may eventually formalise as a non-commercial entity that operates backbone capacity funded by donations, grants, or aligned commercial sponsors — the same shape Mozilla Foundation, the Tor Project, or ICANN occupy in their domains. We are explicitly not proposing a freemium-on-Foundation model with per-MAU pricing, because that would create economic pressure for everyone to centralise on whoever runs the freemium tier — directly opposing the privacy-through-density property the protocol depends on.

*The commercial-services layer.* Anyone — including but not limited to GestureLoop — can offer managed hosting, enterprise support, or custom deployment as a commercial service. This is a competitive market, not a protocol tax. Managed hosting competes on quality and price the way managed Postgres or managed Redis competes; it doesn't have privileged status, and it doesn't extract from app developers. A developer who wants to outsource ops pays a hosting provider; a developer who wants control runs the binary themselves; both paths remain first-class.

The trap to name explicitly: a per-MAU tier on whatever entity ends up hosting public-good infrastructure would push every small developer toward that infrastructure, fragment the operator base, and undermine the whitepaper's strongest privacy claim. We're avoiding it by design.

**Why operators open their nodes.** The protocol asks every operator to forward encrypted packets regardless of which application they belong to. There are three reasons to participate, in roughly increasing strength:

*Philosophy.* You believe a content-blind, multi-operator messaging substrate is worth contributing to. Same energy that runs Tor middle nodes and seeds open-source torrents.

*Reciprocity for your own privacy.* The privacy property that "no single operator sees both ends of a conversation" only activates when *your* users' messages can route through other operators. If you don't forward theirs, you don't get to expect them to forward yours. Selfish operators get a worse privacy posture for their own users.

*Marginal cost.* The bandwidth involved in forwarding others' opaque blobs is small relative to a typical VPS budget. A €4 VPS typically includes ample bandwidth that a small app uses a fraction of. Closing your node saves you almost nothing and removes you from the mesh property entirely.

Promiscuous relay does not mean uncapped relay. The current reference implementation forwards openly without any reciprocity enforcement — the closest analog is Tor's middle-node model, where operators contribute capacity without expecting tit-for-tat accounting. Adaptive throttling — protecting a small operator from being overwhelmed by a much larger app's traffic — is a future direction, not a v1 feature. The reasoning: at low density that protection matters in theory but the load isn't actually present; at higher density the load spreads naturally across more operators and any single node carries a smaller share. The architecture relies on operators collectively maintaining the relay-promiscuously norm; the protocol can encourage but not enforce.

---

## Beyond human messaging

The preceding sections frame MeshWhisper as developer infrastructure for human communication. That framing is accurate as a starting point but understates the protocol's generality.

The core primitive — authenticated, asynchronous, end-to-end encrypted message delivery between parties that have exchanged keys, without a trusted central broker, with store-and-forward for intermittently connected recipients — is not specific to human users. It applies wherever those properties are needed.

**Smart home and IoT devices.** Most smart home products communicate through the manufacturer's cloud. A light switch command travels from your phone to a server in another country and back — the manufacturer observes your usage patterns, the service can be discontinued, and a server breach potentially exposes every customer's home activity. A device with a key pair participates in PQXDH key exchange the same way a human user does. Commands from a phone to a thermostat are end-to-end encrypted before they leave the phone; the relay sees only an opaque blob. The local-network transport means commands route directly between devices on the same subnet without any internet round-trip, and the system continues to function when the internet is unavailable. MeshWhisper makes it possible to build smart home products where the manufacturer's server is relay infrastructure — not a trusted intermediary with a full record of your home's activity.

The post-quantum security properties are particularly relevant for embedded devices. A thermostat deployed today may run for ten years without a meaningful software update. Unlike a human conversation, which has a natural end, a machine session can run indefinitely — a compromised ratchet state on a long-lived device exposes all future traffic for the device's entire remaining lifetime. The planned Level 3 ratchet — periodic ML-KEM injection that heals a session automatically after compromise — bounds that exposure window regardless of how long the device runs. This is a stronger argument for ratchet-level post-quantum security in IoT than it is in human messaging.

**AI agent coordination.** Autonomous agents that need to coordinate — passing tasks, returning results, requesting tools from other agents — need a communication layer that handles authentication and asynchronous delivery. The PQXDH identity model means an agent can cryptographically verify it is communicating with the intended counterpart, not an impersonator, which is a problem most current agentic frameworks leave unsolved. Namespace isolation means multiple agent systems can share relay infrastructure without cross-contamination. Asynchronous delivery handles agents that run on different schedules or are intermittently available.

**Supply chain and logistics.** Events that need to travel between parties who do not share infrastructure and should not trust each other's servers — custody transfers, cold-chain temperature records, delivery confirmations — fit the protocol model naturally. Each party operates their own node. Events are cryptographically authenticated by the originating device, delivered asynchronously to the recipient, and the relay cannot read or correlate the data.

**Industrial and field systems.** Sensors, actuators, and controllers in environments with intermittent connectivity — remote infrastructure, maritime systems, field equipment — require reliable store-and-forward delivery, authenticated commands that a relay cannot forge or modify, and local-network routing when internet connectivity is unavailable. These are structural properties of the protocol, not features that need to be added.

In each case, the protocol's value derives from the same source: the relay does not need to read a message to route it, and a relay that cannot read a message cannot be compelled to expose it, cannot be breached to reveal it, and cannot be discontinued in a way that prevents the parties from communicating directly.

---

## The protocol's place

The history of the internet is a history of protocols becoming ambient infrastructure. SMTP is not a product — it is infrastructure that email products are built on. DNS is not a product — it is infrastructure that every internet application uses. HTTP is not a product — it is infrastructure that the web is built on. No individual company operates these protocols. No single party controls them. They exist as shared utilities, maintained by open specifications, implemented by competing and cooperating parties, and used by applications that neither know nor care about the underlying mechanics.

Messaging has not had its SMTP moment. The dominant messaging infrastructure is owned by a small number of large platforms, each operating closed proprietary systems, each holding the plaintext of every message their users send. Adding messaging to an application means becoming dependent on one of these platforms or building from scratch.

MeshWhisper is an attempt to give messaging its SMTP moment: an open protocol, implemented as a developer library, operated as shared infrastructure, with no single party controlling the network or able to read its traffic. One that gets better as more developers use it and doesn't require any individual developer to understand its internals to benefit from it.

The SMTP analogy is instructive but cuts both ways. SMTP succeeded partly because institutions had structural incentives to run mail servers before there was a meaningful network to participate in. MeshWhisper's adoption chain is similar in shape and worth naming directly.

**Stage one** is bootstrap: GestureLoop deploys MeshWhisper in its own applications, creating real running infrastructure with real users. The first relay node is live at `relay.meshwhisper.org` alongside Prudence — a reference PWA messaging application built entirely on the SDK, available at `prudence.meshwhisper.org`. MeshWhisper is being integrated into existing GestureLoop applications. A developer evaluating the SDK at this stage finds a working relay network with active users, not a proposal.

**Stage two** is early developer adoption: other developers integrate the SDK and deploy nodes. Multi-node privacy routing becomes real — messages route across independent operators rather than through a single party. The bootstrap operator's share of total relay capacity shrinks as developer-deployed infrastructure grows.

**Stage three** is mesh density: as the SDK-embedded user base across all applications grows, device-layer relay capacity becomes meaningful and the privacy properties of multi-hop routing become typical rather than exceptional.

Each stage has independent value for the developer who integrates at that stage. The ceiling scales with adoption; the floor is set by the node layer on day one.

Whether the full arc is reached depends on execution. The technical foundation is in place. The first stage is already live.

---

## History

MeshWhisper began as a late-night text-message conversation between Anton Mannering and Kevin Collins. Anton proposed an end-to-end-encrypted peer-to-peer messaging protocol and sent over a PRD. Kevin had been drafting one independently from the same conversation; he combined them, and within thirty minutes a working prototype existed — a long way from usable, but a real running starting point. Anton has architected the protocol and led its evolution since, adapting the idealised design to the realities of mobile devices, intermittent connectivity, and modern threat models.

**From prototype to protocol.** The first commit landed at 00:18 on 10 April 2026 — a 27-file, 11,693-line drop that implemented the protocol's outline end-to-end: X3DH, Double Ratchet, packet framing, transports, routing, relay logic, namespace isolation. It was an impressive sketch and an unusable product. It had no persistence, no post-quantum layer, no standalone relay server, no browser support, no push notifications, and a single test file. Most of the work since has been turning that sketch into something that survives real devices: persisting state across restarts, splitting the relay into a deployable server with SQLite-backed durability, adding PQXDH and ML-KEM-768, building a push pipeline that preserves end-to-end encryption, writing tests that found bugs that code review missed (an OPK derivation mismatch, `Math.random` used where a CSPRNG was required), designing a multi-device archive, and deferring the speculative modules that hadn't earned their place. The current codebase is many orders of magnitude removed from that first commit; the original repository is preserved in git history for anyone who wants to see the distance.

**Implementation status, honestly.** Some layers are production: end-to-end encryption (PQXDH + Double Ratchet), persistence, push notifications, group messaging, encrypted media, the multi-device archive, safety numbers. Other layers are *scaffolded* — they sketch how the protocol intends to handle problems that emerge at scale, but they aren't load-bearing in current deployments and we don't claim otherwise. Sybil resistance for relay reputation, social-graph-aware routing, and audit-log compliance hooks all fall into this category. They are real interfaces with real designs, awaiting the conditions under which they need to be activated. As the protocol moves into the multi-operator regime described above, these layers will be hardened in step.

---

*MeshWhisper is open source. The protocol specification, SDK, and node binary are published under the MIT licence. The SDK is available at `npm install @meshwhisper/sdk`. The node binary is available as a Docker image. Self-hosting is free, always.*

*Live: `relay.meshwhisper.org` · Reference app: Prudence (`prudence.meshwhisper.org`)*

*Contact: anton@gestureloop.com*
