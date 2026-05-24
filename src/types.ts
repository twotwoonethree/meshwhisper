// ============================================================
// MeshWhisper SDK — Shared Types & Interfaces
// All modules code against these types.
// ============================================================

// --- Crypto Types ---

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/**
 * Ed25519 key pair — used for identity and signing only.
 * Never pass to a DH function; convert via edwardsToMontgomeryPub/Priv first.
 */
export interface IdentityKeyPair extends KeyPair {
  readonly keyType: 'identity';
}

/**
 * X25519 key pair — used for Diffie-Hellman operations only.
 * Never sign with this; use the corresponding IdentityKeyPair instead.
 */
export interface DHKeyPair extends KeyPair {
  readonly keyType: 'dh';
}

export interface PreKeyBundle {
  identityKey: Uint8Array;
  signedPreKey: Uint8Array;
  signedPreKeySignature: Uint8Array;
  oneTimePreKey?: Uint8Array;
  /** ML-KEM-768 public key (1184 bytes). Present on PQXDH-capable bundles. */
  pqPublicKey?: Uint8Array;
}

export interface EncryptedPayload {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  tag: Uint8Array;
}

// --- Packet Types ---

export enum PacketFlags {
  DATA = 0x01,
  ACK = 0x02,
  CHAFF = 0x03,
  HANDSHAKE = 0x04,
  ROUTE_REQUEST = 0x05,
  ROUTE_OFFER = 0x06,
}

export interface Packet {
  version: number;
  flags: PacketFlags;
  destHash: Uint8Array;       // 8 bytes — truncated BLAKE3
  senderEphemeralId: Uint8Array; // 16 bytes — rotating
  ttl: number;                // max 7
  payloadLength: number;
  encryptedPayload: Uint8Array;
}

// --- Transport Types ---

export type BearerType = 'platform_p2p' | 'local_net' | 'internet';
export type BatteryState = 'charging' | 'high' | 'medium' | 'low' | 'critical';
export type RelayWillingness = 'eager' | 'willing' | 'reluctant' | 'unavailable';

export interface DeviceCapability {
  bearerPlatformP2P: boolean;
  bearerLocalNet: boolean;
  bearerInternet: boolean;
  inboundConnectable: boolean;
  batteryState: BatteryState;
  relayWillingness: RelayWillingness;
}

