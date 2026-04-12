// ============================================================
// MeshWhisper SDK — Shared Types & Interfaces
// All modules code against these types.
// ============================================================

// --- Crypto Types ---

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface PreKeyBundle {
  identityKey: Uint8Array;
  signedPreKey: Uint8Array;
  signedPreKeySignature: Uint8Array;
  oneTimePreKey?: Uint8Array;
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
export type { StorageBackend, StoredMessage } from './persistence/types.js';

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
  /** Called when the WebSocket connection to the Node goes up or down.
   *  Use this to show a connectivity indicator in your UI.
   *  Messages sent while disconnected are queued and flushed automatically on reconnect. */
  onConnectionStatus?: (status: 'connected' | 'disconnected') => void;
  /**
   * Called when a connected peer issues an entropy (proof-of-physical-device) challenge.
   * Collect `durationMs` milliseconds of readings from the requested sensor and return them.
   * If not provided, the challenge is silently ignored and the peer marks us as "unverified"
   * (lower relay priority) rather than "failed" (blocked).
   *
   * Example (React Native with expo-sensors):
   * ```ts
   * onEntropyChallenge: async (peerId, sensorType, durationMs) => {
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
  salt: Uint8Array;
}

// --- Event Emitter ---

export interface EventEmitter<T extends Record<string, unknown>> {
  on<K extends keyof T>(event: K, handler: (data: T[K]) => void): void;
  off<K extends keyof T>(event: K, handler: (data: T[K]) => void): void;
  emit<K extends keyof T>(event: K, data: T[K]): void;
}
