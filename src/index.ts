// ============================================================
// MeshWhisper SDK — Main Entry Point
// Re-exports the public API surface and all public types.
// ============================================================

// --- Primary SDK class ---

export { MeshWhisper, GroupHandle } from './sdk/index.js';
export type { SendOptions, CreateGroupOptions, TransportChangedEvent } from './sdk/index.js';

// --- Public types from shared type definitions ---

export type {
  // Crypto
  KeyPair,
  PreKeyBundle,
  EncryptedPayload,

  // Packet
  Packet,

  // Transport
  BearerType,
  BatteryState,
  RelayWillingness,
  DeviceCapability,
  Transport,

  // Routing
  PeerProximityEntry,
  RouteRequest,
  RouteOffer,

  // Session
  PermissionModel,
  Session,

  // Message
  MessageUrgency,
  PresenceStatus,
  Message,

  // Group
  GroupMember,
  Group,

  // Reciprocity
  RelayLedgerEntry,
  ReciprocityTier,

  // Cluster
  ClusterDevice,

  // Store-and-Forward
  StoredBlob,

  // Sybil
  EntropySensorType,
  EntropyChallenge,
  EntropyResponse,

  // Chaff
  ChaffRate,

  // Compliance
  AuditExportMode,
  ComplianceConfig,
  MessageHook,

  // SDK Config
  MeshWhisperConfig,

  // Namespace
  NamespaceConfig,

  // Events
  EventEmitter,
} from './types.js';

// Re-export PacketFlags as a value (enum) since it is used as both
// a type and a runtime value.
export { PacketFlags } from './types.js';

// --- Re-export the P2P bridge interface for native platform implementors ---

export type { PlatformP2PBridge, PeerInfo } from './transport/p2p/index.js';
export { registerPlatformBridge } from './transport/p2p/index.js';