export interface Transport {
  readonly type: BearerType;
  send(packet: Packet, destination: string): Promise<void>;
  onReceive(callback: (packet: Packet, source: string) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  isAvailable(): Promise<boolean>;
}

// --- Routing Types ---

export interface PeerProximityEntry {
  peerId: string;
  destHash: Uint8Array;
  lastSeen: number;
  hopCount: number;
  latency: number;
  relayPath: string[];
}

export interface RouteRequest {
  destHash: Uint8Array;
  requestId: Uint8Array;
  ttl: number;
  timestamp: number;
}

export interface RouteOffer {
  requestId: Uint8Array;
  hopCount: number;
  estimatedLatency: number;
  offeredBy: string;
}

// --- Session Types ---

export type PermissionModel = 'open' | 'mutual' | 'introduction' | 'transactional' | 'custom';

export interface Session {
  peerId: string;
  namespaceId: Uint8Array;
  sharedSecret: Uint8Array;
  established: number;
  lastActivity: number;
}

// --- Message Types ---

export type MessageUrgency = 'background' | 'normal' | 'urgent' | 'critical';
export type PresenceStatus = 'online' | 'recently_seen' | 'offline' | 'unknown';

export interface Message {
  id: string;
  senderId: string;
  recipientId: string;
  payload: Uint8Array;
  timestamp: number;
  urgency: MessageUrgency;
  expiry?: number;
  /** Set when the message was sent to a group. */
  groupId?: string;
  /** The original sender within the group (may differ from senderId when relayed). */
  groupSenderId?: string;
}

// --- Group Types ---

export interface GroupMember {
  id: string;
  senderKey: Uint8Array;
  role: 'admin' | 'member';
  joinedAt: number;
}

export interface Group {
  id: string;
  name: string;
  members: Map<string, GroupMember>;
  treeRoot: string;
  permissionModel: PermissionModel;
  createdAt: number;
}

// --- Reciprocity Types ---

export interface RelayLedgerEntry {
  peerId: string;
  bytesRelayedForThem: number;
  bytesTheyRelayedForUs: number;
  lastUpdated: number;
}

export type ReciprocityTier = 'contributor' | 'balanced' | 'consumer' | 'freerider';

// --- Cluster Types ---

export interface ClusterDevice {
  deviceId: string;
  clusterKey: Uint8Array;
  capabilities: DeviceCapability;
  isPrimary: boolean;
  lastSync: number;
}

// --- Store-and-Forward Types ---

export interface StoredBlob {
  id: string;
  destHash: Uint8Array;
  encryptedPayload: Uint8Array;
  receivedAt: number;
  ttlHours: number;
  hopsRemaining: number;
}

// --- Sybil Resistance Types ---

export type EntropySensorType = 'accelerometer' | 'gyroscope' | 'magnetometer';

export interface EntropyChallenge {
  challengeId: Uint8Array;
  sensorType: EntropySensorType;
  durationMs: number;
  timestamp: number;
}

export interface EntropyResponse {
  challengeId: Uint8Array;
  sensorData: Float64Array;
  deviceSignature: Uint8Array;
}

// --- Chaff Types ---

export type ChaffRate = 'low' | 'normal' | 'high';

// --- Compliance Types ---

export type AuditExportMode = 'plaintext' | 'encrypted';

export interface ComplianceConfig {
  logging?: boolean;
  auditExport?: AuditExportMode;
  retentionDays?: number;
  contentScanning?: (msg: Message) => { approved: boolean; reason?: string };
}

export type MessageHook = (message: Message) => boolean | Promise<boolean>;

// --- SDK Config Types ---

// Re-export persistence types so callers only need one import
export type { StorageBackend, StoredMessage, Conversation } from './persistence/types.js';

/** Web Push subscription object (serialisable form of PushSubscription). */
export interface WebPushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export type PushConfig =
  | { platform: 'apns'; token: string; topic?: string }
  | { platform: 'fcm'; token: string }
  | { platform: 'webpush'; subscription: WebPushSubscription };

export interface MeshWhisperConfig {
  namespace: string;
  /** MeshWhisper Node endpoint(s). Use "mesh" for Foundation-hosted nodes,
   *  a wss:// URL for self-hosted, or an array for hybrid mode. Defaults to "mesh". */
  node?: string | string[];
  /**
   * Human-readable username registered with the relay alongside your pre-key bundle.
   * Other users can add you via `MeshWhisper.addContactByKey('@alice')` instead of
   * needing your raw public key. Usernames are scoped to the namespace and
   * first-registered wins. Omit to stay key-only.
   */
  username?: string;
  /** Optional developer key (base64 public key). If omitted a random key is used,
   *  which is fine for development and single-tenant deployments. */
  developerKey?: string;
  /** Default: "open". */
  permissionModel?: PermissionModel;
  /** Push notification token. When set the Node stores the token alongside
   *  the device's destination hashes and sends a wake signal via the configured
   *  push webhook when a message arrives while the device is offline. */
  push?: PushConfig;
  /**
   * Persistent storage backend. Provide this to survive process restarts:
   * sessions, message history, identity, and contacts are all persisted.
   *
   * For Node.js: `import { NodeStorage } from '@meshwhisper/sdk/persistence/node'`
   * For React Native: wrap AsyncStorage or SQLCipher.
   */
  storage?: import('./persistence/types.js').StorageBackend;
  onMessage?: (message: Message) => void;
  onPresence?: (peerId: string, status: PresenceStatus) => void;
  /** Called when the delivery status of an outbound message changes. */
  onMessageStatus?: (messageId: string, status: import('./persistence/types.js').StoredMessage['status']) => void;
  /**
   * Called when a recoverable error occurs (e.g. sendMessage fails because no
   * session could be established, or the Node connection drops and reconnect
   * fails). Fatal errors that prevent startup still reject the init() promise.
   */
  onError?: (error: Error) => void;
  /** Called when the WebSocket connection to the Node goes up or down.
   *  Use this to show a connectivity indicator in your UI.
   *  Messages sent while disconnected are queued and flushed automatically on reconnect. */
  onConnectionStatus?: (status: 'connected' | 'disconnected') => void;
  /**
   * Called whenever the SDK writes a tombstone or revival event that *must*
   * reach the relay archive before the next reload — otherwise stale remote
   * state can resurrect a deleted peer or re-suppress a revived one. The app
   * should respond by pushing the archive immediately (no debounce).
   *
   * Fires from: deleteConversation, acceptContact, addContactByKey,
   * inbound x3dh_init (onContactEstablished), and acceptGroupInvite.
   *
   * `reason` describes which event triggered the dirtying, useful for logging.
   */
  onArchiveDirty?: (reason: 'tombstone' | 'revival') => void;
  /**
   * Called when a connected peer issues an entropy (proof-of-physical-device) challenge.
   * Collect `durationMs` milliseconds of readings from the requested sensor and return them.
   * If not provided, the challenge is silently ignored and the peer marks us as "unverified"
   * (lower relay priority) rather than "failed" (blocked).
   *
   * **PWA / browser:** use the built-in helpers. Call `requestSensorPermission()` once from
   * a user-gesture handler at startup (required on iOS 13+), then wire `collectSensorData`
   * directly:
   * ```ts
   * import { requestSensorPermission, collectSensorData } from '@meshwhisper/sdk'
   *
   * // In your "Start" button handler:
   * await requestSensorPermission()
   *
   * MeshWhisper.init({
   *   onEntropyChallenge: (_peerId, sensorType, durationMs) =>
   *     collectSensorData(sensorType, durationMs),
   * })
   * ```
   *
   * **React Native (expo-sensors):**
   * ```ts
   * onEntropyChallenge: async (_peerId, sensorType, durationMs) => {
   *   const samples: number[] = [];
   *   const sub = Accelerometer.addListener(({ x, y, z }) => samples.push(x, y, z));
   *   await new Promise(r => setTimeout(r, durationMs));
   *   sub.remove();
   *   return new Float64Array(samples);
   * }
   * ```
   */
  onEntropyChallenge?: (
    peerId: string,
    sensorType: EntropySensorType,
    durationMs: number,
  ) => Promise<Float64Array>;
  /**
   * Called when a peer starts or stops typing.
   * `isTyping` is true for typing_start, false for typing_stop.
   * Ephemeral — not stored or reliable.
   */
  onTyping?: (peerId: string, isTyping: boolean) => void;
  /**
   * Called when another peer introduces a new contact to you. The `peerId` is
   * the introduced peer's identifier; `introducedBy` is the mutual contact who
   * brokered the introduction; `username` is their registered username if any.
   *
   * Call `MeshWhisper.addContactByKey(peerId)` from this handler to accept.
   * If you don't call it the introduction is silently ignored.
   *
   * ```ts
   * onContactRequest: async (peerId, introducedBy, username) => {
   *   const display = username ?? peerId.slice(0, 8);
   *   const accepted = await showConfirmDialog(`${introducedBy} wants to introduce you to ${display}`);
   *   if (accepted) await MeshWhisper.addContactByKey(peerId);
   * }
   * ```
   */
  onContactRequest?: (peerId: string, introducedBy: string, username?: string) => void | Promise<void>;
  /**
   * Called when another peer invites you to a group. The group is held in a
   * pending state until you call `MeshWhisper.acceptGroupInvite(groupId)`.
   * Decline by simply not calling it, or call `MeshWhisper.declineGroupInvite(groupId)`.
   */
  onGroupInvite?: (groupId: string, groupName: string, invitedBy: string, members: string[]) => void | Promise<void>;

