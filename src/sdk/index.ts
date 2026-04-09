// ============================================================
// MeshWhisper SDK — Public API Surface
// The main entry point developers interact with. Wires together
// all 17 internal modules into a cohesive, ergonomic interface.
// ============================================================

import type {
  BearerType,
  ChaffRate,
  ClusterDevice,
  DeviceCapability,
  Group,
  Message,
  MessageUrgency,
  Packet,
  PermissionModel,
  PreKeyBundle,
  PresenceStatus,
  MeshWhisperConfig,
  RelayWillingness,
} from '../types.js';
import { PacketFlags } from '../types.js';

// --- Internal module imports ---

import {
  encrypt,
  decrypt,
  randomBytes,
  deriveDestHash,
  getCurrentEpochHour,
  concat,
  generateKeyPair,
  kdf,
} from '../crypto/index.js';
import {
  generatePreKeyBundle,
  initiateKeyExchange,
  completeKeyExchange,
  serializePreKeyBundle,
  deserializePreKeyBundle,
} from '../x3dh/index.js';
import type { RatchetState, RatchetHeader } from '../ratchet/index.js';
import {
  initSender,
  initReceiver,
  ratchetEncrypt,
  ratchetDecrypt,
} from '../ratchet/index.js';
import {
  encodePacket,
  decodePacket,
  createDataPacket,
  createHandshakePacket,
  compressPayload,
  decompressPayload,
  PROTOCOL_VERSION,
} from '../packet/index.js';
import { WebSocketTransport } from '../transport/websocket/index.js';
import { LocalTransport } from '../transport/local/index.js';
import {
  PlatformP2PTransport,
  registerPlatformBridge,
} from '../transport/p2p/index.js';
import type { PlatformP2PBridge } from '../transport/p2p/index.js';
import { BearerNegotiator } from '../transport/negotiator/index.js';
import {
  SocialGraphRouter,
  PeerProximityTable,
} from '../routing/index.js';
import { RelayStore, StoreAndForwardManager } from '../relay/index.js';
import { RelayLedger } from '../reciprocity/index.js';
import {
  NamespaceManager,
  LocalIdentity,
  PeerIdentityCache,
} from '../namespace/index.js';
import { PermissionManager } from '../permissions/index.js';
import type { ContactContext } from '../permissions/index.js';
import { DeviceCluster } from '../cluster/index.js';
import { GroupManager } from '../group/index.js';
import { ChaffGenerator } from '../chaff/index.js';
import { EntropyChallenger, ZKRelayReputation } from '../sybil/index.js';

// ============================================================
// Public option/event types
// ============================================================

export interface SendOptions {
  /** Message urgency: background | normal | urgent | critical. */
  urgency?: MessageUrgency;
  /** Message expiry in seconds from now. */
  expiry?: number;
}

export interface CreateGroupOptions {
  name: string;
  members: string[];
  permissionModel?: PermissionModel;
}

export interface TransportChangedEvent {
  type: BearerType;
  available: boolean;
}

// ============================================================
// GroupHandle — returned by createGroup / getGroup
// ============================================================

/**
 * A handle to a group that provides a `send()` method, mirroring
 * the PRD's `group.send(payload)` API.
 */
export class GroupHandle {
  /** The underlying group metadata. */
  readonly group: Group;

  private readonly sdk: MeshWhisper;

  /** @internal */
  constructor(group: Group, sdk: MeshWhisper) {
    this.group = group;
    this.sdk = sdk;
  }

  /** The group's unique ID. */
  get id(): string {
    return this.group.id;
  }

  /** The group's display name. */
  get name(): string {
    return this.group.name;
  }

  /** List of member IDs. */
  get members(): string[] {
    return Array.from(this.group.members.keys());
  }

  /**
   * Send a message to all group members.
   * The payload is encrypted with the local peer's sender key and
   * relayed through the group's dynamic relay tree.
   */
  async send(payload: Uint8Array): Promise<void> {
    await this.sdk.sendToGroup(this.group.id, payload);
  }

  /** Add a member to the group. */
  addMember(peerId: string): void {
    this.sdk['groupManager'].addMember(this.group.id, peerId);
  }

  /** Remove a member from the group. */
  removeMember(peerId: string): void {
    this.sdk['groupManager'].removeMember(this.group.id, peerId);
  }
}

// ============================================================
// Internal message envelope (serialized inside encrypted payload)
// ============================================================

interface MessageEnvelope {
  id: string;
  senderId: string;
  recipientId: string;
  payload: number[]; // serialized Uint8Array
  timestamp: number;
  urgency: MessageUrgency;
  expiry?: number;
  /** Group message metadata, if present. */
  group?: {
    groupId: string;
    senderId: string;
  };
  /** Ratchet header for pairwise sessions. */
  ratchetHeader?: {
    dhPublicKey: number[];
    previousChainLength: number;
    messageNumber: number;
  };
}

// ============================================================
// Handshake envelope (serialized inside HANDSHAKE packets)
// ============================================================

interface HandshakeEnvelope {
  type: 'x3dh_init' | 'x3dh_response' | 'prekey_bundle';
  senderId: string;
  preKeyBundle?: number[]; // serialized PreKeyBundle
  ephemeralPublicKey?: number[];
  identityKey?: number[];
}

