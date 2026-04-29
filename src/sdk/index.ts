// ============================================================
// MeshWhisper SDK — Public API Surface
//
// Thin coordinator that wires together:
//   - SessionManager  (X3DH + Double Ratchet)
//   - MessageHandler  (decrypt, dedup, persistence)
//   - All transport subsystems
// ============================================================

import type {
  BearerType,
  ClusterDevice,
  Group,
  Message,
  MessageUrgency,
  Packet,
  PermissionModel,
  PresenceStatus,
  MeshWhisperConfig,
  StorageBackend,
  StoredMessage,
  Conversation,
  Transport as MWTransport,
} from '../types.js';
import { PacketFlags } from '../types.js';

import { edwardsToMontgomeryPub } from '@noble/curves/ed25519';
import {
  encrypt,
  decrypt,
  randomBytes,
  deriveDestHash,
  getCurrentEpochHour,
  concat,
} from '../crypto/index.js';
import {
  serializePreKeyBundle,
  deserializePreKeyBundle,
} from '../x3dh/index.js';
import {
  computeFingerprint,
  verifySafetyNumber,
} from '../fingerprint/index.js';
import {
  ratchetEncrypt,
} from '../ratchet/index.js';
import {
  createDataPacket,
  compressPayload,
  PROTOCOL_VERSION,
} from '../packet/index.js';
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
import { DeviceCluster } from '../cluster/index.js';
import { GroupManager } from '../group/index.js';
import { ChaffGenerator } from '../chaff/index.js';
import { SessionManager } from './session-manager.js';
import { MessageHandler } from './message-handler.js';
import { SybilManager, RELAY_TRUST_FLOOR } from './sybil-manager.js';
import {
  uint8ArrayToHex,
  hexToUint8Array,
  uint8ArrayToBase64,
  base64ToUint8Array,
  generateMessageId,
  serializeRatchetHeader,
  isControlPayload,
} from './utils.js';

// ============================================================
// Public option/event types
// ============================================================

export interface SendOptions {
  urgency?: MessageUrgency;
  expiry?: number;
}

export interface MediaSendOptions extends SendOptions {
  mimeType?: string;
  upload?: (encryptedData: Uint8Array) => Promise<string>;
}

export interface MediaMessage {
  url: string;
  key: string;
  mimeType?: string;
}

export interface CreateGroupOptions {
  name: string;
  members?: string[];
  permissionModel?: PermissionModel;
}

export interface TransportChangedEvent {
  type: BearerType;
  available: boolean;
}

// ============================================================
// GroupHandle
// ============================================================

export class GroupHandle {
  readonly group: Group;
  private readonly sdk: MeshWhisper;

  constructor(group: Group, sdk: MeshWhisper) {
    this.group = group;
    this.sdk = sdk;
  }

  get id(): string { return this.group.id; }
  get name(): string { return this.group.name; }
  get members(): string[] { return Array.from(this.group.members.keys()); }

  async send(payload: Uint8Array): Promise<void> {
    await this.sdk.sendToGroup(this.group.id, payload);
  }

  addMember(peerId: string): void {
    this.sdk['groupManager'].addMember(this.group.id, peerId);
  }

  removeMember(peerId: string): void {
    this.sdk['groupManager'].removeMember(this.group.id, peerId);
  }

  leave(): void {
    this.sdk['groupManager'].leaveGroup(this.group.id);
  }
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

export class MeshWhisper {
  private static _instance: MeshWhisper | null = null;

  private readonly config: MeshWhisperConfig;

  // --- Subsystems ---
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
  private readonly sybilManager: SybilManager;
  private cluster: DeviceCluster | null = null;

  // --- Focused managers ---
  private readonly sessionManager: SessionManager;
  private readonly messageHandler: MessageHandler;

  // --- Transports ---
  private readonly wsTransport: MWTransport;
  private readonly localTransport: MWTransport;
  private readonly p2pTransport: PlatformP2PTransport;
  private nodeTransport: MWTransport | null = null;

  // --- Persistence ---
  private readonly storage: StorageBackend | null;

  // --- Presence ---
  private readonly presenceRecords: Map<string, PeerPresenceRecord> = new Map();

  // --- Event handlers ---
  private onPresenceHandler: ((peerId: string, status: PresenceStatus) => void) | null = null;
  private onTypingHandler: ((peerId: string, isTyping: boolean) => void) | null = null;
  private onContactRequestHandler: ((peerId: string, introducedBy: string, username?: string) => void | Promise<void>) | null = null;
  private onGroupInviteHandler: ((groupId: string, groupName: string, invitedBy: string, members: string[]) => void | Promise<void>) | null = null;
  private readonly pendingGroupInvites: Map<string, import('../group/index.js').GroupInvite> = new Map();
  private readonly transportChangedHandlers: Set<(event: TransportChangedEvent) => void> = new Set();

  // --- Connection state & offline queue ---
  private nodeConnected = false;
  private readonly outboundQueue: Array<{
    recipientId: string;
    payload: Uint8Array;
    options?: SendOptions;
  }> = [];

  // --- Lifecycle ---
  private running = false;
  private startupReinitiationDone = false;
  private ephemeralRotationTimer: ReturnType<typeof setInterval> | null = null;
  private reputationBroadcastTimer: ReturnType<typeof setInterval> | null = null;

  // ================================================================
  // Constructor (private — use MeshWhisper.init())
  // ================================================================

  private constructor(
    config: MeshWhisperConfig,
    identity: LocalIdentity,
    storage: StorageBackend | null,
    wsTransport: MWTransport,
    localTransport: MWTransport,
    nodeTransport: MWTransport,
  ) {
    this.config = config;
    this.storage = storage;
    this.identity = identity;

    // When no developer key is provided, use all-zeros so that two apps with the
    // same namespace string share the same routing namespace and can reach each other.
    // Production apps should always supply their own key for namespace isolation.
    const developerKeyBytes = config.developerKey
      ? base64ToUint8Array(config.developerKey)
      : new Uint8Array(32);
    this.namespaceManager = new NamespaceManager({
      appBundleId: config.namespace,
      developerPublicKey: developerKeyBytes,
    });
    this.peerCache = new PeerIdentityCache();
    this.permissionManager = new PermissionManager(config.permissionModel ?? 'open');

    // --- Transports ---
    this.wsTransport = wsTransport;
    this.localTransport = localTransport;
    this.nodeTransport = nodeTransport;
    this.p2pTransport = new PlatformP2PTransport(config.namespace);

    this.negotiator = new BearerNegotiator([
      this.p2pTransport,
      this.localTransport,
      this.wsTransport,
      this.nodeTransport,
    ]);

    // --- Routing ---
    const localPeerId = this.getLocalPeerId();
    const proximityTable = new PeerProximityTable();
    this.router = new SocialGraphRouter(localPeerId, proximityTable);

    // --- Relay ---
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
    this.sybilManager = new SybilManager(localPeerId);

    // --- Cluster ---
    if (config.config?.clusterEnabled === true) {
      this.cluster = new DeviceCluster(
        this.identity.getPublicKey(),
        localPeerId,
      );
    }

    // --- Session manager ---
    this.sessionManager = new SessionManager(
      this.identity,
      this.peerCache,
      this.storage,
      (packet, peerId) => this.routeAndSend(packet, peerId),
      (peerId) => this.onContactEstablished(peerId),
      config.namespace,
      config.node ?? 'mesh',
      this.namespaceManager.getNamespaceId(),
    );

    // --- Message handler ---
    this.messageHandler = new MessageHandler(
      this.sessionManager,
      this.storage,
      () => this.getLocalPeerId(),
      config.onMessage ?? null,
      config.onMessageStatus ?? null,
      (peerId, payload) => this.sendControl(peerId, payload),
      this.cluster,
      (ctrl, fromPeerId) => this.handleSybilControl(ctrl, fromPeerId),
      () => this.sessionManager.scheduleReestablishment(),
      (groupId, groupSenderId, ciphertext) => {
        try {
          const plaintext = this.groupManager.decryptFromGroup(groupId, groupSenderId, ciphertext);
          return { plaintext };
        } catch {
          return null;
        }
      },
    );

    this.onPresenceHandler = config.onPresence ?? null;
    this.onTypingHandler = config.onTyping ?? null;
    this.onContactRequestHandler = config.onContactRequest ?? null;
    this.onGroupInviteHandler = config.onGroupInvite ?? null;
  }