  /**
   * Fires when an existing group member leaves and sends a group_leave
   * control message. The peer has already been removed from the local
   * roster by the time this fires; the application typically responds by
   * persisting the change and surfacing an in-conversation system message.
   */
  onGroupMemberLeft?: (groupId: string, peerId: string) => void;

  /**
   * Fires when the group's admin adds a new member to a group we're
   * already in. By the time this fires the new member has been added
   * to the local roster, their sender key has been stored, and their
   * Ed25519 key has been registered with the session manager so that
   * sending pairwise messages to them works without further setup.
   */
  onGroupMemberAdded?: (groupId: string, peerId: string, addedBy: string) => void;

  /**
   * Fires when the admin of a group transfers their role or makes the
   * group adminless. `newAdminId === ''` means the group is now adminless
   * (any current member can add new members). Also fires implicitly when
   * the admin leaves without an explicit transfer — in that case
   * `changedBy` is the leaver and `newAdminId` is `''`.
   */
  onGroupAdminChanged?: (groupId: string, newAdminId: string, changedBy: string) => void;

  /**
   * Fires on remaining members when the admin kicks someone. The peer
   * has already been removed from the local roster by the time this
   * fires.
   */
  onGroupMemberKicked?: (groupId: string, peerId: string, kickedBy: string) => void;

  /**
   * Fires on the local user when *they* are kicked from a group.
   * Local group state has already been wiped — the application should
   * remove the conversation from its UI and surface a notification.
   */
  onKickedFromGroup?: (groupId: string, kickedBy: string) => void;
  config?: {
    relayWillingness?: 'auto' | RelayWillingness;
    chaffRate?: ChaffRate;
    storeTTL?: number;       // hours, default 72
    clusterEnabled?: boolean;
  };
}

// --- Namespace Types ---

export interface NamespaceConfig {
  appBundleId: string;
  developerPublicKey: Uint8Array;
}

// --- Event Emitter ---

export interface EventEmitter<T extends Record<string, unknown>> {
  on<K extends keyof T>(event: K, handler: (data: T[K]) => void): void;
  off<K extends keyof T>(event: K, handler: (data: T[K]) => void): void;
  emit<K extends keyof T>(event: K, data: T[K]): void;
}