// ============================================================
// Presence tracking
// ============================================================

interface PeerPresenceRecord {
  peerId: string;
  status: PresenceStatus;
  lastSeen: number;
}

// ============================================================
// MeshWhisper — Main SDK Class
// ============================================================

/**
 * MeshWhisper is the primary API surface for the serverless P2P E2EE
 * messaging SDK. Instantiate via `MeshWhisper.init(config)`, then use
 * the returned instance (also accessible via `MeshWhisper.instance`)
 * for all messaging operations.
 *
 * Static convenience methods delegate to the singleton instance.
 */
export class MeshWhisper {
  // --- Singleton ---
  private static _instance: MeshWhisper | null = null;

  // --- Configuration ---
  private readonly config: MeshWhisperConfig;

  // --- Subsystem instances ---
  private readonly identity: LocalIdentity;
  private readonly namespaceManager: NamespaceManager;
  private readonly peerCache: PeerIdentityCache;
  private readonly permissionManager: PermissionManager;
  private readonly negotiator: BearerNegotiator;
  private readonly router: SocialGraphRouter;
  private readonly relayStore: RelayStore;
  private readonly relayManager: StoreAndForwardManager;
  private readonly reciprocityLedger: RelayLedger;
  private readonly groupManager: GroupManager;
  private readonly chaffGenerator: ChaffGenerator;
  private readonly entropyChallenger: EntropyChallenger;
  private readonly zkReputation: ZKRelayReputation;
  private cluster: DeviceCluster | null = null;

  // --- Transports ---
  private readonly wsTransport: WebSocketTransport;
  private readonly localTransport: LocalTransport;
  private readonly p2pTransport: PlatformP2PTransport;

  // --- Session state ---
  private readonly sessions: Map<string, RatchetState> = new Map();
  private readonly peerPreKeyBundles: Map<string, PreKeyBundle> = new Map();
  private readonly pendingHandshakes: Map<string, { resolve: () => void }> = new Map();

  // --- Presence ---
  private readonly presenceRecords: Map<string, PeerPresenceRecord> = new Map();

  // --- Event handlers ---
  private onMessageHandler: ((message: Message) => void) | null = null;
  private onPresenceHandler: ((peerId: string, status: PresenceStatus) => void) | null = null;
  private readonly transportChangedHandlers: Set<(event: TransportChangedEvent) => void> = new Set();

  // --- Lifecycle ---
  private running = false;
  private ephemeralRotationTimer: ReturnType<typeof setInterval> | null = null;

  // ================================================================
  // Constructor (private — use MeshWhisper.init())
  // ================================================================

  private constructor(config: MeshWhisperConfig) {
    this.config = config;

    // --- Identity ---
    this.identity = LocalIdentity.create();
    const developerKeyBytes = base64ToUint8Array(config.developerKey);
    const namespaceSalt = randomBytes(32);
    this.namespaceManager = new NamespaceManager({
      appBundleId: config.namespace,
      developerPublicKey: developerKeyBytes,
      salt: namespaceSalt,
    });
    this.peerCache = new PeerIdentityCache();

    // --- Permissions ---
    this.permissionManager = new PermissionManager(config.permissionModel);

    // --- Transports ---
    const deviceId = randomBytes(16);
    this.wsTransport = new WebSocketTransport();
    this.localTransport = new LocalTransport(deviceId);
    this.p2pTransport = new PlatformP2PTransport(config.namespace);
    this.negotiator = new BearerNegotiator([
      this.p2pTransport,
      this.localTransport,
      this.wsTransport,
    ]);

    // --- Routing ---
    const localPeerId = this.getLocalPeerId();
    const proximityTable = new PeerProximityTable();
    this.router = new SocialGraphRouter(localPeerId, proximityTable);

    // --- Relay (store-and-forward) ---
    const storeTTL = config.config?.storeTTL ?? 72;
    this.relayStore = new RelayStore({ defaultTTLHours: storeTTL });
    this.relayManager = new StoreAndForwardManager(this.relayStore);

    // --- Reciprocity ---
    this.reciprocityLedger = new RelayLedger();
    this.reciprocityLedger.registerDevice(localPeerId);

    // --- Groups ---
    this.groupManager = new GroupManager(localPeerId);

    // --- Chaff ---
    const chaffRate = config.config?.chaffRate ?? 'normal';
    this.chaffGenerator = new ChaffGenerator({ rate: chaffRate });

    // --- Sybil resistance ---
    this.entropyChallenger = new EntropyChallenger();
    this.zkReputation = new ZKRelayReputation(localPeerId);

    // --- Cluster (optional) ---
    if (config.config?.clusterEnabled !== false) {
      this.cluster = new DeviceCluster(
        this.identity.getPublicKey(),
        localPeerId,
      );
    }

    // --- Event handlers from config ---
    this.onMessageHandler = config.onMessage ?? null;
    this.onPresenceHandler = config.onPresence ?? null;
  }

  // ================================================================
  // Initialization — static entry point
  // ================================================================