  // ================================================================
  // Initialization
  // ================================================================

  static async init(config: MeshWhisperConfig): Promise<MeshWhisper> {
    if (MeshWhisper._instance) {
      await MeshWhisper._instance.shutdown();
    }

    const isBrowser =
      typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
    const isNode =
      typeof process !== 'undefined' && !!process.versions?.node;
    // React Native: WebSocket is available globally but neither browser APIs
    // nor Node.js process are present. Behaves like browser transport-wise
    // but requires an explicit storage backend (no IndexedDB).
    const isReactNative = !isBrowser && !isNode;

    // Storage
    let storage: StorageBackend | null = config.storage ?? null;
    if (!storage && isBrowser) {
      const { IDBStorage } = await import('../persistence/idb-storage.js');
      storage = new IDBStorage(config.namespace);
    }

    // Identity
    let identity: LocalIdentity;
    if (storage) {
      const savedKey = await storage.get('identity');
      if (savedKey) {
        identity = LocalIdentity.fromPrivateKey(hexToUint8Array(savedKey));
      } else {
        identity = LocalIdentity.create();
        await storage.set('identity', uint8ArrayToHex(identity.getEdPrivateKey()));
      }
    } else {
      identity = LocalIdentity.create();
    }

    // Relay URL
    const nodeConfig = config.node ?? 'mesh';
    const nodeUrls = Array.isArray(nodeConfig) ? nodeConfig : [nodeConfig];
    const primaryNodeUrl = nodeUrls[0];

    // Transports
    let wsTransport: MWTransport;
    let localTransport: MWTransport;
    let nodeTransport: MWTransport;

    // eslint-disable-next-line prefer-const -- definite assignment; closures below capture it before it's assigned
    let instance!: MeshWhisper;
    const getDestHashes = (): string[] => instance.getCurrentDestHashes();
    const onNodeStatus = (status: 'connected' | 'disconnected'): void => {
      instance.nodeConnected = status === 'connected';
      config.onConnectionStatus?.(status);
      if (status === 'connected') {
        instance.flushOutboundQueue().catch(() => {});
        // On first connection after startup, re-establish any sessions that
        // didn't survive the restart. Done here (not in start()) so the node
        // transport is actually live when we try to send handshake packets.
        if (!instance.startupReinitiationDone) {
          instance.startupReinitiationDone = true;
          const contacts = instance.permissionManager.getContacts();
          if (contacts.length > 0) {
            instance.sessionManager.reinitiateSessionsOnStartup(contacts).catch(() => {});
          }
        }
      }
    };

    if (isBrowser || isReactNative) {
      const [{ NoOpTransport }, { BrowserTransport }] = await Promise.all([
        import('../transport/noop/index.js'),
        import('../transport/browser/index.js'),
      ]);
      wsTransport = new NoOpTransport('internet');
      localTransport = new NoOpTransport('local_net');
      nodeTransport = new BrowserTransport(primaryNodeUrl, getDestHashes, config.push, onNodeStatus);
    } else {
      const [{ WebSocketTransport }, { LocalTransport }, { NodeTransport }] =
        await Promise.all([
          import('../transport/websocket/index.js'),
          import('../transport/local/index.js'),
          import('../transport/node/index.js'),
        ]);
      const deviceId = randomBytes(16);
      wsTransport = new WebSocketTransport();
      localTransport = new LocalTransport(deviceId);
      nodeTransport = new NodeTransport(primaryNodeUrl, getDestHashes, config.push, onNodeStatus);
    }

    instance = new MeshWhisper(config, identity, storage, wsTransport, localTransport, nodeTransport);
    MeshWhisper._instance = instance;
    await instance.start();
    return instance;
  }

  static get instance(): MeshWhisper {
    if (!MeshWhisper._instance) {
      throw new Error('MeshWhisper has not been initialized. Call MeshWhisper.init() first.');
    }
    return MeshWhisper._instance;
  }

  // ================================================================
  // Lifecycle
  // ================================================================

  private async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    if (this.storage) {
      await this.loadPersistedState();
    }

    this.negotiator.onReceive((packet, source, bearer) => {
      this.handleIncomingPacket(packet, source, bearer);
    });

    await this.sessionManager.initSignedPreKey();

    const startResults = await Promise.allSettled([
      this.wsTransport.start(),
      this.localTransport.start(),
      this.p2pTransport.start(),
      this.nodeTransport?.start() ?? Promise.resolve(),
    ]);

    const transportTypes: BearerType[] = ['internet', 'local_net', 'platform_p2p', 'internet'];
    for (let i = 0; i < startResults.length; i++) {
      const available = startResults[i]!.status === 'fulfilled';
      for (const handler of this.transportChangedHandlers) {
        try { handler({ type: transportTypes[i]!, available }); } catch { /* swallow */ }
      }
    }

    const bundle = this.sessionManager.getOrCreatePreKeyBundle();
    this.sessionManager.publishPreKeyBundle(bundle, this.config.username).catch(() => {});

    this.chaffGenerator.onChaffGenerated((packet: Packet) => {
      this.negotiator.broadcast(packet).catch(() => {});
    });
    this.chaffGenerator.start();

    this.relayStore.startPruneInterval();

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

    this.ephemeralRotationTimer = setInterval(() => {
      this.identity.rotateEphemeralId();
    }, 10 * 60 * 1000);
    if (typeof this.ephemeralRotationTimer === 'object' && 'unref' in this.ephemeralRotationTimer) {
      (this.ephemeralRotationTimer as NodeJS.Timeout).unref();
    }

