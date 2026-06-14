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
  UsernameTransferToken,
  DeviceLinkOffer,
} from '../types.js';
import { PacketFlags } from '../types.js';

import { edwardsToMontgomeryPub, ed25519 } from '@noble/curves/ed25519';
import {
  encrypt,
  decrypt,
  randomBytes,
  deriveDestHash,
  getCurrentEpochHour,
  concat,
  hash,
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
import type { RatchetState } from '../ratchet/index.js';
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
import { KeyedMutex } from './keyed-mutex.js';
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
import {
  deriveBackupKey as _deriveBackupKey,
  deriveArchiveToken,
  encryptArchive,
  decryptArchive,
  collectKv,
  mergeKv,
  uploadArchive,
  downloadArchive,
  MAX_ARCHIVE_BYTES,
  readTombstones,
  readDeviceAnnouncementSeen,
  writeDeviceAnnouncementSeen,
  readRevivals,
  addTombstone,
} from './archive.js';
export type { ArchivePayload } from './archive.js';

// ============================================================
// Username-transfer canonical message
//
// MUST match the bytes the relay reconstructs in
// `node/src/index.ts:canonicalTransferMessage`. Bumping the version
// tag is a wire-format break; coordinate both sides.
// ============================================================

function buildCanonicalTransferMessage(
  namespace: string,
  username: string,
  toPublicKey: string,
  expiresAt: number,
): Uint8Array {
  return new TextEncoder().encode(
    [
      'meshwhisper.username-transfer.v1',
      namespace,
      username,
      toPublicKey,
      String(expiresAt),
    ].join('\n'),
  );
}

// ============================================================
// Device-announcement canonical messages
//
// Both event types are signed by an accountKey (Ed25519). The signed
// bytes bind the account, the device, and the moment of the change so
// a replayed announcement can be detected (same signature ⇒ same
// payload ⇒ idempotent merge in PermissionManager).
// ============================================================

export function buildCanonicalDeviceAddedMessage(
  accountKey: string,
  newDeviceKey: string,
  addedAt: number,
): Uint8Array {
  return new TextEncoder().encode(
    ['meshwhisper.device-added.v1', accountKey, newDeviceKey, String(addedAt)].join('\n'),
  );
}

export function buildCanonicalDeviceRevokedMessage(
  accountKey: string,
  revokedDeviceKey: string,
  revokedAt: number,
): Uint8Array {
  return new TextEncoder().encode(
    ['meshwhisper.device-revoked.v1', accountKey, revokedDeviceKey, String(revokedAt)].join('\n'),
  );
}

/**
 * Verifies the Ed25519 signature on a device announcement against the
 * declared accountKey. Returns true only if the signature is well-formed
 * AND signs the exact canonical bytes for this (accountKey, deviceKey,
 * eventAt) tuple under the named event kind. The caller is responsible
 * for trust binding (i.e. the sender is the account in question) and
 * for replay protection.
 */
export function verifyDeviceAnnouncementSignature(
  kind: 'device_added' | 'device_revoked',
  announcement: { accountKey: string; deviceKey: string; eventAt: number; signature: string },
): boolean {
  if (typeof announcement.eventAt !== 'number' || !Number.isFinite(announcement.eventAt)) return false;
  let sigBytes: Uint8Array;
  let pubBytes: Uint8Array;
  try {
    sigBytes = base64ToUint8Array(announcement.signature);
    pubBytes = hexToUint8Array(announcement.accountKey);
  } catch { return false; }
  if (sigBytes.length !== 64 || pubBytes.length !== 32) return false;
  const message = kind === 'device_added'
    ? buildCanonicalDeviceAddedMessage(announcement.accountKey, announcement.deviceKey, announcement.eventAt)
    : buildCanonicalDeviceRevokedMessage(announcement.accountKey, announcement.deviceKey, announcement.eventAt);
  try {
    return ed25519.verify(sigBytes, message, pubBytes);
  } catch {
    return false;
  }
}

// ============================================================
// Public option/event types
// ============================================================

export interface SendOptions {
  urgency?: MessageUrgency;
  expiry?: number;
  /**
   * Supply the message id instead of letting the SDK generate one. Lets a
   * caller's optimistic UI message share the id used for storage,
   * `onMessageStatus`, and `onCiphertext`, so all of them correlate.
   */
  messageId?: string;
  /**
   * Mark this message as a reply to an earlier one. `messageId` is the
   * ID of the message being replied to (must be in the same
   * conversation); `snippetText` is a short preview the receiver can
   * render above the reply without having to look up the original
   * (typically the first ~80 chars of the original text). Both fields
   * round-trip through the envelope and are persisted on
   * `StoredMessage.replyTo`.
   */
  replyTo?: { messageId: string; snippetText?: string };
  /**
   * Mark this message as forwarded from another peer. The receiver
   * stores it under `StoredMessage.forwardedFrom` and UIs typically
   * render a small "Forwarded" label with the original sender. The
   * primitive is purely cosmetic — the SDK doesn't verify the
   * forwardedFrom claim cryptographically, since the forwarder is the
   * party with the plaintext anyway. App-level provenance (chain of
   * custody, signed forwards) is layered on top if needed.
   */
  forwardedFrom?: string;
}

export interface MediaSendOptions extends SendOptions {
  mimeType?: string;
  upload?: (encryptedData: Uint8Array) => Promise<string>;
  thumb?: string;
  fileName?: string;
  fileSize?: number;
}

export interface MediaMessage {
  url: string;
  key: string;
  mimeType?: string;
  thumb?: string;
  fileName?: string;
  fileSize?: number;
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

export interface ExportConversationOptions {
  /** Output format. Default `'json'` (pretty-printed). */
  format?: 'json' | 'text';
  /** Optional per-message filter. Returning false drops the message. */
  filter?: (m: import('../persistence/types.js').StoredMessage) => boolean;
  /** Optional peerId → display-name map for the `'text'` format. */
  displayName?: Record<string, string>;
  /** Optional custom renderer for the `'text'` format. Overrides the default
   *  line shape `[YYYY-MM-DD HH:mm] @sender: payload`. */
  textFormatter?: (
    m: import('../persistence/types.js').StoredMessage,
    nameFor: (peerId: string) => string,
  ) => string;
}

function formatExportedMessages(
  messages: import('../persistence/types.js').StoredMessage[],
  options: ExportConversationOptions,
): string {
  const format = options.format ?? 'json';
  if (format === 'json') {
    return JSON.stringify(messages, null, 2);
  }
  const names = options.displayName ?? {};
  const nameFor = (peerId: string): string => names[peerId] ?? peerId.slice(0, 8);
  const lineFor = options.textFormatter ?? defaultTextLine(nameFor);
  return messages.map((m) => lineFor(m, nameFor)).join('\n');
}

function defaultTextLine(
  nameFor: (peerId: string) => string,
): (m: import('../persistence/types.js').StoredMessage, name: (peerId: string) => string) => string {
  return (m) => {
    const ts = new Date(m.timestamp);
    const pad = (n: number): string => n.toString().padStart(2, '0');
    const stamp =
      `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())} ` +
      `${pad(ts.getHours())}:${pad(ts.getMinutes())}`;
    let text: string;
    try {
      text = new TextDecoder().decode(new Uint8Array(m.payload));
    } catch {
      text = `[${m.payload.length} bytes binary]`;
    }
    const sender = m.groupSenderId ?? m.senderId;
    return `[${stamp}] @${nameFor(sender)}: ${text}`;
  };
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

  async send(payload: Uint8Array, options?: SendOptions): Promise<void> {
    await this.sdk.sendToGroup(this.group.id, payload, options);
  }

  /**
   * Add a new member to the group. Allowed if the local user is the
   * group's admin (treeRoot), or if the group is adminless (treeRoot
   * is the empty string). Throws otherwise.
   */
  async addMember(peerId: string): Promise<void> {
    await this.sdk['addGroupMemberBroadcast'](this.group.id, peerId);
  }

  /**
   * Transfer the admin role to another member, or pass '' to make the
   * group adminless (anyone can add new members). Only the current
   * admin can call this.
   */
  async transferAdmin(newAdminId: string): Promise<void> {
    await this.sdk['transferGroupAdminBroadcast'](this.group.id, newAdminId);
  }

  /** Convenience for transferAdmin('') — make the group adminless. */
  async becomeAdminless(): Promise<void> {
    await this.transferAdmin('');
  }

  /** True if the local user is the group's admin. */
  isAdmin(): boolean {
    return this.group.treeRoot === this.sdk.getLocalPeerId();
  }

  /** True if the group has no admin (anyone can add members). */
  isAdminless(): boolean {
    return this.group.treeRoot === '';
  }

  removeMember(peerId: string): void {
    this.sdk['groupManager'].removeMember(this.group.id, peerId);
  }

  /**
   * Kick a member from the group. Only the current admin can call this.
   * Broadcasts a group_member_kicked control message to every other
   * current member (including the kicked one). The kicked peer wipes
   * their local group state on receipt; remaining members remove them
   * from their roster.
   */
  async kickMember(peerId: string): Promise<void> {
    await this.sdk['kickGroupMemberBroadcast'](this.group.id, peerId);
  }

  /**
   * Leave the group: send a group_leave control message to every other
   * current member so they remove us from their roster, then wipe local
   * state. Returns once the broadcast is enqueued; relay store-and-
   * forward handles delivery to offline peers.
   */
  async leave(): Promise<void> {
    await this.sdk['leaveGroupBroadcast'](this.group.id);
    this.sdk['groupManager'].leaveGroup(this.group.id);
  }

  /**
   * Rename the group. Only the current admin can call this; if the group
   * is adminless, any current member can. Broadcasts a group_rename
   * control message to every other current member. The new name is
   * trimmed; empty strings throw. No-op if the name is unchanged.
   */
  async rename(newName: string): Promise<void> {
    await this.sdk['renameGroupBroadcast'](this.group.id, newName);
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

  // Session-health ping/pong state. After every initiateHandshake we schedule
  // a session_ping; if no session_pong arrives within the timeout, the
  // session is considered broken and we trigger a targeted re-handshake.
  // Detects the "silent half-broken session" failure mode that onDecryptFailure
  // can't catch (because nothing is failing to decrypt — there's just nothing
  // flowing in one direction).
  private readonly pendingPings: Map<string, {
    pingId: string;
    sendTimer: ReturnType<typeof setTimeout> | null;
    timeoutTimer: ReturnType<typeof setTimeout> | null;
  }> = new Map();
  private static readonly SESSION_PING_DELAY_MS = 4_000;
  private static readonly SESSION_PONG_TIMEOUT_MS = 10_000;

  // Serialises the read-encrypt-write block in sendMessage per-recipient.
  // Without this, two concurrent sends to the same peer both ratchetEncrypt
  // off the same snapshot, produce identical msgN=0 packets, and the receiver
  // can only decrypt one — the others fail with "invalid ghash tag".
  private readonly sessionMutex = new KeyedMutex();

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
  private onGroupMemberLeftHandler: ((groupId: string, peerId: string) => void) | null = null;
  private onGroupMemberAddedHandler: ((groupId: string, peerId: string, addedBy: string) => void) | null = null;
  private onGroupAdminChangedHandler: ((groupId: string, newAdminId: string, changedBy: string) => void) | null = null;
  private onGroupMemberKickedHandler: ((groupId: string, peerId: string, kickedBy: string) => void) | null = null;
  private onKickedFromGroupHandler: ((groupId: string, kickedBy: string) => void) | null = null;
  private onGroupRenamedHandler: ((groupId: string, newName: string, renamedBy: string) => void) | null = null;
  private onReactionUpdatedHandler: ((conversationId: string, messageId: string, peerId: string, emoji: string, added: boolean) => void) | null = null;
  private onDisappearingMessagesChangedHandler: ((conversationId: string, ttlMs: number | null, changedBy: string) => void) | null = null;

  /**
   * Per-conversation disappearing-messages TTL in milliseconds. Empty
   * means "no policy / messages don't auto-expire." Loaded from storage
   * key `disappearing_messages` (Record<conversationId, ttlMs>) on
   * boot; persisted on every change. When a send fires in a
   * conversation that has a policy, the SDK auto-sets `expiry` on the
   * outgoing message envelope so both ends apply the same TTL.
   */
  private readonly disappearingMessages: Map<string, number> = new Map();
  private static readonly DISAPPEARING_KEY = 'disappearing_messages';
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
      (peerId) => this.sendHandshakeActivation(peerId),
      config.namespace,
      config.node ?? 'mesh',
      this.namespaceManager.getNamespaceId(),
      (peerId, role) => this.onSessionEstablishedHook(peerId, role),
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
      (hintPeerId) => {
        // Targeted re-handshake when we can identify the broken peer (the
        // failed packet's dhKey was indexed to them). Per-peer 30s cooldown
        // prevents tight loops if both sides are continuously failing.
        if (hintPeerId) {
          this.sessionManager.targetedReestablish(hintPeerId).catch(() => {});
          return;
        }
        // Unknown peer — fall back to the debounced global re-handshake.
        this.sessionManager.scheduleReestablishment();
      },
      (groupId, groupSenderId, ciphertext) => {
        try {
          const plaintext = this.groupManager.decryptFromGroup(groupId, groupSenderId, ciphertext);
          return { plaintext };
        } catch {
          return null;
        }
      },
      config.messageRetention ?? 'unbounded',
    );

    this.onPresenceHandler = config.onPresence ?? null;
    this.onTypingHandler = config.onTyping ?? null;
    this.onContactRequestHandler = config.onContactRequest ?? null;
    this.onGroupInviteHandler = config.onGroupInvite ?? null;
    this.onGroupMemberLeftHandler = config.onGroupMemberLeft ?? null;
    this.onGroupMemberAddedHandler = config.onGroupMemberAdded ?? null;
    this.onGroupAdminChangedHandler = config.onGroupAdminChanged ?? null;
    this.onGroupMemberKickedHandler = config.onGroupMemberKicked ?? null;
    this.onKickedFromGroupHandler = config.onKickedFromGroup ?? null;
    this.onGroupRenamedHandler = config.onGroupRenamed ?? null;
    this.onReactionUpdatedHandler = config.onReactionUpdated ?? null;
    this.onDisappearingMessagesChangedHandler = config.onDisappearingMessagesChanged ?? null;
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
          // Also schedule a boot-time session-health check for every existing
          // session. Heals sessions that ended up broken under the old OPK
          // resurrection bug without the user having to do anything — they
          // open the app, broken sessions get pinged, no pong fires a
          // targeted re-handshake, recovery is silent.
          instance.scheduleBootHealthCheck();
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
      const [{ WebSocketTransport }, { LocalTransport }, { NodeTransport }, { NoOpTransport }] =
        await Promise.all([
          import('../transport/websocket/index.js'),
          import('../transport/local/index.js'),
          import('../transport/node/index.js'),
          import('../transport/noop/index.js'),
        ]);
      const deviceId = randomBytes(16);
      wsTransport = new WebSocketTransport();
      const lanConfig = config.transports?.lan ?? true;
      localTransport = lanConfig === false
        ? new NoOpTransport('local_net')
        : new LocalTransport(deviceId, typeof lanConfig === 'object' ? lanConfig : undefined);
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

    // Cancel any in-flight session-health timers so they don't fire after
    // shutdown and trigger spurious re-handshakes during the next init.
    for (const peerId of [...this.pendingPings.keys()]) this.clearPendingPing(peerId);

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

    // Auto-apply the disappearing-messages policy if one is set on the
    // conversation. An explicit `options.expiry` always wins so callers
    // can still override per-message.
    const policyTtlMs = this.disappearingMessages.get(recipientId);
    if (policyTtlMs && options?.expiry === undefined) {
      options = { ...(options ?? {}), expiry: Math.floor(policyTtlMs / 1000) };
    }

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

    // Multi-device fan-out (phase C). Resolve the recipient's accountKey
    // and iterate every known device for that account. The original
    // `recipientId` argument is used as the conversationId for the local
    // outbound save so the user still sees a single thread "with Alice"
    // regardless of how many devices Alice has.
    //
    // Backwards-compat: if the recipient isn't a known contact (e.g. a
    // first-time send via addContactByKey before the contact graph is
    // populated), the device list is empty and we fall back to sending
    // to the raw recipientId.
    const accountKey = this.permissionManager.getAccountForDevice(recipientId) ?? recipientId;
    let devices = this.permissionManager.getDevicesForAccount(accountKey);
    if (devices.length === 0) devices = [recipientId];

    const messageId = options?.messageId ?? generateMessageId();
    const timestamp = Date.now();

    const results = await Promise.allSettled(
      devices.map((device) => this.sendMessageToDevice(device, payload, messageId, timestamp, options)),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    if (succeeded === 0) {
      const firstError = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
      throw firstError?.reason ?? new Error(`No device of ${recipientId} accepted the message`);
    }

    const isControl = isControlPayload(payload);

    // Transparency hook (ADR-008): surface the relay-visible bytes of this
    // message. Skipped for control messages and when no handler is set.
    if (!isControl && this.config.onCiphertext) {
      const first = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ destHash: Uint8Array; ciphertext: Uint8Array } | void> | undefined;
      const wire = first?.value;
      if (wire) {
        try {
          this.config.onCiphertext({
            messageId,
            recipientId,
            destHash: wire.destHash,
            ciphertext: wire.ciphertext,
            plaintextLength: payload.length,
          });
        } catch { /* never let a transparency hook break a send */ }
      }
    }
    if (!isControl) {
      const expiresAt = options?.expiry ? timestamp + options.expiry * 1000 : undefined;
      await this.messageHandler.saveMessage({
        id: messageId,
        conversationId: recipientId,
        senderId: this.getLocalPeerId(),
        recipientId,
        payload: Array.from(payload),
        timestamp,
        direction: 'outbound',
        status: 'sent',
        expiresAt,
        ...(options?.replyTo ? { replyTo: options.replyTo } : {}),
        ...(options?.forwardedFrom ? { forwardedFrom: options.forwardedFrom } : {}),
      });
      // Mirror to our own other devices so the user's other clients
      // also see the outbound message. Best-effort, never blocks.
      this.fanOutToOwnDevices(recipientId, false, payload, messageId, timestamp, options);
    }
  }

  /**
   * Send one ratchet-encrypted copy of a message to a single device.
   * Same messageId across every device copy of a logically-single
   * send, so cross-device dedup at receivers is content-stable.
   */
  private async sendMessageToDevice(
    deviceKey: string,
    payload: Uint8Array,
    messageId: string,
    timestamp: number,
    options: SendOptions | undefined,
  ): Promise<{ destHash: Uint8Array; ciphertext: Uint8Array }> {
    await this.sessionManager.ensureSession(deviceKey);

    const session = this.sessionManager.getSession(deviceKey);
    if (!session) {
      const err = new Error(`Failed to establish session with ${deviceKey}`);
      this.fireError(err);
      throw err;
    }
    // Receiver-only session = peer just sent us an x3dh_init that replaced
    // our previous session, and the matching handshake_activate ratchet
    // message hasn't arrived yet. The sending chain bootstraps when we
    // process that activation, so wait briefly rather than failing the
    // user's send. If it never arrives the existing throw still fires.
    // Done outside the sessionMutex so we don't hold the per-recipient lock
    // for the full 6s wait window — the mutex re-reads inside its critical
    // section anyway.
    await this.waitForSendableSession(deviceKey, session);

    const envelope = {
      id: messageId,
      senderId: this.getLocalPeerId(),
      recipientId: deviceKey,
      payload: Array.from(payload),
      timestamp,
      urgency: options?.urgency ?? 'normal',
      expiry: options?.expiry,
      ...(options?.replyTo ? { replyTo: options.replyTo } : {}),
      ...(options?.forwardedFrom ? { forwardedFrom: options.forwardedFrom } : {}),
    };

    const envelopeBytes = new TextEncoder().encode(JSON.stringify(envelope));
    const compressed = compressPayload(envelopeBytes);

    const { header, ciphertext } = await this.sessionMutex.run(deviceKey, async () => {
      const current = this.sessionManager.getSession(deviceKey);
      if (!current) throw new Error(`Session for ${deviceKey} disappeared mid-send`);
      if (current.sendingChainKey === null) {
        throw new Error(`Session for ${deviceKey} reverted to receiver-only mid-send`);
      }
      const r = ratchetEncrypt(current, compressed);
      this.sessionManager.setSession(deviceKey, r.state);
      return { header: r.header, ciphertext: r.ciphertext };
    });

    const headerBytes = serializeRatchetHeader(header);
    const fullPayload = concat(headerBytes, ciphertext);

    const recipientPublicKey = this.peerCache.getPeerPublicKey(deviceKey);
    if (!recipientPublicKey) throw new Error(`No public key for recipient ${deviceKey}`);

    const destHash = deriveDestHash(this.namespaceManager.getNamespaceId(), recipientPublicKey, getCurrentEpochHour());
    const senderEphId = this.identity.generateEphemeralId();
    const packet = createDataPacket(destHash, senderEphId, fullPayload);

    const burst = this.chaffGenerator.camouflageRealMessage(packet);
    for (const p of burst) {
      await this.routeAndSend(p, deviceKey);
    }
    // Return the relay-visible bytes for the onCiphertext transparency hook.
    return { destHash, ciphertext: fullPayload };
  }

  /** Like sendMessage but skips the outbound persistence step. Used by sendToGroup
   *  which manages its own storage under the group conversation ID. */
  private async sendMessageRaw(recipientId: string, payload: Uint8Array): Promise<void> {
    await this.sessionManager.ensureSession(recipientId);
    const session = this.sessionManager.getSession(recipientId);
    if (!session) throw new Error(`No session for ${recipientId}`);
    await this.waitForSendableSession(recipientId, session);

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

    const { header, ciphertext } = await this.sessionMutex.run(recipientId, async () => {
      const current = this.sessionManager.getSession(recipientId);
      if (!current) throw new Error(`Session for ${recipientId} disappeared mid-send`);
      if (current.sendingChainKey === null) {
        throw new Error(`Session for ${recipientId} reverted to receiver-only mid-send`);
      }
      const r = ratchetEncrypt(current, compressed);
      this.sessionManager.setSession(recipientId, r.state);
      return { header: r.header, ciphertext: r.ciphertext };
    });

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

  // If `session` has no sending chain, wait briefly for the peer's
  // handshake_activate (or any inbound ratchet message) to bootstrap
  // it. Returns the latest session state. Times out after ~6 seconds,
  // in which case the original receiver-only session is returned and
  // the caller's ratchetEncrypt will throw as before.
  private async waitForSendableSession(
    recipientId: string,
    session: RatchetState,
  ): Promise<RatchetState> {
    if (session.sendingChainKey !== null) return session;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      const next = this.sessionManager.getSession(recipientId);
      if (next && next.sendingChainKey !== null) return next;
      if (next) session = next;
    }
    return session;
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
      ...(options?.thumb ? { thumb: options.thumb } : {}),
      ...(options?.fileName ? { fileName: options.fileName } : {}),
      ...(options?.fileSize !== undefined ? { fileSize: options.fileSize } : {}),
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
      ? 'https://relay.meshwhisper.org/media'
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
    // Record a revival for the new groupId — covers the (unlikely) case where
    // a previous group with the same id was tombstoned, and ensures consistent
    // onArchiveDirty firing for any new "this id is alive" event. No history
    // auto-fetch for groups by design.
    this.recordRevival(group.id).catch(() => {});

    // Send an invite to each initial member over their pairwise encrypted channel
    const members = this.groupManager.getMembers(group.id);
    const senderKeysRecord: Record<string, number[]> = {};
    for (const m of members) {
      const key = this.groupManager.getSenderKey(group.id, m.id);
      if (key) senderKeysRecord[m.id] = Array.from(key);
    }
    // Include per-member Ed25519 identity keys so that accepting members
    // can open X3DH sessions with one another. Without this, non-creator
    // members can't message each other — they only have peerIds (X25519)
    // but X3DH directory lookup needs Ed25519 keys.
    const memberEdKeysRecord: Record<string, number[]> = {};
    for (const m of members) {
      if (m.id === this.getLocalPeerId()) continue;
      const edKey = this.sessionManager.getPeerEdKey(m.id);
      if (edKey) memberEdKeysRecord[m.id] = Array.from(edKey);
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
          memberEdKeys: memberEdKeysRecord,
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

  async sendToGroup(groupId: string, payload: Uint8Array, options?: SendOptions): Promise<void> {
    this.assertRunning();

    // Auto-apply the group's disappearing-messages policy if set. Same
    // rule as sendMessage: explicit options.expiry always wins. This is
    // what makes setDisappearingMessages(groupId, ttl) actually expire
    // group messages — without this the TTL would only have shown up on
    // DMs that happened to share an id with the group, which is nothing.
    const policyTtlMs = this.disappearingMessages.get(groupId);
    if (policyTtlMs && options?.expiry === undefined) {
      options = { ...(options ?? {}), expiry: Math.floor(policyTtlMs / 1000) };
    }

    const { ciphertext, senderId } = this.groupManager.encryptForGroup(groupId, payload);
    const members = this.groupManager.getMembers(groupId);

    // Stable group messageId, shared across every member's stored copy.
    // Each per-member sendMessageRaw would otherwise generate its own
    // envelope id, breaking anything that names a group message later
    // (reactions, replies, forwarding, delete) — receivers would all
    // have different ids for the same logical message. The id is sent
    // on the inner __mw_grp envelope and used by handleGroupEnvelope as
    // the message id on the receiver's stored copy.
    const messageId = this.messageHandler.createMessageId();
    const now = Date.now();
    const expiresAt = options?.expiry ? now + options.expiry * 1000 : undefined;

    // Wrap in a group envelope so receivers can identify it and decrypt with
    // the sender key. Delivered pairwise (Double Ratchet) to each member.
    // The GROUP_ENVELOPE_MARKER prefix lets MessageHandler detect and route it.
    // replyTo / forwardedFrom / expiry travel as envelope metadata so every
    // member's receive path sees them — they only mattered for DMs before.
    const envelopePayload = new TextEncoder().encode(
      JSON.stringify({
        __mw_grp: groupId,
        sid: senderId,
        d: Array.from(ciphertext),
        mid: messageId,
        ts: now,
        ...(options?.replyTo ? { replyTo: options.replyTo } : {}),
        ...(options?.forwardedFrom ? { forwardedFrom: options.forwardedFrom } : {}),
        ...(options?.expiry ? { expiry: options.expiry } : {}),
      }),
    );
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
      ...(expiresAt ? { expiresAt } : {}),
      ...(options?.replyTo ? { replyTo: options.replyTo } : {}),
      ...(options?.forwardedFrom ? { forwardedFrom: options.forwardedFrom } : {}),
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

    // Mirror to our own other devices. The sync carries the groupId so the
    // receiving device stores it under the group conversation.
    this.fanOutToOwnDevices(groupId, true, payload, messageId, now, options);
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

    // Register each fellow member's Ed25519 key + peerCache entry so we
    // can establish pairwise X3DH sessions with them when we go to send
    // a group message. Without this, send-to-fellow-non-creator fails:
    // we have only the X25519 routing key (= peerId) and no edKey, so
    // the directory lookup that drives X3DH handshake init has nothing
    // to query with.
    const me = this.getLocalPeerId();
    if (invite.memberEdKeys) {
      for (const [memberId, edKey] of invite.memberEdKeys) {
        if (memberId === me) continue;
        this.sessionManager.rememberPeerEdKey(memberId, edKey);
        // peerCache is keyed by peerId (which IS the X25519 hex public key).
        if (!this.peerCache.getPeerPublicKey(memberId)) {
          this.peerCache.addPeer(memberId, hexToUint8Array(memberId));
        }
        this.storage?.set(`peers/${memberId}`, memberId).catch(() => {});
      }
    }

    this.pendingGroupInvites.delete(groupId);

    // Record a revival for the group itself so a prior delete-tombstone on
    // this groupId doesn't suppress messages/{groupId} after the next pull.
    // Fire-and-forget — joinGroup is sync and the archive push happens
    // separately via onArchiveDirty. No history auto-fetch for groups —
    // group conversations don't show backfill from before you joined.
    this.recordRevival(groupId).catch(() => {});
  }

  /** Discards a pending group invite without joining. */
  static declineGroupInvite(groupId: string): void {
    MeshWhisper.instance.pendingGroupInvites.delete(groupId);
  }

  /**
   * Restores a previously-joined group from persisted state (sender keys, members).
   * Does NOT send any invites — used only to reload in-memory group state after restart.
   */
  static restoreGroup(
    groupId: string,
    groupName: string,
    members: string[],
    senderKeys: Record<string, number[]>,
  ): void {
    MeshWhisper.instance.restoreGroupInstance(groupId, groupName, members, senderKeys);
  }

  restoreGroupInstance(
    groupId: string,
    groupName: string,
    members: string[],
    senderKeys: Record<string, number[]>,
  ): void {
    if (this.groupManager.getGroup(groupId)) return;
    const senderKeyMap = new Map<string, Uint8Array>(
      Object.entries(senderKeys).map(([id, arr]) => [id, new Uint8Array(arr)]),
    );
    const invite: import('../group/index.js').GroupInvite = {
      groupId,
      groupName,
      invitedBy: members[0] ?? this.getLocalPeerId(),
      senderKeys: senderKeyMap,
      members,
    };
    this.groupManager.joinGroup(groupId, invite);
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

    const hadTombstone = await this.recordRevival(peerId);

    this.peerCache.addPeer(peerId, edwardsToMontgomeryPub(bundle.identityKey));
    await this.sessionManager.initiateHandshake(peerId, bundle);
    this.autoRequestHistoryIfRevived(peerId, hadTombstone);
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
    const hadTombstone = await this.recordRevival(peerId);
    this.persistContacts().catch(() => {});
    this.autoRequestHistoryIfRevived(peerId, hadTombstone);

    // Initiate a new handshake if either:
    //   - No session exists at all, or
    //   - The existing session is in pure receive-only mode (sending chain
    //     never initialised because we never received a ratchet message after
    //     the inbound x3dh_init). That is a stuck state — overwriting it loses
    //     nothing, since we couldn't send through it anyway.
    // Otherwise the existing session is healthy: re-initiating would
    // unnecessarily reset both sides' ratchet state.
    const existing = this.sessionManager.getSession(peerId);
    const canSend = existing && existing.sendingChainKey !== null;
    if (!canSend) {
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
    MeshWhisper.instance.persistContacts().catch(() => {});
  }

  /**
   * Returns the account-level identity key for a given device peer id,
   * or `null` if the peer is not a known contact device. For single-device
   * contacts (the default), the account key equals the device key.
   */
  static getAccountForDevice(deviceKey: string): string | null {
    return MeshWhisper.instance.permissionManager.getAccountForDevice(deviceKey);
  }

  /**
   * Returns every device key currently linked to the given account.
   * Empty array if the account is unknown. For single-device contacts
   * the array has length 1 and contains the account key.
   */
  static getDevicesForAccount(accountKey: string): string[] {
    return MeshWhisper.instance.permissionManager.getDevicesForAccount(accountKey);
  }

  /**
   * Returns every account-level identity key in the contact list.
   * Companion to `getContacts()` which returns the flat device-key view
   * for backwards compatibility. For single-device contacts the two
   * lists have identical contents.
   */
  static getContactAccounts(): string[] {
    return MeshWhisper.instance.permissionManager.getAllContactAccounts();
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

  // ================================================================
  // Public API — Conversation export
  // ================================================================

  /**
   * Export one conversation's messages as a string. Default format is
   * pretty-printed JSON; pass `format: 'text'` for a WhatsApp-style
   * line-by-line transcript.
   *
   * Apps can override the per-message text rendering via `textFormatter`
   * and supply display names via `displayName` so the transcript shows
   * "@alice" instead of raw peer hex. Pass a `filter` to skip messages
   * (e.g. to exclude app-level control envelopes like `__prudence_ctrl`).
   *
   * Use this for "Export chat" UI features, compliance archives, or to
   * migrate history out of MeshWhisper into another system.
   */
  static async exportConversation(
    peerId: string,
    options?: ExportConversationOptions,
  ): Promise<string> {
    return MeshWhisper.instance.exportConversationInstance(peerId, options);
  }

  async exportConversationInstance(
    peerId: string,
    options?: ExportConversationOptions,
  ): Promise<string> {
    this.assertRunning();
    const messages = await this.messageHandler.getMessages(peerId);
    const filtered = options?.filter ? messages.filter(options.filter) : messages;
    return formatExportedMessages(filtered, options ?? {});
  }

  /**
   * Export every conversation. Returns a `Record<peerId, exportedString>`
   * with each value formatted per the supplied options (same defaults as
   * `exportConversation`).
   */
  static async exportAllConversations(
    options?: ExportConversationOptions,
  ): Promise<Record<string, string>> {
    return MeshWhisper.instance.exportAllConversationsInstance(options);
  }

  async exportAllConversationsInstance(
    options?: ExportConversationOptions,
  ): Promise<Record<string, string>> {
    this.assertRunning();
    const convs = await this.messageHandler.getConversations();
    const out: Record<string, string> = {};
    for (const c of convs) {
      out[c.peerId] = await this.exportConversationInstance(c.peerId, options);
    }
    return out;
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
   * Persist a message's status as 'read' locally without sending a read
   * receipt to anyone. Use this for group messages (where there's no single
   * peer to receipt to — sending would either fail or require fan-out) and
   * for any case where the app wants the unread badge to clear on reload
   * without notifying the sender.
   */
  static async markReadLocal(messageId: string, conversationId: string): Promise<void> {
    return MeshWhisper.instance.markReadLocalInstance(messageId, conversationId);
  }

  async markReadLocalInstance(messageId: string, conversationId: string): Promise<void> {
    this.assertRunning();
    await this.messageHandler.updateMessageStatus(messageId, conversationId, 'read');
  }

  /**
   * Toggle the local user's reaction with `emoji` on a message. If they
   * already reacted with this emoji, the reaction is removed; otherwise
   * it's added. Updates local storage first, then sends a
   * `__mw_ctrl: 'reaction'` control to the peer so their stored message
   * gets the same change. `onReactionUpdated` fires on the receiver
   * side after the persisted message is updated.
   *
   * `conversationId` is the peer ID for DMs or the group ID for groups —
   * the control is fanned out to every other group member, and the
   * `reactions` map accumulates one entry per reacting peer.
   */
  static async toggleReaction(
    conversationId: string,
    messageId: string,
    emoji: string,
  ): Promise<'added' | 'removed' | 'noop'> {
    return MeshWhisper.instance.toggleReactionInstance(conversationId, messageId, emoji);
  }

  /**
   * Forward an existing message to another recipient. Looks up the
   * message in `fromConversationId`, sends its payload to
   * `toRecipientId` with `forwardedFrom` set to the original sender's
   * peerId. The receiver sees the message as if from you (`senderId`
   * is the local peer) but with `forwardedFrom` indicating the
   * original author — UIs typically render a small "Forwarded" label
   * with that peer's display name.
   *
   * No-op + returns null if the source message can't be found locally.
   * The forwarder is the party with plaintext, so the SDK doesn't
   * verify the forwardedFrom claim cryptographically — app-level
   * provenance (signed forwards, chain of custody) is layered on top
   * if needed.
   */
  static async forwardMessage(
    fromConversationId: string,
    messageId: string,
    toRecipientId: string,
    options?: SendOptions,
  ): Promise<string | null> {
    return MeshWhisper.instance.forwardMessageInstance(fromConversationId, messageId, toRecipientId, options);
  }

  async forwardMessageInstance(
    fromConversationId: string,
    messageId: string,
    toRecipientId: string,
    options?: SendOptions,
  ): Promise<string | null> {
    this.assertRunning();
    const existing = await this.messageHandler.getMessages(fromConversationId);
    const source = existing.find((m) => m.id === messageId);
    if (!source) return null;
    // Preserve the forwarding chain: if the source was itself forwarded,
    // carry the original author forward rather than the most recent
    // forwarder. Matches the WhatsApp/Signal convention.
    const originalAuthor = source.forwardedFrom ?? source.senderId;
    const forwardOptions = { ...(options ?? {}), forwardedFrom: originalAuthor };
    // Route to group or peer depending on the destination conversation.
    if (this.groupManager.getGroup(toRecipientId)) {
      await this.sendToGroup(toRecipientId, new Uint8Array(source.payload), forwardOptions);
    } else {
      await this.sendMessage(toRecipientId, new Uint8Array(source.payload), forwardOptions);
    }
    return originalAuthor;
  }

  /**
   * Set (or clear) the disappearing-messages policy for a conversation.
   * Pass `ttlMs` to enable — every subsequent send in that
   * conversation will auto-receive `expiry: ttlMs / 1000` so both the
   * sender's and recipient's stored copies expire at the same time.
   * Pass `null` to disable the policy.
   *
   * Broadcasts a `__mw_ctrl: 'disappearing_messages'` control to the
   * peer so their side applies the same default on their outbound
   * sends. The peer's `onDisappearingMessagesChanged` callback fires
   * once the local state is updated.
   *
   * `conversationId` is the peer ID for DMs or the group ID for groups.
   * For groups the policy change fans out to every other member so they
   * all converge on the same TTL.
   */
  static async setDisappearingMessages(conversationId: string, ttlMs: number | null): Promise<void> {
    return MeshWhisper.instance.setDisappearingMessagesInstance(conversationId, ttlMs);
  }

  async setDisappearingMessagesInstance(conversationId: string, ttlMs: number | null): Promise<void> {
    this.assertRunning();
    const normalized = ttlMs && ttlMs > 0 ? Math.floor(ttlMs) : null;
    const current = this.disappearingMessages.get(conversationId) ?? null;
    if (current === normalized) return;
    if (normalized === null) {
      this.disappearingMessages.delete(conversationId);
    } else {
      this.disappearingMessages.set(conversationId, normalized);
    }
    await this.persistDisappearingMessages();
    this.sendControlToConversation(conversationId, {
      __mw_ctrl: 'disappearing_messages',
      disappearingTtlMs: normalized,
    });
  }

  /** Returns the disappearing-messages TTL in ms for a conversation, or null if no policy is set. */
  static getDisappearingMessages(conversationId: string): number | null {
    return MeshWhisper.instance.getDisappearingMessagesInstance(conversationId);
  }

  getDisappearingMessagesInstance(conversationId: string): number | null {
    return this.disappearingMessages.get(conversationId) ?? null;
  }

  private async persistDisappearingMessages(): Promise<void> {
    if (!this.storage) return;
    const obj: Record<string, number> = {};
    for (const [k, v] of this.disappearingMessages) obj[k] = v;
    await this.storage.set(MeshWhisper.DISAPPEARING_KEY, JSON.stringify(obj));
  }

  async toggleReactionInstance(
    conversationId: string,
    messageId: string,
    emoji: string,
  ): Promise<'added' | 'removed' | 'noop'> {
    this.assertRunning();
    if (!emoji) throw new Error('emoji required');
    const me = this.getLocalPeerId();
    // Read current state to decide add vs remove. The applyReaction call
    // itself is idempotent, but we need to know the resulting side so the
    // outgoing control message carries the correct `reactionAdd` flag.
    const existing = await this.messageHandler.getMessages(conversationId);
    const msg = existing.find((m) => m.id === messageId);
    if (!msg) return 'noop';
    const haveReacted = (msg.reactions?.[emoji] ?? []).includes(me);
    const add = !haveReacted;
    const outcome = await this.messageHandler.applyReaction(
      conversationId, messageId, me, emoji, add,
    );
    if (outcome === 'noop') return 'noop';
    this.sendControlToConversation(conversationId, {
      __mw_ctrl: 'reaction',
      messageId,
      reactionEmoji: emoji,
      reactionAdd: add,
    });
    return outcome;
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

  /**
   * Force a fresh X3DH handshake with `peerId`, replacing whatever session
   * we currently have. Use this when you know (or suspect) a session is
   * broken and want immediate recovery without waiting for the next
   * decrypt-failure to trigger automatic re-establishment.
   *
   * Preserves contacts, message history, and tombstones — only the
   * ratchet state is replaced. The other side picks up the new session
   * automatically when they receive the fresh x3dh_init.
   *
   * Bypasses the 30s per-peer cooldown that automatic re-establishment
   * uses, so two users hammering the button won't deadlock each other.
   */
  static async resetSession(peerId: string): Promise<void> {
    return MeshWhisper.instance.resetSessionInstance(peerId);
  }

  async resetSessionInstance(peerId: string): Promise<void> {
    this.assertRunning();
    await this.sessionManager.targetedReestablish(peerId, /* force */ true);
  }

  async deleteConversationInstance(peerId: string): Promise<void> {
    this.permissionManager.removeContact(peerId);
    this.peerCache.removePeer(peerId);
    // Drop the in-memory ratchet state too — wiping IDB without clearing
    // SessionManager.sessions left the corrupted state alive until the
    // next page reload, which meant "remove and re-add" silently reused
    // the old session instead of building a fresh one.
    this.sessionManager.deleteSession(peerId);
    await Promise.all([
      this.persistContacts(),
      this.storage?.delete(`peers/${peerId}`),
      this.storage?.delete(`messages/${peerId}`),
    ].filter(Boolean));
    // Record a tombstone after the other writes so a partial failure can't
    // leave a tombstone without the wipes. Fires onArchiveDirty so the app
    // pushes the post-delete archive immediately, before stale relay state
    // can resurrect the peer on next pull.
    await this.recordTombstone(peerId);
  }

  // ----------------------------------------------------------------
  // Tombstone / revival recording — internal
  // ----------------------------------------------------------------

  /**
   * Record a deletion event for `peerId` and fire onArchiveDirty so the
   * archive gets pushed immediately. Centralised so every SDK code path
   * that deletes a conversation triggers the same write + push path —
   * no chance for a caller to forget.
   */
  private async recordTombstone(peerId: string): Promise<void> {
    if (!this.storage) return;
    await addTombstone(this.storage, peerId);
    try { this.config.onArchiveDirty?.('tombstone'); } catch { /* swallow handler errors */ }
  }

  /**
   * Record a revival event for `peerId` (re-add after delete, inbound
   * x3dh_init, or accept of a group invite). Timestamp is forced to be
   * strictly greater than any existing tombstone for the peer, so the
   * revival can't tie or lose against same-millisecond writes. Fires
   * onArchiveDirty so the app pushes the post-revival archive immediately.
   * Returns `true` if a prior tombstone existed for this peer — callers
   * use this to auto-request conversation history from the peer.
   */
  private async recordRevival(peerId: string): Promise<boolean> {
    if (!this.storage) return false;
    const tombstones = await readTombstones(this.storage);
    const revivals = await readRevivals(this.storage);
    const tombTs = tombstones[peerId] ?? 0;
    const now = Date.now();
    const ts = Math.max(now, tombTs + 1);
    revivals[peerId] = Math.max(revivals[peerId] ?? 0, ts);
    await this.storage.set('revivals', JSON.stringify(revivals));
    try { this.config.onArchiveDirty?.('revival'); } catch { /* swallow handler errors */ }
    return tombTs > 0;
  }

  /**
   * If `hadTombstone` is true, schedule an automatic request_history send
   * to `peerId`. Used by the contact-add / inbound-handshake paths to
   * recover conversation history after an accidental delete. Fires after
   * a short delay so the just-established session is fully set up.
   * The peer's app still gates with onHistoryRequest — auto-fire on our
   * side doesn't bypass their consent.
   */
  private autoRequestHistoryIfRevived(peerId: string, hadTombstone: boolean): void {
    if (!hadTombstone) return;
    // 1s delay lets the new session's handshake_activate land and the send
    // chain bootstrap before we try to use it.
    const timer = setTimeout(() => {
      this.sendControl(peerId, { __mw_ctrl: 'request_history' });
    }, 1_000);
    if (typeof timer === 'object' && 'unref' in timer) {
      (timer as NodeJS.Timeout).unref();
    }
  }

  // ----------------------------------------------------------------
  // Session-health ping/pong
  // ----------------------------------------------------------------

  /**
   * Called by SessionManager every time a handshake completes. Initiator
   * schedules a `session_ping` send; responder just clears any stale
   * pending-ping state (a new handshake supersedes whatever was pending).
   *
   * The ping is delayed ~4s after the handshake to give handshake_activate
   * time to land on the responder side. If no `session_pong` arrives within
   * 10s of sending, we treat the session as broken and call
   * `targetedReestablish`, which has its own per-peer cooldown.
   */
  private onSessionEstablishedHook(peerId: string, role: 'initiator' | 'responder'): void {
    // Cancel any prior pending ping for this peer — superseded by the new session.
    this.clearPendingPing(peerId);
    if (role !== 'initiator') return;

    const pingId = uint8ArrayToHex(randomBytes(8));
    const sendTimer = setTimeout(() => {
      this.sendControl(peerId, { __mw_ctrl: 'session_ping', sessionPingId: pingId });
    }, MeshWhisper.SESSION_PING_DELAY_MS);
    if (typeof sendTimer === 'object' && 'unref' in sendTimer) {
      (sendTimer as NodeJS.Timeout).unref();
    }

    const timeoutTimer = setTimeout(() => {
      // Still pending → no pong arrived. Treat as broken.
      const pending = this.pendingPings.get(peerId);
      if (!pending || pending.pingId !== pingId) return;
      this.pendingPings.delete(peerId);
      console.warn(`[meshwhisper] session_ping to ${peerId.slice(0, 8)} unanswered — re-handshaking`);
      this.sessionManager.targetedReestablish(peerId).catch(() => {});
    }, MeshWhisper.SESSION_PING_DELAY_MS + MeshWhisper.SESSION_PONG_TIMEOUT_MS);
    if (typeof timeoutTimer === 'object' && 'unref' in timeoutTimer) {
      (timeoutTimer as NodeJS.Timeout).unref();
    }

    this.pendingPings.set(peerId, { pingId, sendTimer, timeoutTimer });
  }

  /**
   * Pings every existing session shortly after startup. Sessions that
   * answer with a pong are confirmed healthy; sessions that don't get
   * automatically re-handshaked. This is the silent-recovery path for
   * sessions that ended up broken under earlier protocol bugs — the user
   * opens the app and broken conversations heal themselves within ~15s
   * without any UI affordance to discover.
   *
   * Cheap: each ping is a small ratchet message, fan-out is per-contact,
   * the 4s ping-send delay gives the connection time to settle.
   */
  private scheduleBootHealthCheck(): void {
    // Capture contacts at scheduling time — we want to ping whoever was a
    // contact when the SDK first connected, not chase contacts added later.
    const peers = this.permissionManager.getContacts().filter(
      (peerId) => this.sessionManager.hasSession(peerId),
    );
    if (peers.length === 0) return;
    // Small stagger across peers so we don't fire all timers in one tick
    // on a user with many contacts. Doesn't affect correctness.
    for (let i = 0; i < peers.length; i++) {
      const peerId = peers[i]!;
      const jitter = 200 + i * 100;
      const timer = setTimeout(() => {
        this.onSessionEstablishedHook(peerId, 'initiator');
      }, jitter);
      if (typeof timer === 'object' && 'unref' in timer) {
        (timer as NodeJS.Timeout).unref();
      }
    }
  }

  /** Called when a session_pong arrives. Marks the matching ping resolved. */
  private resolvePendingPing(peerId: string, pingId: string): void {
    const pending = this.pendingPings.get(peerId);
    if (!pending || pending.pingId !== pingId) return;
    this.clearPendingPing(peerId);
  }

  private clearPendingPing(peerId: string): void {
    const pending = this.pendingPings.get(peerId);
    if (!pending) return;
    if (pending.sendTimer) clearTimeout(pending.sendTimer);
    if (pending.timeoutTimer) clearTimeout(pending.timeoutTimer);
    this.pendingPings.delete(peerId);
  }

  // ================================================================
  // Public API — Encrypted archive (backup / restore)
  // ================================================================

  /**
   * Derive the backup encryption key from raw identity key bytes.
   * Use this if you need to handle the encrypted blob outside the SDK
   * (e.g. local file export). For relay-based sync, prefer pushArchive /
   * pullArchive which derive the key internally.
   */
  static async deriveBackupKey(identityKeyBytes: Uint8Array): Promise<Uint8Array> {
    return _deriveBackupKey(identityKeyBytes);
  }

  private archiveRelayUrl(): string {
    const node = this.config.node ?? '';
    return Array.isArray(node) ? node[0] ?? '' : node;
  }

  /**
   * Build an encrypted archive blob containing message history, contacts,
   * and peer state. Pass `extra` for any app-specific data (e.g. display
   * names) that should travel with the archive.
   */
  async exportArchive(extra?: Record<string, unknown>): Promise<Uint8Array> {
    this.assertRunning();
    if (!this.storage) throw new Error('exportArchive requires a storage backend');
    const identityKey = this.identity.getEdPrivateKey();
    const backupKey = await _deriveBackupKey(identityKey);
    const kv = await collectKv(this.storage);
    const tombstones = await readTombstones(this.storage);
    const revivals = await readRevivals(this.storage);
    const payload = {
      version: 1 as const,
      createdAt: Date.now(),
      peerId: this.getLocalPeerId(),
      relayUrl: this.archiveRelayUrl(),
      kv,
      tombstones,
      revivals,
      extra,
    };
    return encryptArchive(payload, backupKey);
  }

  /**
   * Decrypt and restore an archive blob into this SDK instance's storage.
   * The SDK reloads its in-memory state after writing so the app sees
   * the restored contacts and messages immediately.
   * Returns the `extra` field from the archive for the app to handle.
   */
  async importArchive(blob: Uint8Array): Promise<{ extra?: Record<string, unknown> }> {
    this.assertRunning();
    if (!this.storage) throw new Error('importArchive requires a storage backend');
    const identityKey = this.identity.getEdPrivateKey();
    const backupKey = await _deriveBackupKey(identityKey);
    const payload = await decryptArchive(blob, backupKey);
    await mergeKv(
      payload.kv,
      this.storage,
      (key, fn) => this.messageHandler.storageMutex.run(key, fn),
      payload.tombstones ?? {},
      payload.revivals ?? {},
    );
    await this.loadPersistedState();

    // Fresh-device-after-archive-restore scenario: we now have contacts and
    // their edKeys but no Double Ratchet sessions (sessions are excluded from
    // archive for forward secrecy). Trigger a re-handshake on every contact
    // so that incoming messages from those peers can actually be decrypted.
    // Without this step, the new device silently drops every inbound
    // ratchet message until the user manually re-adds each contact.
    const contacts = this.permissionManager.getContacts();
    if (contacts.length > 0) {
      this.sessionManager.reinitiateSessionsOnStartup(contacts).catch(() => {});
    }
    return { extra: payload.extra };
  }

  /**
   * Export and upload the archive to the home relay. Safe to call after
   * every significant state change — throttle on the caller side.
   */
  async pushArchive(
    extra?: Record<string, unknown>,
    options?: { keepalive?: boolean },
  ): Promise<void> {
    this.assertRunning();
    if (!this.storage) return;
    const identityKey = this.identity.getEdPrivateKey();
    const backupKey = await _deriveBackupKey(identityKey);
    const authToken = await deriveArchiveToken(identityKey);
    const kv = await collectKv(this.storage);
    const tombstones = await readTombstones(this.storage);
    const revivals = await readRevivals(this.storage);
    const payload = {
      version: 1 as const,
      createdAt: Date.now(),
      peerId: this.getLocalPeerId(),
      relayUrl: this.archiveRelayUrl(),
      kv,
      tombstones,
      revivals,
      extra,
    };
    const plainSize = JSON.stringify(payload).length;
    if (plainSize > MAX_ARCHIVE_BYTES) {
      console.warn(`[archive] archive too large (${plainSize} bytes), skipping push`);
      return;
    }
    const blob = await encryptArchive(payload, backupKey);
    // keepalive caps at ~64 KB across the browser per spec; for larger
    // archives we drop the keepalive flag and accept that an unload-time
    // flush may not deliver — the next session will push again on boot.
    const useKeepalive = !!options?.keepalive && blob.byteLength <= 60_000;
    await uploadArchive(this.archiveRelayUrl(), this.getLocalPeerId(), authToken, blob, useKeepalive);
  }

  /**
   * Download the archive from the home relay and restore state.
   * Returns `{ restored: false }` when no archive exists yet.
   * On a fresh install this should be called right after init() so
   * contacts and messages are available before the UI renders.
   */
  async pullArchive(): Promise<{ restored: boolean; extra?: Record<string, unknown> }> {
    this.assertRunning();
    if (!this.storage) return { restored: false };
    const blob = await downloadArchive(this.archiveRelayUrl(), this.getLocalPeerId());
    if (!blob) return { restored: false };
    const result = await this.importArchive(blob);
    return { restored: true, ...result };
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

    // Packet-level dedup BEFORE decryption. Dual-send (relay + direct
    // bearers, docs/p2p-transport.md §6) delivers the same packet twice;
    // a duplicate ratchet ciphertext would fail decryption (the message
    // key is consumed by the first copy) and fire onDecryptFailure, which
    // can trigger a spurious re-handshake. Keyed by content hash because
    // senderEphemeralId is all-zeros on some construction paths.
    //
    // The mark is RELEASED if this copy turns out to be undecryptable
    // (session not ready yet) so the other bearer's copy still delivers —
    // marking before knowing the outcome would turn a transient decrypt
    // failure into permanent message loss.
    const dupKey = this.inboundPacketKey(packet);
    if (this.isDuplicateInbound(dupKey)) return;
    this.markInboundSeen(dupKey);

    const isForUs = this.namespaceManager.isMessageForUs(packet.destHash, this.identity.getPublicKey());
    if (isForUs) {
      this.processLocalPacket(packet, source, () => this.seenInboundPackets.delete(dupKey));
    } else {
      this.maybeRelay(packet, source, bearer);
    }
  }

  // Rolling LRU of inbound packet content hashes for dual-send dedup.
  private readonly seenInboundPackets = new Map<string, number>();
  private static readonly SEEN_INBOUND_MAX = 2048;
  private static readonly SEEN_INBOUND_TTL_MS = 60_000;

  private inboundPacketKey(packet: Packet): string {
    return uint8ArrayToHex(
      hash(concat(packet.destHash, packet.senderEphemeralId, packet.encryptedPayload)),
    ).slice(0, 32);
  }

  private isDuplicateInbound(key: string): boolean {
    const seenAt = this.seenInboundPackets.get(key);
    return seenAt !== undefined && Date.now() - seenAt < MeshWhisper.SEEN_INBOUND_TTL_MS;
  }

  private markInboundSeen(key: string): void {
    const now = Date.now();
    this.seenInboundPackets.set(key, now);
    if (this.seenInboundPackets.size > MeshWhisper.SEEN_INBOUND_MAX) {
      for (const [k, t] of this.seenInboundPackets) {
        if (now - t >= MeshWhisper.SEEN_INBOUND_TTL_MS) this.seenInboundPackets.delete(k);
        if (this.seenInboundPackets.size <= MeshWhisper.SEEN_INBOUND_MAX) break;
      }
      // Still over cap (all fresh): evict oldest insertion order.
      while (this.seenInboundPackets.size > MeshWhisper.SEEN_INBOUND_MAX) {
        const oldest = this.seenInboundPackets.keys().next().value as string;
        this.seenInboundPackets.delete(oldest);
      }
    }
  }

  private processLocalPacket(packet: Packet, source: string, onUndecryptable?: () => void): void {
    switch (packet.flags) {
      case PacketFlags.HANDSHAKE:
        this.sessionManager.handleHandshakePacket(packet.encryptedPayload);
        break;
      case PacketFlags.DATA:
        this.messageHandler.handleDataPacket(packet, onUndecryptable);
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
    // Opportunistic dual-send (docs/p2p-transport.md §6): offer the packet to
    // any connected LAN/proximity peers in parallel with the guaranteed path.
    // Receivers dedup by packet ID, and only the addressee can match the
    // destHash, so this is safe, private, and free to fail silently.
    this.negotiator.broadcastLocal(packet).catch(() => {});

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
    // Capture pre-add state so we can tell whether this is a brand-new peer
    // contacting us, vs. someone we already knew re-handshaking (e.g. recovery
    // from a stuck receiver-only session, or a rotated key on the peer side).
    const isNewPeer = !this.permissionManager.isContact(peerId);

    this.permissionManager.addContact(peerId);
    this.persistContacts().catch(() => {});
    // The peer initiated an inbound X3DH — record a revival so it beats any
    // prior tombstone in archive merge (e.g. peer was deleted locally but is
    // sending us a fresh handshake now, or our cleared-tombstone state hadn't
    // been pushed to the relay yet when we last reloaded). The recordRevival
    // helper also fires onArchiveDirty so the archive gets pushed immediately.
    //
    // We deliberately DO NOT auto-request history on the inbound path. Auto-
    // request is the "I just re-added this peer" affordance and only belongs
    // on paths we initiated (acceptContact, addContactByKey). Firing it here
    // floods the bootstrap window with control traffic — entropy_challenge +
    // reputation_proof + request_history all queued behind a session that's
    // still receiver-only — and any one of them timing out can leave the
    // session in a half-broken state. If the other side wants history they
    // can request it explicitly via the "restore" button.
    this.recordRevival(peerId).catch(() => {});

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

    // Surface a contact request to the app the moment a stranger's x3dh_init
    // arrives, even if their application-level follow-up never lands. Apps
    // that depend on follow-up control messages (e.g. for username display)
    // can update the entry when the follow-up arrives. introducedBy is set to
    // peerId itself to signal a direct self-introduction (no introducer).
    if (isNewPeer) {
      this.onContactRequestHandler?.(peerId, peerId, undefined)?.catch(() => {});
    }
  }

  // ================================================================
  // Internal — Control messages
  // ================================================================

  private sendControl(peerId: string, payload: Record<string, unknown>): void {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    this.sendMessage(peerId, bytes, { urgency: 'background' }).catch(() => {});
  }

  /**
   * Self-fan-out (Signal-style "sync messages"): when this device sends a
   * message, mirror it to every OTHER device on the same account so the
   * user's other devices show the outbound message in their UI too.
   * Best-effort and silent — failure here never blocks the primary send.
   *
   * Security: the receiver verifies the sync-source's accountKey matches
   * the local accountKey before applying, so no contact can inject a
   * "you said X" into your history.
   */
  private fanOutToOwnDevices(
    recipientId: string,
    isGroup: boolean,
    payload: Uint8Array,
    messageId: string,
    timestamp: number,
    options?: SendOptions,
  ): void {
    const me = this.getLocalPeerId();
    const myAccountKey = this.permissionManager.getAccountForDevice(me) ?? me;
    const myDevices = this.permissionManager.getDevicesForAccount(myAccountKey)
      .filter((d) => d !== me);
    if (myDevices.length === 0) return;

    const sync: Record<string, unknown> = {
      __mw_ctrl: 'sync_send',
      syncRecipientId: recipientId,
      syncIsGroup: isGroup,
      syncMessageId: messageId,
      syncTimestamp: timestamp,
      syncPayload: Array.from(payload),
      ...(options?.replyTo ? { syncReplyTo: options.replyTo } : {}),
      ...(options?.forwardedFrom ? { syncForwardedFrom: options.forwardedFrom } : {}),
      ...(options?.expiry ? { syncExpiry: options.expiry } : {}),
    };
    for (const device of myDevices) {
      this.sendControl(device, sync);
    }
  }

  /**
   * Send a control message scoped to a conversation. DMs deliver to the
   * peer; groups fan out the same control to every other member, with
   * `groupId` set so receivers apply the change to the group conversation
   * rather than to the message's sender. The group fan-out path here is
   * what makes reactions / replies / forwarding / disappearing messages
   * work in groups (DM-only before, see ADR thread on group-aware ctrl).
   */
  private sendControlToConversation(conversationId: string, payload: Record<string, unknown>): void {
    const group = this.groupManager.getGroup(conversationId);
    if (group) {
      const me = this.getLocalPeerId();
      const scoped = { ...payload, groupId: conversationId };
      for (const member of this.groupManager.getMembers(conversationId)) {
        if (member.id !== me) this.sendControl(member.id, scoped);
      }
      return;
    }
    this.sendControl(conversationId, payload);
  }

  /**
   * Send a tiny ratchet message immediately after we initiate an x3dh_init.
   * The receiver running ratchetDecrypt on this advances their session from
   * receive-only to fully usable (sending chain initialised). Without this,
   * the receiver is stuck unable to send back until the initiator happens
   * to send some other message.
   *
   * Best-effort and silently swallowed by the receiver's control handler.
   */
  private sendHandshakeActivation(peerId: string): void {
    this.sendControl(peerId, { __mw_ctrl: 'handshake_activate' });
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
        const memberEdKeys = new Map<string, Uint8Array>();
        if (inv.memberEdKeys) {
          for (const [id, arr] of Object.entries(inv.memberEdKeys)) {
            memberEdKeys.set(id, new Uint8Array(arr));
          }
        }
        const invite: import('../group/index.js').GroupInvite = {
          groupId: inv.groupId,
          groupName: inv.groupName,
          invitedBy: inv.invitedBy,
          senderKeys,
          members: inv.members,
          memberEdKeys,
        };
        this.pendingGroupInvites.set(inv.groupId, invite);
        this.onGroupInviteHandler?.(inv.groupId, inv.groupName, inv.invitedBy, inv.members)
          ?.catch(() => {});
        break;
      }

      case 'handshake_activate':
        // Silent: the very act of decrypting this message ran the receiver's
        // first DH ratchet step, which is the whole point. Nothing else to do.
        break;

      case 'group_leave': {
        if (!ctrl.groupId) break;
        const group = this.groupManager.getGroup(ctrl.groupId);
        if (!group || !group.members.has(fromPeerId)) break;
        // If the leaver was the admin and didn't explicitly transfer first,
        // fall back to making the group adminless rather than leaving it
        // permanently un-administered. (An admin who wants to nominate a
        // successor sends group_admin_change before group_leave.)
        if (group.treeRoot === fromPeerId) {
          this.groupManager.setAdmin(ctrl.groupId, '');
          this.onGroupAdminChangedHandler?.(ctrl.groupId, '', fromPeerId);
        }
        this.groupManager.removeMember(ctrl.groupId, fromPeerId);
        this.onGroupMemberLeftHandler?.(ctrl.groupId, fromPeerId);
        break;
      }

      case 'group_member_added': {
        if (!ctrl.groupId || !ctrl.addedPeerId || !ctrl.addedSenderKey) break;
        const group = this.groupManager.getGroup(ctrl.groupId);
        if (!group) break;
        // Sender authorisation: only the group's tree root (creator/admin)
        // may add members. Adminless groups (treeRoot === '') let any
        // current member add — they are explicitly opting into trust.
        const senderIsAdmin = group.treeRoot === fromPeerId;
        const adminless = group.treeRoot === '';
        const senderIsMember = group.members.has(fromPeerId);
        if (!senderIsAdmin && !(adminless && senderIsMember)) break;
        if (group.members.has(ctrl.addedPeerId)) break;

        const senderKey = new Uint8Array(ctrl.addedSenderKey);
        this.groupManager.addMember(ctrl.groupId, ctrl.addedPeerId, senderKey);

        // Make sure we can reach the new peer for pairwise messages.
        if (ctrl.addedEdKey) {
          const edKey = new Uint8Array(ctrl.addedEdKey);
          this.sessionManager.rememberPeerEdKey(ctrl.addedPeerId, edKey);
        }
        if (!this.peerCache.getPeerPublicKey(ctrl.addedPeerId)) {
          this.peerCache.addPeer(ctrl.addedPeerId, hexToUint8Array(ctrl.addedPeerId));
        }
        this.storage?.set(`peers/${ctrl.addedPeerId}`, ctrl.addedPeerId).catch(() => {});

        this.onGroupMemberAddedHandler?.(ctrl.groupId, ctrl.addedPeerId, fromPeerId);
        break;
      }

      case 'group_admin_change': {
        if (!ctrl.groupId || ctrl.newAdminId === undefined) break;
        const group = this.groupManager.getGroup(ctrl.groupId);
        if (!group) break;
        // Only the current admin can transfer the role. Reject otherwise.
        if (group.treeRoot !== fromPeerId) break;
        // newAdminId === '' → adminless. Otherwise must be a member.
        if (ctrl.newAdminId !== '' && !group.members.has(ctrl.newAdminId)) break;
        this.groupManager.setAdmin(ctrl.groupId, ctrl.newAdminId);
        this.onGroupAdminChangedHandler?.(ctrl.groupId, ctrl.newAdminId, fromPeerId);
        break;
      }

      case 'group_member_kicked': {
        if (!ctrl.groupId || !ctrl.kickedPeerId) break;
        const group = this.groupManager.getGroup(ctrl.groupId);
        if (!group) break;
        // Authorization: only the current admin can kick. Adminless groups
        // intentionally have no kick capability — members can only self-leave.
        if (group.treeRoot !== fromPeerId) break;
        if (!group.members.has(ctrl.kickedPeerId)) break;

        const me = this.getLocalPeerId();
        if (ctrl.kickedPeerId === me) {
          // We were kicked. Wipe local state for the group entirely;
          // we are no longer in it.
          this.groupManager.leaveGroup(ctrl.groupId);
          this.onKickedFromGroupHandler?.(ctrl.groupId, fromPeerId);
        } else {
          // Someone else was kicked. Drop them from our roster.
          this.groupManager.removeMember(ctrl.groupId, ctrl.kickedPeerId);
          this.onGroupMemberKickedHandler?.(ctrl.groupId, ctrl.kickedPeerId, fromPeerId);
        }
        break;
      }

      case 'reaction': {
        if (!ctrl.messageId || typeof ctrl.reactionEmoji !== 'string' || typeof ctrl.reactionAdd !== 'boolean') break;
        // Group-scoped (sender set ctrl.groupId) → apply to the group
        // conversation; DM → apply against the sender peer. The reacting
        // peerId stored in the reactions map is always the sender, so
        // groups correctly accumulate one reaction per member.
        const conversationId = ctrl.groupId ?? fromPeerId;
        void this.messageHandler.applyReaction(
          conversationId, ctrl.messageId, fromPeerId, ctrl.reactionEmoji, ctrl.reactionAdd,
        ).then((outcome) => {
          if (outcome === 'noop') return;
          this.onReactionUpdatedHandler?.(
            conversationId, ctrl.messageId!, fromPeerId, ctrl.reactionEmoji!, ctrl.reactionAdd!,
          );
        }).catch(() => {});
        break;
      }

      case 'disappearing_messages': {
        const ttl = ctrl.disappearingTtlMs;
        const normalized = typeof ttl === 'number' && ttl > 0 ? Math.floor(ttl) : null;
        // For groups, the TTL applies to the group conversation; for DMs
        // it applies to the peer conversation. The changed-by callback
        // receives the originating peerId either way.
        const conversationId = ctrl.groupId ?? fromPeerId;
        const current = this.disappearingMessages.get(conversationId) ?? null;
        if (current === normalized) break; // no-op
        if (normalized === null) {
          this.disappearingMessages.delete(conversationId);
        } else {
          this.disappearingMessages.set(conversationId, normalized);
        }
        this.persistDisappearingMessages().catch(() => {});
        try {
          this.onDisappearingMessagesChangedHandler?.(conversationId, normalized, fromPeerId);
        } catch { /* swallow handler throws */ }
        break;
      }

      case 'sync_send': {
        // A mirror of an outbound message from one of our own devices.
        // Security: the sender's account must match ours. Without this
        // check any contact could inject "you said X" into your history.
        if (
          typeof ctrl.syncRecipientId !== 'string' ||
          typeof ctrl.syncIsGroup !== 'boolean' ||
          typeof ctrl.syncMessageId !== 'string' ||
          typeof ctrl.syncTimestamp !== 'number' ||
          !Array.isArray(ctrl.syncPayload)
        ) break;
        const me = this.getLocalPeerId();
        const myAccountKey = this.permissionManager.getAccountForDevice(me) ?? me;
        const senderAccountKey = this.permissionManager.getAccountForDevice(fromPeerId);
        if (senderAccountKey !== myAccountKey) break; // not from one of our devices
        const payloadBytes = new Uint8Array(ctrl.syncPayload);
        const expiresAt = ctrl.syncExpiry
          ? ctrl.syncTimestamp + ctrl.syncExpiry * 1000
          : undefined;
        const stored: import('../persistence/types.js').StoredMessage = {
          id: ctrl.syncMessageId,
          conversationId: ctrl.syncRecipientId,
          senderId: me, // we sent it, on the other device
          recipientId: ctrl.syncRecipientId,
          payload: Array.from(payloadBytes),
          timestamp: ctrl.syncTimestamp,
          direction: 'outbound',
          status: 'sent',
          ...(expiresAt ? { expiresAt } : {}),
          ...(ctrl.syncIsGroup ? { groupId: ctrl.syncRecipientId, groupSenderId: me } : {}),
          ...(ctrl.syncReplyTo ? { replyTo: ctrl.syncReplyTo } : {}),
          ...(ctrl.syncForwardedFrom ? { forwardedFrom: ctrl.syncForwardedFrom } : {}),
        };
        this.messageHandler.saveMessage(stored).then(() => {
          // Surface to the app so UIs can refresh the conversation view.
          // The Message shape mirrors what the original sender's saveMessage
          // would have stored on the sending device.
          const message: import('../types.js').Message = {
            id: stored.id,
            senderId: me,
            recipientId: ctrl.syncRecipientId!,
            payload: payloadBytes,
            timestamp: stored.timestamp,
            urgency: 'normal',
            ...(ctrl.syncExpiry ? { expiry: ctrl.syncExpiry } : {}),
            ...(ctrl.syncIsGroup ? { groupId: ctrl.syncRecipientId, groupSenderId: me } : {}),
            ...(ctrl.syncReplyTo ? { replyTo: ctrl.syncReplyTo } : {}),
            ...(ctrl.syncForwardedFrom ? { forwardedFrom: ctrl.syncForwardedFrom } : {}),
          };
          try { this.config.onMessage?.(message); } catch { /* swallow */ }
        }).catch(() => {});
        break;
      }

      case 'group_rename': {
        if (!ctrl.groupId || typeof ctrl.newGroupName !== 'string') break;
        const group = this.groupManager.getGroup(ctrl.groupId);
        if (!group) break;
        // Authorisation: the rename must come from the current admin, or
        // from any current member if the group is adminless. Anything else
        // is silently dropped — a stray rename from a non-admin shouldn't
        // be able to confuse our local UI.
        const isFromAdmin = group.treeRoot === fromPeerId;
        const isAdminless = group.treeRoot === '';
        const isFromMember = group.members.has(fromPeerId);
        if (!isFromAdmin && !(isAdminless && isFromMember)) break;
        const applied = this.groupManager.setName(ctrl.groupId, ctrl.newGroupName.trim());
        if (applied) {
          this.onGroupRenamedHandler?.(ctrl.groupId, ctrl.newGroupName.trim(), fromPeerId);
        }
        break;
      }

      case 'request_history':
        this.handleHistoryRequest(fromPeerId, ctrl.historySince).catch(() => {});
        break;

      case 'history_replay':
        this.handleHistoryReplay(fromPeerId, ctrl).catch(() => {});
        break;

      case 'session_ping': {
        // The fact that we decrypted this ping is itself proof that our
        // receive direction works. Replying with the matching pong proves
        // the same for the sender. No payload beyond the correlation id.
        if (!ctrl.sessionPingId) break;
        this.sendControl(fromPeerId, { __mw_ctrl: 'session_pong', sessionPingId: ctrl.sessionPingId });
        break;
      }

      case 'session_pong':
        if (ctrl.sessionPingId) this.resolvePendingPing(fromPeerId, ctrl.sessionPingId);
        break;

      case 'device_added':
      case 'device_revoked':
        if (ctrl.deviceAnnouncement) {
          this.applyDeviceAnnouncement(fromPeerId, ctrl.__mw_ctrl, ctrl.deviceAnnouncement);
        }
        break;

      case 'device_linked':
        if (ctrl.deviceLinked) {
          this.handleDeviceLinked(fromPeerId, ctrl.deviceLinked).catch(() => { /* swallow */ });
        }
        break;
    }
  }

  // ================================================================
  // History recovery — peer-to-peer
  // ================================================================

  /**
   * Ask `peerId` to replay their view of the conversation back to us. Used
   * when local state was wiped (accidental delete, fresh device after the
   * archive had already excluded this peer) but the peer still has the
   * messages on their side.
   *
   * The peer's app decides whether to honour the request via its
   * onHistoryRequest callback. If they accept, the messages stream back as
   * `history_replay` control messages and land in local storage, after
   * which onHistoryRestored fires.
   */
  static async requestHistory(peerId: string): Promise<void> {
    return MeshWhisper.instance.requestHistoryInstance(peerId);
  }

  async requestHistoryInstance(peerId: string): Promise<void> {
    this.assertRunning();
    // Send a single control message; the peer (if they consent) will reply
    // with one or more history_replay chunks.
    this.sendControl(peerId, { __mw_ctrl: 'request_history' });
  }

  /** Cap per chunk so encrypted ratchet packets stay well under any single-
   *  message limit. 50 messages * typical envelope size easily fits. */
  private static readonly HISTORY_CHUNK_SIZE = 50;

  private async handleHistoryRequest(requesterPeerId: string, since?: number): Promise<void> {
    const handler = this.config.onHistoryRequest;
    if (!handler) return; // Default: refuse silently — apps must opt in.

    let approved: boolean;
    try {
      approved = await handler(requesterPeerId);
    } catch {
      approved = false;
    }
    if (!approved) return;

    if (!this.storage) return;
    const raw = await this.storage.get(`messages/${requesterPeerId}`);
    if (!raw) return;
    let stored: Array<{
      id: string;
      senderId: string;
      recipientId: string;
      payload: number[];
      timestamp: number;
      expiresAt?: number;
      groupSenderId?: string;
    }>;
    try {
      stored = JSON.parse(raw);
    } catch {
      return;
    }
    const filtered = since !== undefined
      ? stored.filter((m) => m.timestamp > since)
      : stored;
    if (filtered.length === 0) return;

    const chunkSize = MeshWhisper.HISTORY_CHUNK_SIZE;
    const total = Math.ceil(filtered.length / chunkSize);
    for (let i = 0; i < total; i++) {
      const chunk = filtered.slice(i * chunkSize, (i + 1) * chunkSize);
      this.sendControl(requesterPeerId, {
        __mw_ctrl: 'history_replay',
        historyMessages: chunk.map((m) => ({
          id: m.id,
          senderId: m.senderId,
          recipientId: m.recipientId,
          payload: m.payload,
          timestamp: m.timestamp,
          ...(m.expiresAt !== undefined ? { expiresAt: m.expiresAt } : {}),
          ...(m.groupSenderId ? { groupSenderId: m.groupSenderId } : {}),
        })),
        historyChunkIndex: i,
        historyChunkTotal: total,
      });
    }
  }

  private async handleHistoryReplay(
    fromPeerId: string,
    ctrl: import('./utils.js').ControlMessage,
  ): Promise<void> {
    if (!ctrl.historyMessages || ctrl.historyMessages.length === 0) return;
    if (!this.storage) return;

    const me = this.getLocalPeerId();
    let inserted = 0;

    await this.messageHandler.storageMutex.run(`messages/${fromPeerId}`, async () => {
      const storage = this.storage!;
      const key = `messages/${fromPeerId}`;
      const raw = await storage.get(key);
      const existing: import('../persistence/types.js').StoredMessage[] = raw ? JSON.parse(raw) : [];
      const seenIds = new Set(existing.map((m) => m.id));
      const additions: import('../persistence/types.js').StoredMessage[] = [];

      for (const m of ctrl.historyMessages ?? []) {
        if (!m.id || seenIds.has(m.id)) continue;
        // Translate direction from the sender's view to ours. Sender's
        // outbound (senderId = them) becomes our inbound; their inbound
        // (senderId = us) becomes our outbound. recipientId is preserved
        // as-is because it already encodes "intended for X."
        const isOutboundOnRecover = m.senderId === me;
        const restored: import('../persistence/types.js').StoredMessage = {
          id: m.id,
          conversationId: fromPeerId,
          senderId: m.senderId,
          recipientId: m.recipientId,
          payload: m.payload,
          timestamp: m.timestamp,
          direction: isOutboundOnRecover ? 'outbound' : 'inbound',
          // Recovered messages from the peer's archive — we can only know
          // they were delivered to that peer at least once (they had them).
          // Mark inbound as 'read' (we already saw these once) and outbound
          // as 'delivered' (best assumption without the peer's read receipt).
          status: isOutboundOnRecover ? 'delivered' : 'read',
          ...(m.expiresAt !== undefined ? { expiresAt: m.expiresAt } : {}),
          ...(m.groupSenderId ? { groupSenderId: m.groupSenderId } : {}),
        };
        additions.push(restored);
        seenIds.add(m.id);
      }

      if (additions.length === 0) return;
      const merged = [...existing, ...additions].sort((a, b) => a.timestamp - b.timestamp);
      await storage.set(key, JSON.stringify(merged));
      inserted = additions.length;
    });

    if (inserted > 0) {
      try { this.config.onHistoryRestored?.(fromPeerId, inserted); } catch { /* swallow */ }
    }
  }

  /**
   * Internal: broadcast a group_leave control message to every other
   * current member of the group. Used by GroupHandle.leave(). Each
   * message is queued through sendControl, so the relay's store-and-
   * forward delivers to offline members when they come back.
   */
  private async leaveGroupBroadcast(groupId: string): Promise<void> {
    const group = this.groupManager.getGroup(groupId);
    if (!group) return;
    const me = this.getLocalPeerId();
    for (const memberId of group.members.keys()) {
      if (memberId === me) continue;
      this.sendControl(memberId, { __mw_ctrl: 'group_leave', groupId });
    }
  }

  /**
   * Internal: add a member to a group and tell everyone about it. Used
   * by GroupHandle.addMember. The local user must be the group's
   * creator/admin; throws otherwise.
   */
  private async addGroupMemberBroadcast(groupId: string, newPeerId: string): Promise<void> {
    const group = this.groupManager.getGroup(groupId);
    if (!group) throw new Error(`Unknown group ${groupId}`);
    const me = this.getLocalPeerId();
    // Permission: admin (treeRoot === me) OR group is adminless (treeRoot === '').
    // Otherwise: refuse.
    if (group.treeRoot !== '' && group.treeRoot !== me) {
      throw new Error('Only the group admin can add members');
    }
    if (group.members.has(newPeerId)) return;

    const newMemberEdKey = this.sessionManager.getPeerEdKey(newPeerId);
    if (!newMemberEdKey) {
      throw new Error(
        `Cannot add ${newPeerId} to group: no Ed25519 key cached. Add them as a contact first.`,
      );
    }

    // Generate the new member's sender key locally and stash it. The
    // same key is then sent both to the new member (in the invite) and
    // to existing members (in group_member_added) so everyone agrees.
    this.groupManager.addMember(groupId, newPeerId);
    const newSenderKey = this.groupManager.getSenderKey(groupId, newPeerId);
    if (!newSenderKey) throw new Error('Failed to generate sender key for new member');

    const updatedMembers = this.groupManager.getMembers(groupId);

    // 1) Tell the new member they've been invited (regular group_invite
    //    flow — they'll see the invitation modal and choose to accept).
    const senderKeysRecord: Record<string, number[]> = {};
    const memberEdKeysRecord: Record<string, number[]> = {};
    for (const m of updatedMembers) {
      const key = this.groupManager.getSenderKey(groupId, m.id);
      if (key) senderKeysRecord[m.id] = Array.from(key);
      if (m.id === me) continue;
      const edKey = this.sessionManager.getPeerEdKey(m.id);
      if (edKey) memberEdKeysRecord[m.id] = Array.from(edKey);
    }
    this.sendControl(newPeerId, {
      __mw_ctrl: 'group_invite',
      groupInvite: {
        groupId,
        groupName: group.name,
        invitedBy: me,
        members: updatedMembers.map((m) => m.id),
        senderKeys: senderKeysRecord,
        memberEdKeys: memberEdKeysRecord,
      },
    });

    // 2) Tell each existing member about the new addition so they can
    //    update their roster and store the new member's keys.
    for (const m of updatedMembers) {
      if (m.id === me || m.id === newPeerId) continue;
      this.sendControl(m.id, {
        __mw_ctrl: 'group_member_added',
        groupId,
        addedPeerId: newPeerId,
        addedEdKey: Array.from(newMemberEdKey),
        addedSenderKey: Array.from(newSenderKey),
      });
    }
  }

  /**
   * Internal: kick a member from a group and tell everyone (including
   * the kicked member) about it. Used by GroupHandle.kickMember. Only
   * the current admin can call this. Updates local state immediately
   * and the kicked member self-cleans on receipt of the broadcast.
   */
  private async kickGroupMemberBroadcast(groupId: string, kickedPeerId: string): Promise<void> {
    const group = this.groupManager.getGroup(groupId);
    if (!group) throw new Error(`Unknown group ${groupId}`);
    const me = this.getLocalPeerId();
    if (group.treeRoot !== me) {
      throw new Error('Only the group admin can kick members');
    }
    if (kickedPeerId === me) {
      throw new Error('Use leave() to remove yourself from a group, not kickMember()');
    }
    if (!group.members.has(kickedPeerId)) {
      throw new Error(`${kickedPeerId} is not a member of this group`);
    }

    // Capture the current member list BEFORE removing — we want to
    // notify the kicked member too, and removeMember would drop them
    // from the iterator.
    const recipients = [...group.members.keys()].filter((id) => id !== me);
    this.groupManager.removeMember(groupId, kickedPeerId);

    for (const memberId of recipients) {
      this.sendControl(memberId, {
        __mw_ctrl: 'group_member_kicked',
        groupId,
        kickedPeerId,
      });
    }
  }

  /**
   * Internal: transfer the admin role of a group, or convert it to
   * adminless (newAdminId === ''). Only the current admin (treeRoot)
   * can call this. Updates local state and broadcasts a
   * group_admin_change control message to every other current member.
   */
  private async transferGroupAdminBroadcast(groupId: string, newAdminId: string): Promise<void> {
    const group = this.groupManager.getGroup(groupId);
    if (!group) throw new Error(`Unknown group ${groupId}`);
    const me = this.getLocalPeerId();
    if (group.treeRoot !== me) {
      throw new Error('Only the current admin can transfer the admin role');
    }
    if (newAdminId !== '' && !group.members.has(newAdminId)) {
      throw new Error(`New admin ${newAdminId} is not a current group member`);
    }
    this.groupManager.setAdmin(groupId, newAdminId);
    for (const memberId of group.members.keys()) {
      if (memberId === me) continue;
      this.sendControl(memberId, {
        __mw_ctrl: 'group_admin_change',
        groupId,
        newAdminId,
      });
    }
  }

  /**
   * Rename a group and broadcast the change to every other current
   * member. Only the current admin (or any member of an adminless group)
   * can call this. Updates local state first so a partial broadcast
   * still leaves the initiating device with the new name.
   */
  private async renameGroupBroadcast(groupId: string, newName: string): Promise<void> {
    const group = this.groupManager.getGroup(groupId);
    if (!group) throw new Error(`Unknown group ${groupId}`);
    const trimmed = newName.trim();
    if (!trimmed) throw new Error('Group name cannot be empty');
    const me = this.getLocalPeerId();
    const isAdmin = group.treeRoot === me;
    const isAdminless = group.treeRoot === '';
    if (!isAdmin && !isAdminless) {
      throw new Error('Only the current admin can rename the group (or any member if adminless)');
    }
    if (group.name === trimmed) return; // no-op
    this.groupManager.setName(groupId, trimmed);
    for (const memberId of group.members.keys()) {
      if (memberId === me) continue;
      this.sendControl(memberId, {
        __mw_ctrl: 'group_rename',
        groupId,
        newGroupName: trimmed,
      });
    }
  }

  /**
   * Regenerates our relay reputation proof from the current ledger state
   * and sends it to all contacts we have sessions with.
   */
  /**
   * Looks up a peer's username from the relay directory by their peer ID.
   * Returns undefined if the peer hasn't registered a username, or if the
   * directory lookup fails. Useful for backfilling display names when the
   * application-level handshake message that originally carried the
   * username never arrived.
   */
  static async resolveUsername(peerId: string): Promise<string | undefined> {
    return MeshWhisper.instance.resolveUsername(peerId);
  }

  async resolveUsername(peerId: string): Promise<string | undefined> {
    this.assertRunning();
    const edKey = this.sessionManager.getPeerEdKey(peerId);
    if (!edKey) return undefined;
    const result = await this.sessionManager.lookupPreKeyBundle(uint8ArrayToHex(edKey));
    return result?.username;
  }

  /**
   * Returns true if `identifier` is not currently claimed by another
   * identity in this namespace's directory. Returns true if the
   * identifier is already ours.
   *
   * Use this before `setIdentifier()` or during a registration flow
   * to give the user a clean "that handle is taken — try another"
   * affordance.
   *
   * Availability is a point-in-time check. Two clients can both
   * observe "available" and race to register; treat the result as
   * a hint, and handle the race with retry-on-collision logic if
   * the consequence matters.
   *
   * See [docs/identifier-patterns.md](../../docs/identifier-patterns.md).
   */
  static async checkIdentifierAvailable(identifier: string): Promise<boolean> {
    return MeshWhisper.instance.checkIdentifierAvailable(identifier);
  }

  async checkIdentifierAvailable(identifier: string): Promise<boolean> {
    this.assertRunning();
    if (!identifier) return false;
    const found = await this.sessionManager.lookupPreKeyBundle(`@${identifier}`);
    if (!found) return true;
    return found.publicKey === uint8ArrayToHex(this.identity.getEdPublicKey());
  }

  /**
   * Changes the identifier this device is registered under in the
   * relay's directory and republishes the prekey bundle so subsequent
   * lookups resolve to this peer.
   *
   * The cryptographic identity (peerId, keys, sessions, contacts) is
   * unchanged — only the human-readable handle moves.
   *
   * See [docs/identifier-patterns.md](../../docs/identifier-patterns.md).
   */
  static async setIdentifier(identifier: string): Promise<void> {
    return MeshWhisper.instance.setIdentifier(identifier);
  }

  async setIdentifier(identifier: string): Promise<void> {
    this.assertRunning();
    if (!identifier) throw new Error('Identifier cannot be empty');
    const bundle = this.sessionManager.getOrCreatePreKeyBundle();
    const result = await this.sessionManager.publishPreKeyBundle(bundle, identifier);
    if (result.usernameTaken) {
      throw new Error(
        `Identifier "${identifier}" is already claimed by a different identity ` +
        `in this namespace`,
      );
    }
    this.config.username = identifier;
  }

  /**
   * Sets the namespace-wide policy that governs username ownership.
   * Call once early in your app's lifecycle (before any user registers
   * a username) to opt into a non-default policy. Returns silently
   * if the namespace is already on this policy; throws if it's already
   * on a different one.
   *
   * Default for unrecorded namespaces is `'signed-transfer'` — a
   * username is sticky to whichever identity first claimed it. Choose
   * `'last-writer-wins'` for password-derived identity flows where
   * re-deriving the same key from credentials is the recovery story.
   *
   * See [docs/identifier-patterns.md](../../docs/identifier-patterns.md).
   */
  static async setNamespacePolicy(
    usernamePolicy: 'signed-transfer' | 'last-writer-wins',
  ): Promise<void> {
    return MeshWhisper.instance.setNamespacePolicy(usernamePolicy);
  }

  async setNamespacePolicy(
    usernamePolicy: 'signed-transfer' | 'last-writer-wins',
  ): Promise<void> {
    this.assertRunning();
    await this.sessionManager.setNamespacePolicy(usernamePolicy);
  }

  /**
   * Returns the effective namespace policy. Defaults to
   * `'signed-transfer'` if no row has been set on the relay.
   */
  static async getNamespacePolicy(): Promise<'signed-transfer' | 'last-writer-wins'> {
    return MeshWhisper.instance.getNamespacePolicy();
  }

  async getNamespacePolicy(): Promise<'signed-transfer' | 'last-writer-wins'> {
    this.assertRunning();
    return this.sessionManager.getNamespacePolicy();
  }

  /**
   * Mint a transfer token authorizing `toPublicKey` to take over
   * `username` in this namespace. Signed by this device's Ed25519
   * identity key — the relay accepts the resulting handover only if
   * this device is the current owner of the username.
   *
   * The token expires after `expiresInMs` (default 24h). Share it
   * with the recipient via any channel (QR, paste, message); it
   * isn't secret in the cryptographic sense, but it's bound to one
   * specific new owner key, so anyone else holding the token can't
   * redeem it.
   *
   * See [docs/identifier-patterns.md](../../docs/identifier-patterns.md).
   */
  static async createUsernameTransferToken(opts: {
    username: string;
    toPublicKey: string;
    expiresInMs?: number;
  }): Promise<UsernameTransferToken> {
    return MeshWhisper.instance.createUsernameTransferToken(opts);
  }

  async createUsernameTransferToken(opts: {
    username: string;
    toPublicKey: string;
    expiresInMs?: number;
  }): Promise<UsernameTransferToken> {
    this.assertRunning();
    if (!opts.username) throw new Error('username required');
    if (!opts.toPublicKey) throw new Error('toPublicKey required');
    const ttl = opts.expiresInMs ?? 24 * 60 * 60 * 1000;
    const expiresAt = Date.now() + ttl;
    const namespace = this.config.namespace;
    const fromPublicKey = uint8ArrayToHex(this.identity.getEdPublicKey());
    const message = buildCanonicalTransferMessage(
      namespace,
      opts.username,
      opts.toPublicKey,
      expiresAt,
    );
    const signature = ed25519.sign(message, this.identity.getEdPrivateKey());
    return {
      version: 'v1',
      namespace,
      username: opts.username,
      fromPublicKey,
      toPublicKey: opts.toPublicKey,
      expiresAt,
      signature: uint8ArrayToBase64(signature),
    };
  }

  /**
   * Accept a transfer token issued by the previous owner of a
   * username. Republishes this device's prekey bundle under the new
   * username, attaching the signed token so the relay accepts the
   * takeover under signed-transfer policy.
   *
   * Throws if the token is for a different recipient, namespace,
   * or has expired, or if the relay rejects the signature.
   */
  static async acceptUsernameTransfer(token: UsernameTransferToken): Promise<void> {
    return MeshWhisper.instance.acceptUsernameTransfer(token);
  }

  async acceptUsernameTransfer(token: UsernameTransferToken): Promise<void> {
    this.assertRunning();
    if (token.version !== 'v1') {
      throw new Error(`Unsupported transfer token version: ${String(token.version)}`);
    }
    const myPubHex = uint8ArrayToHex(this.identity.getEdPublicKey());
    if (token.toPublicKey.toLowerCase() !== myPubHex.toLowerCase()) {
      throw new Error('Transfer token is not addressed to this device');
    }
    if (token.namespace !== this.config.namespace) {
      throw new Error('Transfer token is for a different namespace');
    }
    if (Date.now() > token.expiresAt) {
      throw new Error('Transfer token has expired');
    }

    const bundle = this.sessionManager.getOrCreatePreKeyBundle();
    const result = await this.sessionManager.publishPreKeyBundle(bundle, token.username, {
      fromPublicKey: token.fromPublicKey,
      expiresAt: token.expiresAt,
      signature: token.signature,
    });
    if (!result.ok) {
      if (result.transferAuthInvalid) {
        throw new Error('Relay rejected transferAuth: signature/expiry/sender mismatch');
      }
      if (result.usernameTaken) {
        throw new Error('Username still claimed by a different identity (no transfer accepted)');
      }
      throw new Error('Failed to publish transferred bundle');
    }
    this.config.username = token.username;
  }

  // ================================================================
  // Public API — Multi-device announcements (phase B)
  //
  // The primary device of an account is the only signer for device
  // membership today: its identityKey IS the accountKey. Future
  // phases may introduce per-device signing certificates so secondary
  // devices can broadcast revocations independently, but for now any
  // change to the device list must originate from the primary.
  // ================================================================

  /**
   * Announce a newly-linked device to every contact. The current
   * device's Ed25519 identity key signs the canonical bytes:
   *   meshwhisper.device-added.v1\n{accountEdKey}\n{deviceEdKey}\n{addedAt}
   *
   * `newDevicePeerId` is the X25519 peerId (SDK convention) of the
   * new device. The Ed25519 key used in the wire format is looked up
   * from the SDK's known-peers cache — a session with `newDevicePeerId`
   * must have been established first (i.e. via `addContactByKey` or
   * `acceptDeviceLinkOffer`).
   *
   * Recipients derive X25519 from the announcement's Ed25519 keys,
   * trust-bind against the sender's peerId, verify the signature, and
   * apply to their local PermissionManager.
   *
   * The local PermissionManager is also updated immediately so this
   * device's own state reflects the announcement.
   */
  static async broadcastDeviceAdded(newDevicePeerId: string): Promise<void> {
    return MeshWhisper.instance.broadcastDeviceAdded(newDevicePeerId);
  }

  async broadcastDeviceAdded(newDevicePeerId: string): Promise<void> {
    this.assertRunning();
    if (!newDevicePeerId) throw new Error('newDevicePeerId required');
    const newDeviceEdKey = this.sessionManager.getPeerEdKey(newDevicePeerId);
    if (!newDeviceEdKey) {
      throw new Error(
        `Cannot broadcast device_added for ${newDevicePeerId.slice(0, 8)}…: ` +
        `no Ed25519 key known. Establish a session first via addContactByKey or acceptDeviceLinkOffer.`,
      );
    }
    const accountEdHex = uint8ArrayToHex(this.identity.getEdPublicKey());
    const deviceEdHex = uint8ArrayToHex(newDeviceEdKey);
    const addedAt = Date.now();
    const sig = ed25519.sign(
      buildCanonicalDeviceAddedMessage(accountEdHex, deviceEdHex, addedAt),
      this.identity.getEdPrivateKey(),
    );
    const announcement = {
      accountKey: accountEdHex,
      deviceKey: deviceEdHex,
      eventAt: addedAt,
      signature: uint8ArrayToBase64(sig),
    };
    // Local PermissionManager uses X25519 peerIds throughout (SDK
    // convention). The wire format carries Ed25519 (needed for
    // signature verification); receivers derive X25519 on apply.
    const myPeerId = this.getLocalPeerId();
    this.permissionManager.addDeviceToContact(myPeerId, newDevicePeerId);
    await this.persistContacts();
    for (const peerId of this.permissionManager.getContacts()) {
      if (peerId === myPeerId || peerId === newDevicePeerId) continue;
      this.sendControl(peerId, {
        __mw_ctrl: 'device_added',
        deviceAnnouncement: announcement,
      });
    }
  }

  /**
   * Announce that a device should no longer be considered part of the
   * account. Signed by the primary's Ed25519 identity key. Receivers
   * strip the deviceKey from their local view.
   */
  static async broadcastDeviceRevoked(revokedDevicePeerId: string): Promise<void> {
    return MeshWhisper.instance.broadcastDeviceRevoked(revokedDevicePeerId);
  }

  async broadcastDeviceRevoked(revokedDevicePeerId: string): Promise<void> {
    this.assertRunning();
    if (!revokedDevicePeerId) throw new Error('revokedDevicePeerId required');
    const revokedEdKey = this.sessionManager.getPeerEdKey(revokedDevicePeerId);
    if (!revokedEdKey) {
      throw new Error(
        `Cannot broadcast device_revoked for ${revokedDevicePeerId.slice(0, 8)}…: ` +
        `no Ed25519 key known.`,
      );
    }
    const accountEdHex = uint8ArrayToHex(this.identity.getEdPublicKey());
    const deviceEdHex = uint8ArrayToHex(revokedEdKey);
    const revokedAt = Date.now();
    const sig = ed25519.sign(
      buildCanonicalDeviceRevokedMessage(accountEdHex, deviceEdHex, revokedAt),
      this.identity.getEdPrivateKey(),
    );
    const announcement = {
      accountKey: accountEdHex,
      deviceKey: deviceEdHex,
      eventAt: revokedAt,
      signature: uint8ArrayToBase64(sig),
    };
    const myPeerId = this.getLocalPeerId();
    this.permissionManager.removeDeviceFromContact(myPeerId, revokedDevicePeerId);
    await this.persistContacts();
    for (const peerId of this.permissionManager.getContacts()) {
      if (peerId === myPeerId) continue;
      this.sendControl(peerId, {
        __mw_ctrl: 'device_revoked',
        deviceAnnouncement: announcement,
      });
    }
  }

  /**
   * Per-(account, device) latest applied event timestamp, for replay
   * protection against `device_added` / `device_revoked` announcements.
   * Without this, an attacker capturing a revocation could replay it
   * after the device was re-added and silently undo the re-add.
   *
   * Loaded from storage on init via `loadDeviceAnnouncementSeen`;
   * persisted on every successful apply via the same path that fires
   * `persistContacts`. The persisted shape is a plain object keyed by
   * `${accountX25519}:${deviceX25519}` → unix-ms eventAt.
   */
  private readonly deviceAnnouncementSeen: Map<string, number> = new Map();

  /**
   * In-memory pending link offer on the secondary. Set by
   * createDeviceLinkOffer, cleared on receipt of a matching
   * device_linked control. Not persisted — if the app reloads, the
   * user re-issues the offer.
   */
  private pendingLinkOffer: DeviceLinkOffer | null = null;

  /**
   * Mint a one-shot offer for a primary device to consume. This
   * device must already be initialised (so it has a published prekey
   * bundle the primary can use for X3DH). Default TTL is 5 minutes.
   *
   * Serialise the returned object to JSON and present it to the
   * primary via QR, deep link, paste — anything the user can scan or
   * type. The SDK does not render UI; the offer is just data.
   *
   * See [docs/multi-device.md](../../docs/multi-device.md) "Model 3 — Linked devices."
   */
  static async createDeviceLinkOffer(opts?: { ttlMs?: number }): Promise<DeviceLinkOffer> {
    return MeshWhisper.instance.createDeviceLinkOffer(opts);
  }

  async createDeviceLinkOffer(opts?: { ttlMs?: number }): Promise<DeviceLinkOffer> {
    this.assertRunning();
    const ttl = opts?.ttlMs ?? 5 * 60 * 1000;
    const linkChallenge = uint8ArrayToBase64(randomBytes(16));
    const offer: DeviceLinkOffer = {
      version: 'v1',
      deviceEdKey: uint8ArrayToHex(this.identity.getEdPublicKey()),
      namespace: this.config.namespace,
      linkChallenge,
      expiresAt: Date.now() + ttl,
    };
    this.pendingLinkOffer = offer;
    return offer;
  }

  /**
   * Consume a DeviceLinkOffer produced by a secondary device. The
   * caller must be the primary of the account (i.e. its identityKey
   * is the accountKey for the new device's membership). Establishes a
   * ratchet session with the secondary via its relay-published
   * prekey bundle, mints a signed device_added announcement, sends
   * the device_linked bootstrap payload back over the new session,
   * and broadcasts the device_added to every existing contact.
   */
  static async acceptDeviceLinkOffer(offer: DeviceLinkOffer): Promise<void> {
    return MeshWhisper.instance.acceptDeviceLinkOffer(offer);
  }

  async acceptDeviceLinkOffer(offer: DeviceLinkOffer): Promise<void> {
    this.assertRunning();
    if (offer.version !== 'v1') {
      throw new Error(`Unsupported device-link-offer version: ${String(offer.version)}`);
    }
    if (offer.namespace !== this.config.namespace) {
      throw new Error('Link offer is for a different namespace');
    }
    if (Date.now() > offer.expiresAt) {
      throw new Error('Link offer has expired');
    }

    // Establish a session with the secondary via its relay-published
    // bundle. We deliberately do NOT route through addContactByKey —
    // the secondary isn't a contact, it's about to become a device of
    // OUR account.
    const result = await this.sessionManager.lookupPreKeyBundle(offer.deviceEdKey);
    if (!result) {
      throw new Error('Secondary device prekey bundle not found at relay');
    }
    const { bundle, publicKey: secondaryEdHex } = result;
    const edPubBytes = hexToUint8Array(secondaryEdHex);
    const x25519PubBytes = edwardsToMontgomeryPub(edPubBytes);
    const secondaryPeerId = uint8ArrayToHex(x25519PubBytes);

    this.sessionManager.setBundle(secondaryPeerId, bundle);
    this.peerCache.addPeer(secondaryPeerId, x25519PubBytes);
    this.storage?.set(`peers/${secondaryPeerId}`, uint8ArrayToHex(x25519PubBytes)).catch(() => {});

    const existing = this.sessionManager.getSession(secondaryPeerId);
    if (!existing || existing.sendingChainKey === null) {
      await this.sessionManager.initiateHandshake(secondaryPeerId, bundle);
    }
    const session = this.sessionManager.getSession(secondaryPeerId);
    if (!session) {
      throw new Error('Failed to establish session with secondary device');
    }
    await this.waitForSendableSession(secondaryPeerId, session);

    // Mint the signed device_added announcement.
    const accountEdHex = uint8ArrayToHex(this.identity.getEdPublicKey());
    const deviceEdHex = secondaryEdHex;
    const addedAt = Date.now();
    const sig = ed25519.sign(
      buildCanonicalDeviceAddedMessage(accountEdHex, deviceEdHex, addedAt),
      this.identity.getEdPrivateKey(),
    );
    const announcement = {
      accountKey: accountEdHex,
      deviceKey: deviceEdHex,
      eventAt: addedAt,
      signature: uint8ArrayToBase64(sig),
    };

    // Local PermissionManager update: secondary joins our own account.
    const myPeerId = this.getLocalPeerId();
    this.permissionManager.addDeviceToContact(myPeerId, secondaryPeerId);
    await this.persistContacts();

    // Send the bootstrap payload to the secondary over the new session.
    this.sendControl(secondaryPeerId, {
      __mw_ctrl: 'device_linked',
      deviceLinked: {
        linkChallenge: offer.linkChallenge,
        deviceAnnouncement: announcement,
        contactRecords: this.permissionManager.getContactRecords(),
      },
    });

    // Broadcast device_added to every existing contact so their local
    // routing picks up the new device. Skip ourselves and the secondary
    // (the secondary gets the announcement embedded in device_linked).
    for (const peerId of this.permissionManager.getContacts()) {
      if (peerId === myPeerId || peerId === secondaryPeerId) continue;
      this.sendControl(peerId, {
        __mw_ctrl: 'device_added',
        deviceAnnouncement: announcement,
      });
    }
  }

  /**
   * Inbound device_linked handler. Fires on the secondary when the
   * primary completes acceptDeviceLinkOffer. Validates the challenge
   * echo and the embedded device_added announcement, imports the
   * primary's contact list, and updates local state so this device is
   * now part of the account.
   */
  private async handleDeviceLinked(
    fromPeerId: string,
    deviceLinked: {
      linkChallenge: string;
      deviceAnnouncement: { accountKey: string; deviceKey: string; eventAt: number; signature: string };
      contactRecords: Array<{ accountKey: string; deviceKeys: string[] }>;
    },
  ): Promise<void> {
    const pending = this.pendingLinkOffer;
    if (!pending) return;
    if (deviceLinked.linkChallenge !== pending.linkChallenge) return;
    if (Date.now() > pending.expiresAt) {
      this.pendingLinkOffer = null;
      return;
    }

    // The announcement must add OUR ed-key to its account.
    const ourEdHex = uint8ArrayToHex(this.identity.getEdPublicKey());
    if (deviceLinked.deviceAnnouncement.deviceKey !== ourEdHex) return;

    // Verify the signature.
    if (!verifyDeviceAnnouncementSignature('device_added', deviceLinked.deviceAnnouncement)) return;

    // Derive primary's X25519 peerId and trust-bind to fromPeerId.
    let primaryPeerId: string;
    try {
      primaryPeerId = uint8ArrayToHex(
        edwardsToMontgomeryPub(hexToUint8Array(deviceLinked.deviceAnnouncement.accountKey)),
      );
    } catch { return; }
    if (primaryPeerId !== fromPeerId) return;

    // Import the contact list and record our own membership.
    this.permissionManager.loadContactRecords(deviceLinked.contactRecords ?? []);
    this.permissionManager.addDeviceToContact(primaryPeerId, this.getLocalPeerId());
    await this.persistContacts();

    // Clear the pending offer so a second device_linked can't
    // overwrite the link.
    this.pendingLinkOffer = null;

    // Fire the app's callback.
    try {
      this.config.onDeviceLinked?.(primaryPeerId, (deviceLinked.contactRecords ?? []).length);
    } catch { /* swallow handler throws */ }
  }

  private applyDeviceAnnouncement(
    fromPeerId: string,
    kind: 'device_added' | 'device_revoked',
    announcement: { accountKey: string; deviceKey: string; eventAt: number; signature: string },
  ): void {
    // Wire format carries Ed25519 hex (signatures require it). Derive
    // the X25519 peerIds that PermissionManager uses everywhere else.
    let accountX25519: string;
    let deviceX25519: string;
    try {
      accountX25519 = uint8ArrayToHex(
        edwardsToMontgomeryPub(hexToUint8Array(announcement.accountKey)),
      );
      deviceX25519 = uint8ArrayToHex(
        edwardsToMontgomeryPub(hexToUint8Array(announcement.deviceKey)),
      );
    } catch { return; }

    // Trust model: the sender of a device announcement must BE the
    // account it claims to act for. fromPeerId is X25519 (SDK
    // convention); accountKey on the wire is Ed25519; we derive and
    // compare. A future phase introducing per-device signing
    // certificates would relax this check and verify against a stored
    // account-cert chain instead.
    if (accountX25519 !== fromPeerId) return;
    if (!verifyDeviceAnnouncementSignature(kind, announcement)) return;

    // LWW replay guard, keyed by the X25519 pair.
    const seenKey = `${accountX25519}:${deviceX25519}`;
    const seen = this.deviceAnnouncementSeen.get(seenKey) ?? 0;
    if (announcement.eventAt <= seen) return;
    this.deviceAnnouncementSeen.set(seenKey, announcement.eventAt);

    if (kind === 'device_added') {
      this.permissionManager.addDeviceToContact(accountX25519, deviceX25519);
    } else {
      this.permissionManager.removeDeviceFromContact(accountX25519, deviceX25519);
    }
    this.persistContacts().catch(() => {});
    // Persist the replay-guard map alongside the contacts write so a
    // fresh device boot inherits the same protection.
    this.persistDeviceAnnouncementSeen().catch(() => {});
  }

  private async persistDeviceAnnouncementSeen(): Promise<void> {
    if (!this.storage) return;
    const obj: Record<string, number> = {};
    for (const [k, v] of this.deviceAnnouncementSeen) obj[k] = v;
    await writeDeviceAnnouncementSeen(this.storage, obj);
  }

  /**
   * Public verification helper. Returns true if the announcement is
   * cryptographically well-formed and signs exactly the expected
   * canonical bytes. Does NOT check trust binding (whether the sender
   * is actually the account) — that's a per-application decision and
   * is performed inside the SDK's inbound handler.
   */
  static verifyDeviceAnnouncement(
    kind: 'device_added' | 'device_revoked',
    announcement: { accountKey: string; deviceKey: string; eventAt: number; signature: string },
  ): boolean {
    return verifyDeviceAnnouncementSignature(kind, announcement);
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

    // Contacts. Prefer the v2 (account/device) format; fall back to v1
    // (flat string[] of peerIds) for installs that haven't yet been
    // upgraded. The v2 loader treats single-device entries identically
    // to the v1 ones, so behavior is preserved.
    const contactsV2Raw = await this.storage.get('contacts_v2');
    if (contactsV2Raw) {
      try {
        this.permissionManager.loadContactRecords(
          JSON.parse(contactsV2Raw) as Array<{ accountKey: string; deviceKeys: string[] }>,
        );
      } catch { /* fall through to v1 */ }
    }
    if (this.permissionManager.getContacts().length === 0) {
      const contactsRaw = await this.storage.get('contacts');
      if (contactsRaw) {
        this.permissionManager.loadContacts(JSON.parse(contactsRaw) as string[]);
      }
    }
    // Rebuild peerCache from contacts — the X25519 peerId is the public key hex,
    // so we can restore it without a relay lookup even if peers/ keys are missing.
    for (const peerId of this.permissionManager.getContacts()) {
      if (!this.peerCache.getPeerPublicKey(peerId)) {
        this.peerCache.addPeer(peerId, hexToUint8Array(peerId));
      }
    }

    // Blocked peers
    const blockedRaw = await this.storage.get('blocked');
    if (blockedRaw) {
      for (const peerId of JSON.parse(blockedRaw) as string[]) {
        this.permissionManager.blockPeer(peerId);
      }
    }

    // Device-announcement replay-protection timestamps. Without
    // rehydrating this, a fresh boot would have an empty Map and a
    // replayed revocation would be accepted — silently undoing a
    // post-snapshot re-add.
    const seen = await readDeviceAnnouncementSeen(this.storage);
    for (const [k, v] of Object.entries(seen)) this.deviceAnnouncementSeen.set(k, v);

    // Disappearing-messages policy. Rehydrate per-conversation TTLs so
    // sends auto-apply the policy after a restart without the app
    // having to re-set it.
    const disappearingRaw = await this.storage.get(MeshWhisper.DISAPPEARING_KEY);
    if (disappearingRaw) {
      try {
        const obj = JSON.parse(disappearingRaw) as Record<string, number>;
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === 'number' && v > 0) this.disappearingMessages.set(k, v);
        }
      } catch { /* malformed — ignore, falls back to no-policy */ }
    }
  }

  private async persistContacts(): Promise<void> {
    if (!this.storage) return;
    // Dual-write during the v1→v2 transition so a rollback to an older
    // SDK build still finds usable contact state. Drop the v1 write
    // once the SDK version that only reads v2 has been deployed long
    // enough that no older client is expected to come back.
    await this.storage.set('contacts', JSON.stringify(this.permissionManager.getContacts()));
    await this.storage.set(
      'contacts_v2',
      JSON.stringify(this.permissionManager.getContactRecords()),
    );
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
    // Listen on the full blob-TTL window (30 days = 720 hours). Without
    // this, hourly destHash rotation causes "push notification but no
    // message" symptoms: a blob queued at hour H is stored under
    // destHash(H), but a recipient reconnecting at H+N only asks for
    // recent hashes. The blob is stranded until TTL expiry. Listening on
    // the full TTL window means anything the relay still has, we will
    // receive — at the cost of telling the relay "I might have been away
    // for up to 30 days," which is a coarse-grained signal compared to
    // the per-message timing the relay sees in real time anyway.
    const hashes: string[] = [];
    for (let i = 0; i < 720; i++) {
      hashes.push(uint8ArrayToHex(deriveDestHash(nsId, xPub, hour - i)));
    }
    return hashes;
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