  /**
   * Initialize the MeshWhisper SDK with the given configuration.
   *
   * ```ts
   * const mw = await MeshWhisper.init({
   *   namespace: "com.example.fitnessapp",
   *   developerKey: "base64-encoded-public-key",
   *   permissionModel: "mutual",
   *   onMessage: (message) => { ... },
   *   onPresence: (peer, status) => { ... },
   *   config: {
   *     relayWillingness: "auto",
   *     chaffRate: "normal",
   *     storeTTL: 72,
   *     clusterEnabled: true,
   *   },
   * });
   * ```
   */
  static async init(config: MeshWhisperConfig): Promise<MeshWhisper> {
    if (MeshWhisper._instance) {
      await MeshWhisper._instance.shutdown();
    }

    const instance = new MeshWhisper(config);
    MeshWhisper._instance = instance;
    await instance.start();
    return instance;
  }

  /**
   * Returns the active MeshWhisper instance, or throws if not initialized.
   */
  static get instance(): MeshWhisper {
    if (!MeshWhisper._instance) {
      throw new Error(
        'MeshWhisper has not been initialized. Call MeshWhisper.init() first.',
      );
    }
    return MeshWhisper._instance;
  }

  // ================================================================
  // Lifecycle
  // ================================================================

  private async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Wire up the unified receive handler across all transports
    this.negotiator.onReceive(
      (packet: Packet, source: string, bearer: BearerType) => {
        this.handleIncomingPacket(packet, source, bearer);
      },
    );

    // Start transports (best-effort; some may not be available)
    const startResults = await Promise.allSettled([
      this.wsTransport.start(),
      this.localTransport.start(),
      this.p2pTransport.start(),
    ]);

    // Emit transport availability events
    const transportTypes: BearerType[] = ['internet', 'local_net', 'platform_p2p'];
    for (let i = 0; i < startResults.length; i++) {
      const available = startResults[i].status === 'fulfilled';
      for (const handler of this.transportChangedHandlers) {
        try {
          handler({ type: transportTypes[i], available });
        } catch {
          // Swallow handler errors
        }
      }
    }

    // Start chaff generator — wire output into the negotiator
    this.chaffGenerator.onChaffGenerated((packet: Packet) => {
      this.negotiator.broadcast(packet).catch(() => {
        // Best effort for chaff
      });
    });
    this.chaffGenerator.start();

    // Start relay store pruning
    this.relayStore.startPruneInterval();

    // Start device cluster
    if (this.cluster) {
      const localDevice: ClusterDevice = {
        deviceId: this.getLocalPeerId(),
        clusterKey: this.cluster.getClusterKey(),
        capabilities: await this.negotiator.probeAvailability(),
        isPrimary: false,
        lastSync: Date.now(),
      };
      this.cluster.addDevice(localDevice);
      this.cluster.start();
    }