    // Broadcast our relay reputation proof to all connected peers every hour.
    // This lets peers calibrate how much they trust us as a relay.
    this.reputationBroadcastTimer = setInterval(() => {
      this.broadcastReputationProof();
    }, 60 * 60 * 1000);
    if (typeof this.reputationBroadcastTimer === 'object' && 'unref' in this.reputationBroadcastTimer) {
      (this.reputationBroadcastTimer as NodeJS.Timeout).unref();
    }
  }

  async shutdown(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.storage) {
      await this.persistContacts();
      await this.persistPeers();
      await this.messageHandler.persistSeenIds();
    }

    this.chaffGenerator.stop();
    this.relayStore.stopPruneInterval();
    if (this.cluster) this.cluster.stop();

    if (this.ephemeralRotationTimer) {
      clearInterval(this.ephemeralRotationTimer);
      this.ephemeralRotationTimer = null;
    }
    if (this.reputationBroadcastTimer) {
      clearInterval(this.reputationBroadcastTimer);
      this.reputationBroadcastTimer = null;
    }

    await Promise.allSettled([
      this.wsTransport.stop(),
      this.localTransport.stop(),
      this.p2pTransport.stop(),
      this.nodeTransport?.stop() ?? Promise.resolve(),
    ]);

    MeshWhisper._instance = null;
  }

  // ================================================================
  // Public API — Messaging
  // ================================================================

  static async send(recipientId: string, payload: Uint8Array, options?: SendOptions): Promise<void> {
    return MeshWhisper.instance.sendMessage(recipientId, payload, options);
  }

  async sendMessage(recipientId: string, payload: Uint8Array, options?: SendOptions): Promise<void> {
    this.assertRunning();

    if (!this.nodeConnected) {
      this.outboundQueue.push({ recipientId, payload: payload.slice(), options });
      return;
    }

    const canSend = await this.permissionManager.canSendTo(recipientId);
    if (!canSend) {
      const err = new Error(`Permission denied: cannot send to ${recipientId}`);
      this.fireError(err);
      throw err;
    }

    await this.sessionManager.ensureSession(recipientId);

    const session = this.sessionManager.getSession(recipientId);
    if (!session) {
      const err = new Error(`Failed to establish session with ${recipientId}`);
      this.fireError(err);
      throw err;
    }

    const messageId = generateMessageId();
    const envelope = {
      id: messageId,
      senderId: this.getLocalPeerId(),
      recipientId,
      payload: Array.from(payload),
      timestamp: Date.now(),
      urgency: options?.urgency ?? 'normal',
      expiry: options?.expiry,
    };

    const envelopeBytes = new TextEncoder().encode(JSON.stringify(envelope));
    const compressed = compressPayload(envelopeBytes);
    const { state: newState, header, ciphertext } = ratchetEncrypt(session, compressed);
    this.sessionManager.setSession(recipientId, newState);

    const headerBytes = serializeRatchetHeader(header);
    const fullPayload = concat(headerBytes, ciphertext);

    const recipientPublicKey = this.peerCache.getPeerPublicKey(recipientId);
    if (!recipientPublicKey) throw new Error(`No public key for recipient ${recipientId}`);

    const destHash = deriveDestHash(this.namespaceManager.getNamespaceId(), recipientPublicKey, getCurrentEpochHour());
    const senderEphId = this.identity.generateEphemeralId();
    const packet = createDataPacket(destHash, senderEphId, fullPayload);

    const burst = this.chaffGenerator.camouflageRealMessage(packet);
    for (const p of burst) {
      await this.routeAndSend(p, recipientId);
    }

    const isControl = isControlPayload(payload);
    if (!isControl) {
      const expiresAt = options?.expiry ? envelope.timestamp + options.expiry * 1000 : undefined;
      await this.messageHandler.saveMessage({
        id: messageId,
        conversationId: recipientId,
        senderId: this.getLocalPeerId(),
        recipientId,
        payload: Array.from(payload),
        timestamp: envelope.timestamp,
        direction: 'outbound',
        status: 'sent',
        expiresAt,
      });
    }
  }

  /** Like sendMessage but skips the outbound persistence step. Used by sendToGroup
   *  which manages its own storage under the group conversation ID. */
  private async sendMessageRaw(recipientId: string, payload: Uint8Array): Promise<void> {
    await this.sessionManager.ensureSession(recipientId);
    const session = this.sessionManager.getSession(recipientId);
    if (!session) throw new Error(`No session for ${recipientId}`);

    const envelope = {
      id: generateMessageId(),
      senderId: this.getLocalPeerId(),
      recipientId,
      payload: Array.from(payload),
      timestamp: Date.now(),
      urgency: 'normal',
    };

    const envelopeBytes = new TextEncoder().encode(JSON.stringify(envelope));
    const compressed = compressPayload(envelopeBytes);
    const { state: newState, header, ciphertext } = ratchetEncrypt(session, compressed);
    this.sessionManager.setSession(recipientId, newState);

    const headerBytes = serializeRatchetHeader(header);
    const fullPayload = concat(headerBytes, ciphertext);

    const recipientPublicKey = this.peerCache.getPeerPublicKey(recipientId);
    if (!recipientPublicKey) throw new Error(`No public key for recipient ${recipientId}`);

    const destHash = deriveDestHash(this.namespaceManager.getNamespaceId(), recipientPublicKey, getCurrentEpochHour());
    const senderEphId = this.identity.generateEphemeralId();
    const packet = createDataPacket(destHash, senderEphId, fullPayload);

    const burst = this.chaffGenerator.camouflageRealMessage(packet);
    for (const p of burst) {
      await this.routeAndSend(p, recipientId);
    }
  }

  // ================================================================
  // Public API — Media
  // ================================================================

  static async sendMedia(recipientId: string, data: Uint8Array, options?: MediaSendOptions): Promise<void> {
    return MeshWhisper.instance.sendMediaMessage(recipientId, data, options);
  }

  async sendMediaMessage(recipientId: string, data: Uint8Array, options?: MediaSendOptions): Promise<void> {
    this.assertRunning();
    const mediaKey = randomBytes(32);
    const { ciphertext, nonce, tag } = encrypt(data, mediaKey);
    const encryptedBlob = concat(nonce, tag, ciphertext);

    let url: string;
    if (options?.upload) {
      url = await options.upload(encryptedBlob);
    } else {
      url = await this.uploadMediaToNode(encryptedBlob);
    }

    const mediaMsg: MediaMessage = {
      url,
      key: uint8ArrayToBase64(mediaKey),
      ...(options?.mimeType ? { mimeType: options.mimeType } : {}),
    };
    const pointer = new TextEncoder().encode(JSON.stringify({ __mw_media: true, ...mediaMsg }));
    await this.sendMessage(recipientId, pointer, options);
  }

  static async downloadMedia(message: Message): Promise<Uint8Array | null> {
    return MeshWhisper.instance.downloadMediaMessage(message);
  }

  async downloadMediaMessage(message: Message): Promise<Uint8Array | null> {
    let parsed: { __mw_media?: boolean; url?: string; key?: string; mimeType?: string };
    try {
      const text = new TextDecoder().decode(new Uint8Array(message.payload));
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (!parsed.__mw_media || !parsed.url || !parsed.key) return null;

    const mediaKey = base64ToUint8Array(parsed.key);
    const response = await fetch(parsed.url);
    if (!response.ok) throw new Error(`Media fetch failed: ${response.status}`);
    const blob = new Uint8Array(await response.arrayBuffer());

    const nonce = blob.slice(0, 12);
    const tag = blob.slice(12, 28);
    const ciphertext = blob.slice(28);
    return decrypt({ nonce, tag, ciphertext }, mediaKey);
  }

  private async uploadMediaToNode(encryptedBlob: Uint8Array): Promise<string> {
    const nodeConfig = this.config.node ?? 'mesh';
    const nodeUrl = Array.isArray(nodeConfig) ? nodeConfig[0] : nodeConfig;
    const httpUrl = nodeUrl === 'mesh'
      ? 'https://relay.meshwhisper.io/media'
      : nodeUrl!.replace(/^wss?:\/\//, (m) => m === 'wss://' ? 'https://' : 'http://') + '/media';

    const response = await fetch(httpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: encryptedBlob.buffer as ArrayBuffer,
    });
    if (!response.ok) throw new Error(`Media upload failed: ${response.status}`);
    const json = await response.json() as { url?: string };
    if (!json.url) throw new Error('Media upload: Node returned no URL');
    return json.url;
  }

  // ================================================================
  // Public API — Groups
  // ================================================================

  static createGroup(options: CreateGroupOptions): GroupHandle {
    return MeshWhisper.instance.createGroupInstance(options);
  }

  createGroupInstance(options: CreateGroupOptions): GroupHandle {
    this.assertRunning();
    const group = this.groupManager.createGroup(options.name, options.members ?? [], options.permissionModel ?? 'open');

    // Send an invite to each initial member over their pairwise encrypted channel
    const members = this.groupManager.getMembers(group.id);
    const senderKeysRecord: Record<string, number[]> = {};
    for (const m of members) {
      const key = this.groupManager.getSenderKey(group.id, m.id);
      if (key) senderKeysRecord[m.id] = Array.from(key);
    }
    for (const m of members) {
      if (m.id === this.getLocalPeerId()) continue;
      this.sendControl(m.id, {
        __mw_ctrl: 'group_invite',
        groupInvite: {
          groupId: group.id,
          groupName: group.name,
          invitedBy: this.getLocalPeerId(),
          members: members.map((mem) => mem.id),
          senderKeys: senderKeysRecord,
        },
      });
    }

    return new GroupHandle(group, this);
  }

  static getGroup(groupId: string): GroupHandle | null {
    return MeshWhisper.instance.getGroupInstance(groupId);
  }

  getGroupInstance(groupId: string): GroupHandle | null {
    const group = this.groupManager.getGroup(groupId);
    if (!group) return null;
    return new GroupHandle(group, this);
  }

  static getGroups(): GroupHandle[] {
    return MeshWhisper.instance.getGroupsInstance();
  }

  getGroupsInstance(): GroupHandle[] {
    return this.groupManager.getGroups().map(g => new GroupHandle(g, this));
  }

  /** Returns the peer IDs of all pending (not yet accepted) group invites. */
  static getPendingGroupInvites(): Array<{ groupId: string; groupName: string; invitedBy: string; members: string[] }> {
    return MeshWhisper.instance.getPendingGroupInvitesInstance();
  }

  getPendingGroupInvitesInstance(): Array<{ groupId: string; groupName: string; invitedBy: string; members: string[] }> {
    return [...this.pendingGroupInvites.values()].map((inv) => ({
      groupId: inv.groupId,
      groupName: inv.groupName,
      invitedBy: inv.invitedBy,
      members: inv.members,
    }));
  }

  /** Returns the local peer's hex-encoded Ed25519 public key (their "address"). */
  static getLocalPeerId(): string {
    return MeshWhisper.instance.getLocalPeerId();
  }

  getGroup(groupId: string): GroupHandle | null {
    return this.getGroupInstance(groupId);
  }

  getGroups(): GroupHandle[] {
    return this.getGroupsInstance();
  }

  async sendToGroup(groupId: string, payload: Uint8Array): Promise<void> {
    this.assertRunning();
    const { ciphertext, senderId } = this.groupManager.encryptForGroup(groupId, payload);
    const members = this.groupManager.getMembers(groupId);

    // Wrap in a group envelope so receivers can identify it and decrypt with
    // the sender key. Delivered pairwise (Double Ratchet) to each member.
    // The GROUP_ENVELOPE_MARKER prefix lets MessageHandler detect and route it.
    const envelopePayload = new TextEncoder().encode(
      JSON.stringify({ __mw_grp: groupId, sid: senderId, d: Array.from(ciphertext) }),
    );

    // Store the outbound message once under the group conversation ID.
    const messageId = this.messageHandler.createMessageId();
    const now = Date.now();
    await this.messageHandler.saveMessage({
      id: messageId,
      conversationId: groupId,
      senderId: this.getLocalPeerId(),
      recipientId: groupId,
      payload: Array.from(payload),
      timestamp: now,
      direction: 'outbound',
      status: 'sent',
      groupId,
      groupSenderId: this.getLocalPeerId(),
    });

    await Promise.allSettled(
      members
        .filter((m) => m.id !== this.getLocalPeerId())
        .map(async (m) => {
          try {
            // Pass the group envelope as a raw payload, skipping the auto-save
            // in sendMessage (which would store it under m.id, not groupId).
            await this.sendMessageRaw(m.id, envelopePayload);
          } catch {
            // Best effort per member
          }
        }),
    );
  }

  // ================================================================
  // Public API — Group invites
  // ================================================================

  /**
   * Accepts a pending group invite. Joins the group and makes it available
   * for messaging. The invite must have been received via `onGroupInvite`.
   */
  static acceptGroupInvite(groupId: string): void {
    MeshWhisper.instance.acceptGroupInviteInstance(groupId);
  }

  acceptGroupInviteInstance(groupId: string): void {
    this.assertRunning();
    const invite = this.pendingGroupInvites.get(groupId);
    if (!invite) throw new Error(`No pending invite for group ${groupId}`);
    this.groupManager.joinGroup(groupId, invite);
    this.pendingGroupInvites.delete(groupId);
  }

  /** Discards a pending group invite without joining. */
  static declineGroupInvite(groupId: string): void {
    MeshWhisper.instance.pendingGroupInvites.delete(groupId);
  }

  // ================================================================
  // Public API — Identity backup / restore
  // ================================================================

  static async exportIdentity(passphrase: string): Promise<string> {
    return MeshWhisper.instance.exportIdentityInstance(passphrase);
  }

  async exportIdentityInstance(passphrase: string): Promise<string> {
    this.assertRunning();
    const privateKey = this.identity.getEdPrivateKey();
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));

    const baseKey = await globalThis.crypto.subtle.importKey(
      'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'],
    );
    const aesKey = await globalThis.crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations: 100_000, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt'],
    );
    const ciphertext = new Uint8Array(
      await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, privateKey.buffer as ArrayBuffer),
    );

    return btoa(JSON.stringify({
      v: 1,
      salt: uint8ArrayToHex(salt),
      iv: uint8ArrayToHex(iv),
      ciphertext: uint8ArrayToHex(ciphertext),
    }));
  }

  static async importIdentity(data: string, passphrase: string): Promise<void> {
    let parsed: { v: number; salt: string; iv: string; ciphertext: string };
    try {
      parsed = JSON.parse(atob(data));
    } catch {
      throw new Error('importIdentity: invalid backup format');
    }
    if (parsed.v !== 1) throw new Error(`importIdentity: unknown version ${parsed.v}`);

    const salt = hexToUint8Array(parsed.salt);
    const iv = hexToUint8Array(parsed.iv);
    const ciphertext = hexToUint8Array(parsed.ciphertext);

    const baseKey = await globalThis.crypto.subtle.importKey(
      'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'],
    );
    const aesKey = await globalThis.crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations: 100_000, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );

    let privateKeyBytes: Uint8Array;
    try {
      privateKeyBytes = new Uint8Array(
        await globalThis.crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer }, aesKey, ciphertext.buffer as ArrayBuffer,
        ),
      );
    } catch {
      throw new Error('importIdentity: wrong passphrase or corrupt backup');
    }

    if (privateKeyBytes.length !== 32) throw new Error('importIdentity: decrypted key has unexpected length');

    const storage = MeshWhisper._instance?.storage;
    if (storage) await storage.set('identity', uint8ArrayToHex(privateKeyBytes));
  }

  // ================================================================
  // Public API — Contacts
  // ================================================================

  static generateContactQR(): string {
    return MeshWhisper.instance.generateContactQRInstance();
  }

  generateContactQRInstance(): string {
    this.assertRunning();
    const bundle = this.sessionManager.getOrCreatePreKeyBundle();
    this.sessionManager.publishPreKeyBundle(bundle, this.config.username).catch(() => {});

    const serialized = serializePreKeyBundle(bundle);
    const peerIdBytes = new TextEncoder().encode(this.getLocalPeerId());
    const lenBuf = new Uint8Array(2);
    new DataView(lenBuf.buffer).setUint16(0, peerIdBytes.length, false);
    const qrPayload = concat(lenBuf, peerIdBytes, serialized);
    return uint8ArrayToBase64(qrPayload);
  }

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

    this.sessionManager.setBundle(peerId, bundle);

    if (this.config.permissionModel === 'mutual') {
      this.permissionManager.confirmMutualContact(peerId);
    } else {
      this.permissionManager.addContact(peerId);
    }

    this.peerCache.addPeer(peerId, edwardsToMontgomeryPub(bundle.identityKey));
    await this.sessionManager.initiateHandshake(peerId, bundle);
  }

  /**
   * Look up a peer's pre-key bundle from the relay directory and initiate
   * an X3DH session with them. Returns true if the bundle was found and the
   * handshake was initiated, false if the peer has not published a bundle.
   *
   * The `publicKey` is the peer's hex-encoded Ed25519 identity public key —
   * the same value returned by `getLocalPeerId()` on their device.
   *
   * ```ts
   * const found = await MeshWhisper.addContactByKey('a1b2c3...');
   * ```
   */
  static async addContactByKey(publicKey: string): Promise<string | null> {
    return MeshWhisper.instance.addContactByKeyInstance(publicKey);
  }

  async addContactByKeyInstance(query: string): Promise<string | null> {
    this.assertRunning();
    const result = await this.sessionManager.lookupPreKeyBundle(query);
    if (!result) return null;

    const { bundle, publicKey } = result;
    const edPubBytes = hexToUint8Array(publicKey);
    const x25519PubBytes = edwardsToMontgomeryPub(edPubBytes);
    const peerId = uint8ArrayToHex(x25519PubBytes);

    this.sessionManager.setBundle(peerId, bundle);
    this.peerCache.addPeer(peerId, x25519PubBytes);
    this.storage?.set(`peers/${peerId}`, uint8ArrayToHex(x25519PubBytes)).catch(() => {});

    if (this.config.permissionModel === 'mutual') {
      this.permissionManager.confirmMutualContact(peerId);
    } else {
      this.permissionManager.addContact(peerId);
    }
    this.persistContacts().catch(() => {});

    // Only initiate a new handshake if no session exists. When the remote peer
    // already contacted us first (they sent an x3dh_init), we have a live session
    // and sending a second x3dh_init would overwrite both sides' ratchet state,
    // leaving the initiating peer with a receiver session that has no sending chain.
    if (!this.sessionManager.hasSession(peerId)) {
      await this.sessionManager.initiateHandshake(peerId, bundle);
    }
    return peerId;
  }

  static async introduceContacts(peerA: string, peerB: string): Promise<void> {
    return MeshWhisper.instance.introduceContactsInstance(peerA, peerB);
  }

  async introduceContactsInstance(peerA: string, peerB: string): Promise<void> {
    this.assertRunning();
    if (!this.permissionManager.isContact(peerA)) throw new Error(`${peerA} is not a contact`);
    if (!this.permissionManager.isContact(peerB)) throw new Error(`${peerB} is not a contact`);

    const pubKeyA = this.peerCache.getPeerPublicKey(peerA);
    const pubKeyB = this.peerCache.getPeerPublicKey(peerB);
    const myId = this.getLocalPeerId();

    if (pubKeyA && pubKeyB) {
      const usernameA = await this.resolveUsername(peerA);
      const usernameB = await this.resolveUsername(peerB);
      await Promise.allSettled([
        this.sendControl(peerA, {
          __mw_ctrl: 'contact_request',
          contactRequest: {
            introducedPeerId: peerB,
            introducedPublicKey: Array.from(pubKeyB),
            introducedBy: myId,
            ...(usernameB ? { username: usernameB } : {}),
          },
        }),
        this.sendControl(peerB, {
          __mw_ctrl: 'contact_request',
          contactRequest: {
            introducedPeerId: peerA,
            introducedPublicKey: Array.from(pubKeyA),
            introducedBy: myId,
            ...(usernameA ? { username: usernameA } : {}),
          },
        }),
      ]);
    }
  }

  // ================================================================
  // Public API — Contact management
  // ================================================================

  /** Returns all peer IDs that have been added as contacts. */
  static getContacts(): string[] {
    return MeshWhisper.instance.permissionManager.getContacts();
  }

  /** Removes a contact. The session is preserved but the peer loses contact
   *  privileges (e.g. in 'mutual' permission model they can no longer send). */
  static removeContact(peerId: string): void {
    MeshWhisper.instance.permissionManager.removeContact(peerId);
    MeshWhisper.instance.storage?.set(
      'contacts',
      JSON.stringify(MeshWhisper.instance.permissionManager.getContacts()),
    ).catch(() => {});
  }

  /** Blocks a peer. Blocked peers' packets are dropped on arrival. */
  static blockPeer(peerId: string): void {
    const inst = MeshWhisper.instance;
    inst.permissionManager.blockPeer(peerId);
    inst.storage?.set('blocked', JSON.stringify(inst.permissionManager.getBlocked())).catch(() => {});
  }

  /** Unblocks a previously blocked peer. */
  static unblockPeer(peerId: string): void {
    const inst = MeshWhisper.instance;
    inst.permissionManager.unblockPeer(peerId);
    inst.storage?.set('blocked', JSON.stringify(inst.permissionManager.getBlocked())).catch(() => {});
  }

  // ================================================================
  // Public API — Presence
  // ================================================================

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

  static onTransportChanged(handler: (event: TransportChangedEvent) => void): void {
    MeshWhisper.instance.onTransportChangedInstance(handler);
  }

  onTransportChangedInstance(handler: (event: TransportChangedEvent) => void): void {
    this.transportChangedHandlers.add(handler);
  }

  offTransportChanged(handler: (event: TransportChangedEvent) => void): void {
    this.transportChangedHandlers.delete(handler);
  }

  // ================================================================
  // Public API — Message History
  // ================================================================

  static async getMessages(peerId: string, options?: { limit?: number; before?: number }): Promise<StoredMessage[]> {
    return MeshWhisper.instance.getMessagesInstance(peerId, options);
  }

  async getMessagesInstance(peerId: string, options?: { limit?: number; before?: number }): Promise<StoredMessage[]> {
    return this.messageHandler.getMessages(peerId, options);
  }

  static async getConversations(): Promise<Conversation[]> {
    return MeshWhisper.instance.getConversationsInstance();
  }

  async getConversationsInstance(): Promise<Conversation[]> {
    return this.messageHandler.getConversations();
  }

  static async markRead(messageId: string, peerId: string): Promise<void> {
    return MeshWhisper.instance.markReadInstance(messageId, peerId);
  }

  async markReadInstance(messageId: string, peerId: string): Promise<void> {
    this.assertRunning();
    await this.messageHandler.updateMessageStatus(messageId, peerId, 'read');
    this.sendControl(peerId, { __mw_ctrl: 'read', messageId });
  }

  /**
   * Deletes a message locally and sends a delete request to the other party.
   * `conversationId` is the peer ID for DMs or the group ID for group messages.
   */
  static async deleteMessage(messageId: string, conversationId: string): Promise<void> {
    return MeshWhisper.instance.deleteMessageInstance(messageId, conversationId);
  }

  async deleteMessageInstance(messageId: string, conversationId: string): Promise<void> {
    this.assertRunning();
    await this.messageHandler.removeMessage(messageId, conversationId);
    // Best-effort remote delete — works for DMs; for groups we'd need to fan out
    if (this.permissionManager.isContact(conversationId)) {
      this.sendControl(conversationId, { __mw_ctrl: 'delete', messageId });
    } else {
      // Group: send to all members
      const members = this.groupManager.getMembers(conversationId);
      for (const m of members) {
        if (m.id !== this.getLocalPeerId()) {
          this.sendControl(m.id, { __mw_ctrl: 'delete', messageId });
        }
      }
    }
  }

  /** Removes a contact and wipes all local data for that conversation. */
  static async deleteConversation(peerId: string): Promise<void> {
    return MeshWhisper.instance.deleteConversationInstance(peerId);
  }

  async deleteConversationInstance(peerId: string): Promise<void> {
    this.permissionManager.removeContact(peerId);
    this.peerCache.removePeer(peerId);
    await Promise.all([
      this.storage?.set('contacts', JSON.stringify(this.permissionManager.getContacts())),
      this.storage?.delete(`peers/${peerId}`),
      this.storage?.delete(`messages/${peerId}`),
      this.storage?.delete(`sessions/${peerId}`),
    ].filter(Boolean));
  }

  /** Requests any queued messages from the relay. Call when the app returns to the foreground. */
  static pull(): void {
    MeshWhisper.instance.pullInstance();
  }

  pullInstance(): void {
    (this.nodeTransport as unknown as { pull?: () => void } | null)?.pull?.();
  }

  static sendTyping(peerId: string): void {
    MeshWhisper.instance.sendControl(peerId, { __mw_ctrl: 'typing_start' });
  }

  static stopTyping(peerId: string): void {
    MeshWhisper.instance.sendControl(peerId, { __mw_ctrl: 'typing_stop' });
  }

  // ================================================================
  // Public API — Key Verification
  // ================================================================

  /**
   * Returns the safety number for the session with `peerId`.
   *
   * A safety number is a 60-digit string (12 groups of 5 digits) derived
   * from both parties' long-term Ed25519 identity keys. It is identical on
   * both sides — Alice and Bob compute the same number independently.
   *
   * Show this in the UI and ask the user to compare it with their contact
   * out-of-band (in person, over a phone call, or via QR code). A match
   * confirms the session has not been intercepted via the relay directory.
   *
   * Throws if no identity key is known for the peer yet (session not established).
   */
  static getSafetyNumber(peerId: string): string {
    return MeshWhisper.instance.getSafetyNumberInstance(peerId);
  }

  getSafetyNumberInstance(peerId: string): string {
    const localKey = this.identity.getEdPublicKey();
    const peerKey = this.sessionManager.getPeerEdKey(peerId);
    if (!peerKey) {
      throw new Error(`No identity key known for peer ${peerId} — session not yet established`);
    }
    return computeFingerprint(localKey, peerKey);
  }

  /**
   * Returns true if `candidate` matches the expected safety number for `peerId`.
   * Tolerates extra whitespace, dashes, or other separators.
   */
  static verifySafetyNumber(peerId: string, candidate: string): boolean {
    return MeshWhisper.instance.verifySafetyNumberInstance(peerId, candidate);
  }

  verifySafetyNumberInstance(peerId: string, candidate: string): boolean {
    const localKey = this.identity.getEdPublicKey();
    const peerKey = this.sessionManager.getPeerEdKey(peerId);
    if (!peerKey) return false;
    return verifySafetyNumber(localKey, peerKey, candidate);
  }

  // ================================================================
  // Public API — Accessors
  // ================================================================

  getLocalPeerId(): string {
    return uint8ArrayToHex(this.identity.getPublicKey());
  }

  getPublicKey(): Uint8Array {
    return this.identity.getPublicKey();
  }

  getNamespaceId(): Uint8Array {
    return this.namespaceManager.getNamespaceId();
  }

  isRunning(): boolean {
    return this.running;
  }

  static registerPlatformBridge(bridge: PlatformP2PBridge): void {
    registerPlatformBridge(bridge);
  }

  // ================================================================
  // Internal — Incoming Packet Handling
  // ================================================================

  private handleIncomingPacket(packet: Packet, source: string, bearer: BearerType): void {
    if (!this.running) return;

    this.updatePresence(source, 'online');
    this.reciprocityLedger.recordPeerRelayedForUs(source, packet.encryptedPayload.length);

    if (packet.flags === PacketFlags.CHAFF) return;

    const isForUs = this.namespaceManager.isMessageForUs(packet.destHash, this.identity.getPublicKey());
    if (isForUs) {
      this.processLocalPacket(packet, source);
    } else {
      this.maybeRelay(packet, source, bearer);
    }
  }

  private processLocalPacket(packet: Packet, source: string): void {
    switch (packet.flags) {
      case PacketFlags.HANDSHAKE:
        this.sessionManager.handleHandshakePacket(packet.encryptedPayload);
        break;
      case PacketFlags.DATA:
        this.messageHandler.handleDataPacket(packet);
        break;
      case PacketFlags.ACK:
        break;
      case PacketFlags.ROUTE_REQUEST:
        this.handleRouteRequestPacket(packet, source);
        break;
      case PacketFlags.ROUTE_OFFER:
        this.handleRouteOfferPacket(packet);
        break;
    }
  }

  private handleRouteRequestPacket(packet: Packet, source: string): void {
    try {
      const request = JSON.parse(new TextDecoder().decode(packet.encryptedPayload));
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
        const offerPayload = new TextEncoder().encode(JSON.stringify(offer));
        const senderEphId = this.identity.generateEphemeralId();
        const offerPacket: Packet = {
          version: PROTOCOL_VERSION,
          flags: PacketFlags.ROUTE_OFFER,
          destHash: packet.destHash,
          senderEphemeralId: senderEphId,
          ttl: packet.ttl,
          payloadLength: offerPayload.length,
          encryptedPayload: offerPayload,
        };
        this.negotiator.send(offerPacket, source).catch(() => {});
      }
    } catch {
      // Malformed — drop
    }
  }

  private handleRouteOfferPacket(packet: Packet): void {
    try {
      const offer = JSON.parse(new TextDecoder().decode(packet.encryptedPayload));
      this.router.handleRouteOffer({
        requestId: new Uint8Array(offer.requestId),
        hopCount: offer.hopCount,
        estimatedLatency: offer.estimatedLatency,
        offeredBy: offer.offeredBy,
      });
    } catch {
      // Malformed — drop
    }
  }

  // ================================================================
  // Internal — Relay Logic
  // ================================================================

  private maybeRelay(packet: Packet, source: string, bearer: BearerType): void {
    // Only relay for local mesh bearers. Packets arriving from the Node relay
    // are already handled server-side — re-relaying them here would cause
    // unnecessary duplicate forwarding.
    if (bearer === 'internet') return;
    if (!this.router.shouldRelay(packet)) return;
    if (!this.reciprocityLedger.shouldRelay(source)) return;
    // Sybil check: only relay for peers whose trust score meets the floor.
    // Unknown peers score 0.5 (neutral) so they're not blocked.
    // Only peers that actively fail an entropy challenge score below the floor.
    if (this.sybilManager.getRelayTrustScore(source) < RELAY_TRUST_FLOOR) return;

    const forwarded = this.router.decrementTTL(packet);
    this.reciprocityLedger.recordRelayedForPeer(source, packet.encryptedPayload.length);

    const nextHop = this.router.getNextHop(packet.destHash);
    if (nextHop) {
      this.negotiator.send(forwarded, nextHop).catch(() => {
        this.relayManager.storeForDelivery(packet.destHash, packet.encryptedPayload, this.config.config?.storeTTL ?? 72);
      });
    } else {
      this.relayManager.storeForDelivery(packet.destHash, packet.encryptedPayload, this.config.config?.storeTTL ?? 72);
    }
  }

  // ================================================================
  // Internal — Routing & Sending
  // ================================================================

  private async routeAndSend(packet: Packet, recipientId: string): Promise<void> {
    try {
      await this.negotiator.send(packet, recipientId);
      return;
    } catch { /* fall through to routing */ }

    const nextHop = this.router.getNextHop(packet.destHash);
    if (nextHop) {
      try {
        await this.negotiator.send(packet, nextHop);
        return;
      } catch { /* fall through to store-and-forward */ }
    }

    this.relayManager.storeForDelivery(packet.destHash, packet.encryptedPayload, this.config.config?.storeTTL ?? 72);
  }

  // ================================================================
  // Internal — Presence
  // ================================================================

  private updatePresence(peerId: string, status: PresenceStatus): void {
    const now = Date.now();
    const previous = this.presenceRecords.get(peerId);
    const previousStatus = previous?.status ?? 'unknown';

    this.presenceRecords.set(peerId, { peerId, status, lastSeen: now });

    const peerPublicKey = this.peerCache.getPeerPublicKey(peerId);
    if (peerPublicKey) {
      const destHash = deriveDestHash(this.namespaceManager.getNamespaceId(), peerPublicKey, getCurrentEpochHour());
      const storedBlobs = this.relayManager.deliverStored(destHash);
      for (const blob of storedBlobs) {
        const storedPacket: Packet = {
          version: PROTOCOL_VERSION,
          flags: PacketFlags.DATA,
          destHash: blob.destHash,
          senderEphemeralId: new Uint8Array(16),
          ttl: 0,
          payloadLength: blob.encryptedPayload.length,
          encryptedPayload: blob.encryptedPayload,
        };
        this.negotiator.send(storedPacket, peerId).catch(() => {});
      }
    }

    if (status !== previousStatus && this.onPresenceHandler) {
      this.onPresenceHandler(peerId, status);
    }
  }

  // ================================================================
  // Internal — Contact establishment callback (from SessionManager)
  // ================================================================

  private onContactEstablished(peerId: string): void {
    this.permissionManager.addContact(peerId);
    this.storage?.set('contacts', JSON.stringify(this.permissionManager.getContacts())).catch(() => {});

    // peerId is the hex-encoded X25519 public key — add it to peerCache so
    // sendMessage can compute the dest hash. Persist immediately so it survives restarts.
    this.peerCache.addPeer(peerId, hexToUint8Array(peerId));
    this.storage?.set(`peers/${peerId}`, peerId).catch(() => {});

    // Issue an entropy challenge so we can assess whether this peer is a
    // real physical device. The result feeds into relay trust scoring.
    const { challengeData } = this.sybilManager.createChallenge(peerId);
    this.sendControl(peerId, { __mw_ctrl: 'entropy_challenge', challengeData });

    // Share our relay reputation proof so the peer can trust us as a relay.
    const proof = this.sybilManager.getLocalProof();
    if (proof) {
      this.sendControl(peerId, { __mw_ctrl: 'reputation_proof', reputationProof: proof });
    }
  }

  // ================================================================
  // Internal — Control messages
  // ================================================================

  private sendControl(peerId: string, payload: Record<string, unknown>): void {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    this.sendMessage(peerId, bytes, { urgency: 'background' }).catch(() => {});
  }

  // ================================================================
  // Internal — Sybil control message handling
  // ================================================================

  private handleSybilControl(ctrl: import('./utils.js').ControlMessage, fromPeerId: string): void {
    switch (ctrl.__mw_ctrl) {
      case 'entropy_challenge': {
        if (!ctrl.challengeData) return;
        const onChallenge = this.config.onEntropyChallenge;
        if (!onChallenge) return; // app hasn't provided a sensor callback — stay unverified

        const challenge = this.sybilManager.deserializeChallenge(ctrl.challengeData);
        onChallenge(fromPeerId, challenge.sensorType, challenge.durationMs)
          .then((sensorData) => {
            const { responseData } = this.sybilManager.createResponse(
              challenge,
              sensorData,
              this.identity.getEdPrivateKey(),
            );
            this.sendControl(fromPeerId, { __mw_ctrl: 'entropy_response', responseData });
          })
          .catch(() => {
            // Sensor collection failed — don't send a response; challenger marks us unverified
          });
        break;
      }

      case 'entropy_response': {
        if (!ctrl.responseData) return;
        const peerEdPubKey = this.getPeerEdPublicKey(fromPeerId);
        if (!peerEdPubKey) return;
        this.sybilManager.processEntropyResponse(ctrl.responseData, fromPeerId, peerEdPubKey);
        break;
      }

      case 'reputation_proof': {
        if (!ctrl.reputationProof) return;
        const peerEdPubKey = this.getPeerEdPublicKey(fromPeerId);
        if (!peerEdPubKey) return;
        this.sybilManager.acceptReputationProof(ctrl.reputationProof, fromPeerId, peerEdPubKey);
        break;
      }

      case 'typing_start':
        this.onTypingHandler?.(fromPeerId, true);
        break;

      case 'typing_stop':
        this.onTypingHandler?.(fromPeerId, false);
        break;

      case 'contact_request': {
        const cr = ctrl.contactRequest;
        if (!cr || !this.onContactRequestHandler) break;
        this.onContactRequestHandler(cr.introducedPeerId, cr.introducedBy, cr.username)
          ?.catch(() => {});
        break;
      }

      case 'group_invite': {
        const inv = ctrl.groupInvite;
        if (!inv) break;
        // Reconstruct senderKeys map
        const senderKeys = new Map<string, Uint8Array>();
        for (const [id, arr] of Object.entries(inv.senderKeys)) {
          senderKeys.set(id, new Uint8Array(arr));
        }
        const invite: import('../group/index.js').GroupInvite = {
          groupId: inv.groupId,
          groupName: inv.groupName,
          invitedBy: inv.invitedBy,
          senderKeys,
          members: inv.members,
        };
        this.pendingGroupInvites.set(inv.groupId, invite);
        this.onGroupInviteHandler?.(inv.groupId, inv.groupName, inv.invitedBy, inv.members)
          ?.catch(() => {});
        break;
      }
    }
  }

  /**
   * Regenerates our relay reputation proof from the current ledger state
   * and sends it to all contacts we have sessions with.
   */
  /** Resolves a peer's registered username from the relay directory, or undefined. */
  private async resolveUsername(peerId: string): Promise<string | undefined> {
    const edKey = this.sessionManager.getPeerEdKey(peerId);
    if (!edKey) return undefined;
    const result = await this.sessionManager.lookupPreKeyBundle(uint8ArrayToHex(edKey));
    return result?.username;
  }

  private broadcastReputationProof(): void {
    const proof = this.sybilManager.buildLocalProof(
      this.reciprocityLedger,
      this.identity.getEdPrivateKey(),
    );
    for (const contactId of this.permissionManager.getContacts()) {
      if (this.sessionManager.hasSession(contactId)) {
        this.sendControl(contactId, { __mw_ctrl: 'reputation_proof', reputationProof: proof });
      }
    }
  }

  /**
   * Returns a peer's Ed25519 public key from the peerPreKeyBundles cache.
   * Used to verify entropy responses and reputation proofs.
   */
  private getPeerEdPublicKey(peerId: string): Uint8Array | null {
    // getPeerEdKey covers both initiators (who have the full bundle) and
    // responders (who only stored the Ed key from the x3dh_init envelope).
    return this.sessionManager.getPeerEdKey(peerId);
  }

  // ================================================================
  // Internal — Persistence helpers
  // ================================================================

  private async loadPersistedState(): Promise<void> {
    if (!this.storage) return;

    await this.sessionManager.loadSessions();
    await this.messageHandler.loadSeenIds();
    await this.messageHandler.purgeExpiredMessages();

    // Peer public keys
    const peerKeys = await this.storage.keys('peers/');
    for (const key of peerKeys) {
      const hex = await this.storage.get(key);
      if (!hex) continue;
      const peerId = key.replace(/^peers\//, '');
      this.peerCache.addPeer(peerId, hexToUint8Array(hex));
    }

    // Contacts
    const contactsRaw = await this.storage.get('contacts');
    if (contactsRaw) {
      this.permissionManager.loadContacts(JSON.parse(contactsRaw) as string[]);
      // Rebuild peerCache from contacts — the X25519 peerId is the public key hex,
      // so we can restore it without a relay lookup even if peers/ keys are missing.
      for (const peerId of this.permissionManager.getContacts()) {
        if (!this.peerCache.getPeerPublicKey(peerId)) {
          this.peerCache.addPeer(peerId, hexToUint8Array(peerId));
        }
      }
    }

    // Blocked peers
    const blockedRaw = await this.storage.get('blocked');
    if (blockedRaw) {
      for (const peerId of JSON.parse(blockedRaw) as string[]) {
        this.permissionManager.blockPeer(peerId);
      }
    }
  }

  private async persistContacts(): Promise<void> {
    await this.storage?.set('contacts', JSON.stringify(this.permissionManager.getContacts()));
  }

  private async persistPeers(): Promise<void> {
    if (!this.storage) return;
    for (const { id, publicKey } of this.peerCache.getAllPeers()) {
      await this.storage.set(`peers/${id}`, uint8ArrayToHex(publicKey));
    }
  }

  // ================================================================
  // Internal — Offline queue flush
  // ================================================================

  private async flushOutboundQueue(): Promise<void> {
    while (this.outboundQueue.length > 0 && this.nodeConnected) {
      const item = this.outboundQueue.shift();
      if (!item) break;
      try {
        await this.sendMessage(item.recipientId, item.payload, item.options);
      } catch {
        // fireError already called by sendMessage for session/permission failures
        this.outboundQueue.unshift(item);
        break;
      }
    }
  }

  // ================================================================
  // Internal — Dest hashes (used by NodeTransport)
  // ================================================================

  private getCurrentDestHashes(): string[] {
    const xPub = this.identity.getPublicKey();
    const nsId = this.namespaceManager.getNamespaceId();
    const hour = getCurrentEpochHour();
    return [
      uint8ArrayToHex(deriveDestHash(nsId, xPub, hour)),
      uint8ArrayToHex(deriveDestHash(nsId, xPub, hour - 1)),
    ];
  }

  // ================================================================
  // Internal — Assertions
  // ================================================================

  private assertRunning(): void {
    if (!this.running) {
      throw new Error('MeshWhisper is not running. Call MeshWhisper.init() first.');
    }
  }

  private fireError(error: Error): void {
    if (this.config.onError) {
      try { this.config.onError(error); } catch { /* swallow handler throws */ }
    }
  }
}