    // Rotate ephemeral sender ID every 10 minutes
    this.ephemeralRotationTimer = setInterval(() => {
      this.identity.rotateEphemeralId();
    }, 10 * 60 * 1000);
    if (typeof this.ephemeralRotationTimer === 'object' && 'unref' in this.ephemeralRotationTimer) {
      (this.ephemeralRotationTimer as NodeJS.Timeout).unref();
    }
  }

  /**
   * Shut down the SDK, stopping all transports, timers, and subsystems.
   * After calling `shutdown()`, you must call `MeshWhisper.init()` again
   * to resume operation.
   */
  async shutdown(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    // Stop chaff
    this.chaffGenerator.stop();

    // Stop relay pruning
    this.relayStore.stopPruneInterval();

    // Stop cluster
    if (this.cluster) {
      this.cluster.stop();
    }

    // Stop ephemeral rotation
    if (this.ephemeralRotationTimer) {
      clearInterval(this.ephemeralRotationTimer);
      this.ephemeralRotationTimer = null;
    }

    // Stop transports
    await Promise.allSettled([
      this.wsTransport.stop(),
      this.localTransport.stop(),
      this.p2pTransport.stop(),
    ]);

    MeshWhisper._instance = null;
  }

  // ================================================================
  // Public API — Messaging
  // ================================================================

  /**
   * Send an encrypted message to a recipient.
   *
   * If no session exists with the recipient, an X3DH handshake is
   * automatically initiated. Messages are compressed, encrypted via
   * the Double Ratchet, assembled into a packet, and routed through
   * the best available transport.
   *
   * ```ts
   * await MeshWhisper.send(recipientId, payload, {
   *   urgency: "normal",
   *   expiry: 3600,
   * });
   * ```
   */
  static async send(
    recipientId: string,
    payload: Uint8Array,
    options?: SendOptions,
  ): Promise<void> {
    return MeshWhisper.instance.sendMessage(recipientId, payload, options);
  }

  async sendMessage(
    recipientId: string,
    payload: Uint8Array,
    options?: SendOptions,
  ): Promise<void> {
    this.assertRunning();

    // Check permissions
    const canSend = await this.permissionManager.canSendTo(recipientId);
    if (!canSend) {
      throw new Error(`Permission denied: cannot send to ${recipientId}`);
    }

    // Ensure we have a ratchet session with this peer
    await this.ensureSession(recipientId);

    const session = this.sessions.get(recipientId);
    if (!session) {
      throw new Error(`Failed to establish session with ${recipientId}`);
    }

    // Build message envelope
    const messageId = generateMessageId();
    const envelope: MessageEnvelope = {
      id: messageId,
      senderId: this.getLocalPeerId(),
      recipientId,
      payload: Array.from(payload),
      timestamp: Date.now(),
      urgency: options?.urgency ?? 'normal',
      expiry: options?.expiry,
    };

    // Serialize, compress, encrypt
    const envelopeBytes = new TextEncoder().encode(JSON.stringify(envelope));
    const compressed = compressPayload(envelopeBytes);
    const { state: newState, header, ciphertext } = ratchetEncrypt(session, compressed);
    this.sessions.set(recipientId, newState);

    // Embed ratchet header into the ciphertext for the receiver
    const headerBytes = serializeRatchetHeader(header);
    const fullPayload = concat(headerBytes, ciphertext);

    // Build packet
    const recipientPublicKey = this.peerCache.getPeerPublicKey(recipientId);
    if (!recipientPublicKey) {
      throw new Error(`No public key for recipient ${recipientId}`);
    }
    const destHash = deriveDestHash(recipientPublicKey, getCurrentEpochHour());
    const senderEphId = this.identity.generateEphemeralId();
    const packet = createDataPacket(destHash, senderEphId, fullPayload);

    // Camouflage with chaff
    const burst = this.chaffGenerator.camouflageRealMessage(packet);

    // Route and send each packet in the burst
    for (const p of burst) {
      await this.routeAndSend(p, recipientId);
    }
  }

  // ================================================================
  // Public API — Groups
  // ================================================================

  /**
   * Create a new group.
   *
   * ```ts
   * const group = MeshWhisper.createGroup({
   *   name: "Team Chat",
   *   members: [id1, id2, id3],
   *   permissionModel: "open",
   * });
   * group.send(payload);
   * ```
   */
  static createGroup(options: CreateGroupOptions): GroupHandle {
    return MeshWhisper.instance.createGroupInstance(options);
  }

  createGroupInstance(options: CreateGroupOptions): GroupHandle {
    this.assertRunning();

    const group = this.groupManager.createGroup(
      options.name,
      options.members,
      options.permissionModel ?? 'open',
    );

    return new GroupHandle(group, this);
  }

  /**
   * Retrieve a group handle by ID.
   * Returns null if the group is not found.
   */
  getGroup(groupId: string): GroupHandle | null {
    const group = this.groupManager.getGroup(groupId);
    if (!group) return null;
    return new GroupHandle(group, this);
  }

  /**
   * List all groups the local peer is participating in.
   */
  getGroups(): GroupHandle[] {
    return this.groupManager.getGroups().map(g => new GroupHandle(g, this));
  }

  /**
   * Send a message to all members of a group.
   * @internal — use GroupHandle.send() instead.
   */
  async sendToGroup(groupId: string, payload: Uint8Array): Promise<void> {
    this.assertRunning();

    const { ciphertext, senderId } = this.groupManager.encryptForGroup(groupId, payload);
    const targets = this.groupManager.routeGroupMessage(groupId, ciphertext, senderId);

    const sendPromises = targets.map(async (target) => {
      try {
        const recipientPublicKey = this.peerCache.getPeerPublicKey(target.peerId);
        if (!recipientPublicKey) return;

        const destHash = deriveDestHash(recipientPublicKey, getCurrentEpochHour());
        const senderEphId = this.identity.generateEphemeralId();
        const packet = createDataPacket(destHash, senderEphId, target.data);
        await this.routeAndSend(packet, target.peerId);
      } catch {
        // Best effort per member
      }
    });

    await Promise.allSettled(sendPromises);
  }

  // ================================================================
  // Public API — Contacts & Identity
  // ================================================================

  /**
   * Generate a QR code payload for first contact. Contains the
   * local peer's identity public key and pre-key bundle so a
   * scanner can initiate an X3DH handshake.
   *
   * Returns a base64-encoded string suitable for embedding in a QR code.
   */
  static generateContactQR(): string {
    return MeshWhisper.instance.generateContactQRInstance();
  }

  generateContactQRInstance(): string {
    this.assertRunning();

    const edKeyPair = {
      publicKey: this.identity.getEdPublicKey(),
      privateKey: this.identity['edPrivateKey'] as Uint8Array,
    };
    const bundle = generatePreKeyBundle(edKeyPair);
    const serialized = serializePreKeyBundle(bundle);

    // Encode as: peerId-length(2) + peerId-bytes + bundle-bytes
    const peerIdBytes = new TextEncoder().encode(this.getLocalPeerId());
    const lenBuf = new Uint8Array(2);
    new DataView(lenBuf.buffer).setUint16(0, peerIdBytes.length, false);

    const qrPayload = concat(lenBuf, peerIdBytes, serialized);
    return uint8ArrayToBase64(qrPayload);
  }

  /**
   * Accept a contact from scanned QR data. Parses the peer's
   * pre-key bundle and initiates an X3DH handshake.
   */
  static async acceptContact(scannedQRData: string): Promise<void> {
    return MeshWhisper.instance.acceptContactInstance(scannedQRData);
  }

  async acceptContactInstance(scannedQRData: string): Promise<void> {
    this.assertRunning();

    const raw = base64ToUint8Array(scannedQRData);
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const peerIdLen = view.getUint16(0, false);
    const peerIdBytes = raw.slice(2, 2 + peerIdLen);
    const peerId = new TextDecoder().decode(peerIdBytes);
    const bundleBytes = raw.slice(2 + peerIdLen);
    const bundle = deserializePreKeyBundle(bundleBytes);

    // Store the peer's identity
    this.peerPreKeyBundles.set(peerId, bundle);

    // For mutual model, register the contact request
    if (this.config.permissionModel === 'mutual') {
      this.permissionManager.confirmMutualContact(peerId);
    } else {
      this.permissionManager.addContact(peerId);
    }

    // Cache the peer's public key (convert Ed25519 identity key to X25519)
    // The bundle identity key is Ed25519; the signed pre-key is X25519.
    // For dest_hash we need the X25519 key derived from the identity key.
    // Store the signed pre-key as the peer's X25519 public key for routing.
    this.peerCache.addPeer(peerId, bundle.signedPreKey);

    // Initiate X3DH session
    await this.initiateHandshake(peerId, bundle);
  }

  /**
   * Introduce two contacts to each other.
   * Both peers must already be contacts of the local peer.
   */
  static async introduceContacts(peerA: string, peerB: string): Promise<void> {
    return MeshWhisper.instance.introduceContactsInstance(peerA, peerB);
  }

  async introduceContactsInstance(peerA: string, peerB: string): Promise<void> {
    this.assertRunning();

    if (!this.permissionManager.isContact(peerA)) {
      throw new Error(`${peerA} is not a contact`);
    }
    if (!this.permissionManager.isContact(peerB)) {
      throw new Error(`${peerB} is not a contact`);
    }

    // Send each peer the other's pre-key bundle so they can establish
    // a session directly.
    const pubKeyA = this.peerCache.getPeerPublicKey(peerA);
    const pubKeyB = this.peerCache.getPeerPublicKey(peerB);

    if (pubKeyA && pubKeyB) {
      // Craft introduction messages containing the peer's public key
      const introForA = new TextEncoder().encode(JSON.stringify({
        type: 'introduction',
        introducedPeerId: peerB,
        introducedPublicKey: Array.from(pubKeyB),
        introducedBy: this.getLocalPeerId(),
      }));
      const introForB = new TextEncoder().encode(JSON.stringify({
        type: 'introduction',
        introducedPeerId: peerA,
        introducedPublicKey: Array.from(pubKeyA),
        introducedBy: this.getLocalPeerId(),
      }));

      await Promise.allSettled([
        this.sendMessage(peerA, introForA),
        this.sendMessage(peerB, introForB),
      ]);
    }
  }

  // ================================================================
  // Public API — Presence
  // ================================================================

  /**
   * Get the current presence status of a peer.
   */
  static getPresence(peerId: string): PresenceStatus {
    return MeshWhisper.instance.getPresenceInstance(peerId);
  }

  getPresenceInstance(peerId: string): PresenceStatus {
    const record = this.presenceRecords.get(peerId);
    if (!record) return 'unknown';

    const elapsed = Date.now() - record.lastSeen;
    if (elapsed < 5 * 60 * 1000) return 'online';
    if (elapsed < 60 * 60 * 1000) return 'recently_seen';
    return 'offline';
  }

  // ================================================================
  // Public API — Transport Events
  // ================================================================

  /**
   * Register a callback that fires when transport availability changes.
   */
  static onTransportChanged(handler: (event: TransportChangedEvent) => void): void {
    MeshWhisper.instance.onTransportChangedInstance(handler);
  }

  onTransportChangedInstance(handler: (event: TransportChangedEvent) => void): void {
    this.transportChangedHandlers.add(handler);
  }

  /**
   * Unregister a transport-changed handler.
   */
  offTransportChanged(handler: (event: TransportChangedEvent) => void): void {
    this.transportChangedHandlers.delete(handler);
  }

  // ================================================================
  // Public API — Accessors
  // ================================================================

  /**
   * Returns the local peer's public identity string (hex-encoded X25519 public key).
   */
  getLocalPeerId(): string {
    return uint8ArrayToHex(this.identity.getPublicKey());
  }

  /**
   * Returns the local peer's X25519 public key bytes.
   */
  getPublicKey(): Uint8Array {
    return this.identity.getPublicKey();
  }

  /**
   * Returns the namespace ID for this SDK instance.
   */
  getNamespaceId(): Uint8Array {
    return this.namespaceManager.getNamespaceId();
  }

  /**
   * Whether the SDK is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Register a native P2P bridge (e.g., Apple Multipeer Connectivity
   * or Google Nearby Connections). Call before `init()` for the bridge
   * to be available at startup.
   */
  static registerPlatformBridge(bridge: PlatformP2PBridge): void {
    registerPlatformBridge(bridge);
  }

  // ================================================================
  // Internal — Incoming Packet Handling
  // ================================================================

  private handleIncomingPacket(
    packet: Packet,
    source: string,
    bearer: BearerType,
  ): void {
    // Update presence for the source
    this.updatePresence(source, 'online');

    // Track reciprocity for relayed packets
    this.reciprocityLedger.recordPeerRelayedForUs(source, packet.encryptedPayload.length);

    // Drop chaff packets silently
    if (packet.flags === PacketFlags.CHAFF) {
      return;
    }

    // Check if the packet is destined for us
    const isForUs = this.identity.matchesDestHash(packet.destHash);

    if (isForUs) {
      this.processLocalPacket(packet, source);
    } else {
      // Not for us — consider relaying
      this.maybeRelay(packet, source);
    }
  }

  private processLocalPacket(packet: Packet, source: string): void {
    switch (packet.flags) {
      case PacketFlags.HANDSHAKE:
        this.handleHandshakePacket(packet, source);
        break;

      case PacketFlags.DATA:
        this.handleDataPacket(packet, source);
        break;

      case PacketFlags.ACK:
        // ACKs are currently handled implicitly by the ratchet
        break;

      case PacketFlags.ROUTE_REQUEST:
        this.handleRouteRequestPacket(packet, source);
        break;

      case PacketFlags.ROUTE_OFFER:
        this.handleRouteOfferPacket(packet, source);
        break;

      default:
        // Unknown flag — drop silently
        break;
    }
  }

  private handleDataPacket(packet: Packet, source: string): void {
    try {
      // Split the payload into ratchet header + ciphertext
      const headerAndCiphertext = packet.encryptedPayload;
      const { header, ciphertextBody } = deserializeRatchetHeader(headerAndCiphertext);

      // Try to find the session by looking at known peer IDs
      // We check all sessions because the sender's ephemeral ID rotates
      let decrypted: Uint8Array | null = null;
      let matchedPeerId: string | null = null;

      for (const [peerId, session] of this.sessions) {
        try {
          const { state: newState, plaintext } = ratchetDecrypt(session, header, ciphertextBody);
          this.sessions.set(peerId, newState);
          decrypted = plaintext;
          matchedPeerId = peerId;
          break;
        } catch {
          // Wrong session — try next
          continue;
        }
      }

      if (!decrypted || !matchedPeerId) {
        // Could not decrypt with any known session
        return;
      }

      // Decompress and parse the message envelope
      const decompressed = decompressPayload(decrypted);
      const envelope: MessageEnvelope = JSON.parse(
        new TextDecoder().decode(decompressed),
      );

      // Build the Message object
      const message: Message = {
        id: envelope.id,
        senderId: envelope.senderId,
        recipientId: envelope.recipientId,
        payload: new Uint8Array(envelope.payload),
        timestamp: envelope.timestamp,
        urgency: envelope.urgency,
        expiry: envelope.expiry,
      };

      // Check expiry
      if (message.expiry) {
        const expiresAt = message.timestamp + message.expiry * 1000;
        if (Date.now() > expiresAt) {
          return; // Message expired
        }
      }

      // Surface to app
      if (this.onMessageHandler) {
        this.onMessageHandler(message);
      }

      // If cluster is enabled, queue for sync to other devices
      if (this.cluster) {
        this.cluster.syncManager.queueForSync({
          messageId: message.id,
          encryptedPayload: packet.encryptedPayload,
          receivedAt: Date.now(),
          receivedBy: this.getLocalPeerId(),
          syncedTo: new Set([this.getLocalPeerId()]),
        });
      }
    } catch {
      // Malformed packet — drop silently
    }
  }

  private handleHandshakePacket(packet: Packet, source: string): void {
    try {
      const envelopeStr = new TextDecoder().decode(packet.encryptedPayload);
      const envelope: HandshakeEnvelope = JSON.parse(envelopeStr);

      switch (envelope.type) {
        case 'prekey_bundle': {
          if (envelope.preKeyBundle) {
            const bundleBytes = new Uint8Array(envelope.preKeyBundle);
            const bundle = deserializePreKeyBundle(bundleBytes);
            this.peerPreKeyBundles.set(envelope.senderId, bundle);
            this.peerCache.addPeer(envelope.senderId, bundle.signedPreKey);
          }
          break;
        }

        case 'x3dh_init': {
          // Responder side: complete the X3DH exchange
          if (envelope.ephemeralPublicKey && envelope.identityKey) {
            this.completeIncomingHandshake(envelope);
          }
          break;
        }

        case 'x3dh_response': {
          // Resolve any pending handshake
          const pending = this.pendingHandshakes.get(envelope.senderId);
          if (pending) {
            pending.resolve();
            this.pendingHandshakes.delete(envelope.senderId);
          }
          break;
        }
      }
    } catch {
      // Malformed handshake — drop
    }
  }

  private handleRouteRequestPacket(packet: Packet, source: string): void {
    // Attempt to parse the route request from the payload
    try {
      const requestStr = new TextDecoder().decode(packet.encryptedPayload);
      const request = JSON.parse(requestStr);
      const offer = this.router.handleRouteRequest(
        {
          destHash: new Uint8Array(request.destHash),
          requestId: new Uint8Array(request.requestId),
          ttl: request.ttl,
          timestamp: request.timestamp,
        },
        source,
      );

      if (offer) {
        // Send route offer back to the requesting peer
        const offerPayload = new TextEncoder().encode(JSON.stringify(offer));
        const destHash = packet.destHash; // Reply to the requester's hash
        const senderEphId = this.identity.generateEphemeralId();
        const offerPacket: Packet = {
          version: PROTOCOL_VERSION,
          flags: PacketFlags.ROUTE_OFFER,
          destHash,
          senderEphemeralId: senderEphId,
          ttl: packet.ttl,
          payloadLength: offerPayload.length,
          encryptedPayload: offerPayload,
        };

        this.negotiator.send(offerPacket, source).catch(() => {
          // Best effort
        });
      }
    } catch {
      // Malformed route request — drop
    }
  }

  private handleRouteOfferPacket(packet: Packet, _source: string): void {
    try {
      const offerStr = new TextDecoder().decode(packet.encryptedPayload);
      const offer = JSON.parse(offerStr);
      this.router.handleRouteOffer({
        requestId: new Uint8Array(offer.requestId),
        hopCount: offer.hopCount,
        estimatedLatency: offer.estimatedLatency,
        offeredBy: offer.offeredBy,
      });
    } catch {
      // Malformed route offer — drop
    }
  }

  // ================================================================
  // Internal — Relay Logic
  // ================================================================

  private maybeRelay(packet: Packet, source: string): void {
    // Check if the router thinks we should relay
    if (!this.router.shouldRelay(packet)) {
      return;
    }

    // Check reciprocity: should we relay for this peer?
    if (!this.reciprocityLedger.shouldRelay(source)) {
      return;
    }

    // Decrement TTL and forward
    const forwarded = this.router.decrementTTL(packet);

    // Track reciprocity: we are relaying for this peer
    this.reciprocityLedger.recordRelayedForPeer(source, packet.encryptedPayload.length);

    // Try to find a next hop
    const nextHop = this.router.getNextHop(packet.destHash);
    if (nextHop) {
      this.negotiator.send(forwarded, nextHop).catch(() => {
        // If direct send fails, try store-and-forward
        this.relayManager.storeForDelivery(
          packet.destHash,
          packet.encryptedPayload,
          this.config.config?.storeTTL ?? 72,
        );
      });
    } else {
      // No route known — store for later delivery
      this.relayManager.storeForDelivery(
        packet.destHash,
        packet.encryptedPayload,
        this.config.config?.storeTTL ?? 72,
      );
    }
  }

  // ================================================================
  // Internal — Session Management (X3DH + Double Ratchet)
  // ================================================================

  private async ensureSession(recipientId: string): Promise<void> {
    if (this.sessions.has(recipientId)) {
      return;
    }

    // Check if we have a pre-key bundle for this peer
    const bundle = this.peerPreKeyBundles.get(recipientId);
    if (bundle) {
      await this.initiateHandshake(recipientId, bundle);
      return;
    }

    // No bundle available — request one via route discovery
    throw new Error(
      `No pre-key bundle for ${recipientId}. ` +
      `Use acceptContact() or acceptContact(scannedQR) to establish first contact.`,
    );
  }

  private async initiateHandshake(
    peerId: string,
    bundle: PreKeyBundle,
  ): Promise<void> {
    // Perform X3DH as the initiator
    const aliceIdentity = {
      publicKey: this.identity.getEdPublicKey(),
      privateKey: this.identity['edPrivateKey'] as Uint8Array,
    };

    const result = initiateKeyExchange(aliceIdentity, bundle);

    // Initialize the Double Ratchet as sender
    const ratchetState = initSender(result.sharedSecret, bundle.signedPreKey);
    this.sessions.set(peerId, ratchetState);

    // Send handshake packet to the peer so they can complete their side
    const handshakeEnvelope: HandshakeEnvelope = {
      type: 'x3dh_init',
      senderId: this.getLocalPeerId(),
      ephemeralPublicKey: Array.from(result.ephemeralPublicKey),
      identityKey: Array.from(this.identity.getEdPublicKey()),
    };

    const envelopeBytes = new TextEncoder().encode(JSON.stringify(handshakeEnvelope));
    const recipientPublicKey = this.peerCache.getPeerPublicKey(peerId);
    if (!recipientPublicKey) return;

    const destHash = deriveDestHash(recipientPublicKey, getCurrentEpochHour());
    const senderEphId = this.identity.generateEphemeralId();
    const handshakePacket = createHandshakePacket(destHash, senderEphId, envelopeBytes);

    await this.routeAndSend(handshakePacket, peerId);
  }

  private completeIncomingHandshake(envelope: HandshakeEnvelope): void {
    if (!envelope.ephemeralPublicKey || !envelope.identityKey) return;

    const aliceEphemeralKey = new Uint8Array(envelope.ephemeralPublicKey);
    const aliceIdentityKey = new Uint8Array(envelope.identityKey);

    // We need our signed pre-key pair to complete the exchange
    // In a production system, the pre-key private keys would be stored.
    // For now, we use the X25519 identity key pair as the signed pre-key.
    const bobSignedPreKey = {
      publicKey: this.identity.getPublicKey(),
      privateKey: this.identity.getPrivateKey(),
    };

    const bobIdentity = {
      publicKey: this.identity.getEdPublicKey(),
      privateKey: this.identity['edPrivateKey'] as Uint8Array,
    };

    const sharedSecret = completeKeyExchange(
      bobIdentity,
      bobSignedPreKey,
      null, // No one-time pre-key for now
      aliceIdentityKey,
      aliceEphemeralKey,
    );

    // Initialize the Double Ratchet as receiver
    const ratchetState = initReceiver(sharedSecret, bobSignedPreKey);
    this.sessions.set(envelope.senderId, ratchetState);

    // Register the peer as a contact
    this.permissionManager.addContact(envelope.senderId);

    // Send handshake response
    const response: HandshakeEnvelope = {
      type: 'x3dh_response',
      senderId: this.getLocalPeerId(),
    };

    const responseBytes = new TextEncoder().encode(JSON.stringify(response));
    const peerPublicKey = this.peerCache.getPeerPublicKey(envelope.senderId);
    if (!peerPublicKey) return;

    const destHash = deriveDestHash(peerPublicKey, getCurrentEpochHour());
    const senderEphId = this.identity.generateEphemeralId();
    const responsePacket = createHandshakePacket(destHash, senderEphId, responseBytes);

    this.routeAndSend(responsePacket, envelope.senderId).catch(() => {
      // Best effort
    });
  }

  // ================================================================
  // Internal — Routing & Sending
  // ================================================================

  private async routeAndSend(packet: Packet, recipientId: string): Promise<void> {
    // Try direct send via the negotiator
    try {
      await this.negotiator.send(packet, recipientId);
      return;
    } catch {
      // Direct send failed — try routing
    }

    // Try next hop via the social graph router
    const nextHop = this.router.getNextHop(packet.destHash);
    if (nextHop) {
      try {
        await this.negotiator.send(packet, nextHop);
        return;
      } catch {
        // Next hop also failed
      }
    }

    // Fall back to store-and-forward
    this.relayManager.storeForDelivery(
      packet.destHash,
      packet.encryptedPayload,
      this.config.config?.storeTTL ?? 72,
    );
  }

  // ================================================================
  // Internal — Presence
  // ================================================================

  private updatePresence(peerId: string, status: PresenceStatus): void {
    const now = Date.now();
    const previous = this.presenceRecords.get(peerId);
    const previousStatus = previous?.status ?? 'unknown';

    this.presenceRecords.set(peerId, {
      peerId,
      status,
      lastSeen: now,
    });

    // Deliver any stored blobs for this peer coming online
    const peerPublicKey = this.peerCache.getPeerPublicKey(peerId);
    if (peerPublicKey) {
      const destHash = deriveDestHash(peerPublicKey, getCurrentEpochHour());
      const storedBlobs = this.relayManager.deliverStored(destHash);
      for (const blob of storedBlobs) {
        // Re-inject stored blobs as incoming packets
        const storedPacket: Packet = {
          version: PROTOCOL_VERSION,
          flags: PacketFlags.DATA,
          destHash: blob.destHash,
          senderEphemeralId: new Uint8Array(16), // Unknown sender eph ID
          ttl: 0,
          payloadLength: blob.encryptedPayload.length,
          encryptedPayload: blob.encryptedPayload,
        };

        this.negotiator.send(storedPacket, peerId).catch(() => {
          // Best effort
        });
      }
    }

    // Notify the app if status changed
    if (status !== previousStatus && this.onPresenceHandler) {
      this.onPresenceHandler(peerId, status);
    }
  }

  // ================================================================
  // Internal — Assertions
  // ================================================================

  private assertRunning(): void {
    if (!this.running) {
      throw new Error(
        'MeshWhisper is not running. Call MeshWhisper.init() first.',
      );
    }
  }
}

// ============================================================
// Utility Functions
// ============================================================

function uint8ArrayToHex(arr: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < arr.length; i++) {
    hex += arr[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function uint8ArrayToBase64(arr: Uint8Array): string {
  // Works in both Node.js and browser environments
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(arr).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i]);
  }
  return btoa(binary);
}

function base64ToUint8Array(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function generateMessageId(): string {
  const bytes = randomBytes(16);
  return uint8ArrayToHex(bytes);
}

// ============================================================
// Ratchet Header Serialization
//
// Wire format:
//   [32 bytes dhPublicKey] [4 bytes previousChainLength BE] [4 bytes messageNumber BE]
// ============================================================

const RATCHET_HEADER_SIZE = 40;

function serializeRatchetHeader(header: RatchetHeader): Uint8Array {
  const buf = new Uint8Array(RATCHET_HEADER_SIZE);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  buf.set(header.dhPublicKey, 0);
  view.setUint32(32, header.previousChainLength, false);
  view.setUint32(36, header.messageNumber, false);

  return buf;
}

function deserializeRatchetHeader(
  data: Uint8Array,
): { header: RatchetHeader; ciphertextBody: Uint8Array } {
  if (data.length < RATCHET_HEADER_SIZE) {
    throw new Error('Data too short for ratchet header');
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const header: RatchetHeader = {
    dhPublicKey: data.slice(0, 32),
    previousChainLength: view.getUint32(32, false),
    messageNumber: view.getUint32(36, false),
  };

  const ciphertextBody = data.slice(RATCHET_HEADER_SIZE);

  return { header, ciphertextBody };
}
