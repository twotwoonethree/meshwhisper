// ============================================================
// MeshWhisper SDK — Device Clustering Module
// Manages device self-clustering so a user's devices form a
// personal availability cluster (PRD §5.6).  The most capable
// device acts as primary receiver; messages sync across the
// cluster over local connections when connectivity allows.
// ============================================================

import { blake3 } from '@noble/hashes/blake3';
import type { ClusterDevice, DeviceCapability, BatteryState, RelayWillingness } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Domain separator for cluster key derivation. */
const CLUSTER_KEY_DOMAIN = 'meshwhisper-cluster-v1';

// ---------------------------------------------------------------------------
// Scoring tables for primary election
// ---------------------------------------------------------------------------

const BATTERY_SCORE: Record<BatteryState, number> = {
  charging: 5,
  high: 4,
  medium: 3,
  low: 2,
  critical: 1,
};

const CONNECTIVITY_SCORE = {
  internet: 3,
  local_net: 2,
  platform_p2p: 1,
  none: 0,
} as const;

const RELAY_SCORE: Record<RelayWillingness, number> = {
  eager: 4,
  willing: 3,
  reluctant: 2,
  unavailable: 1,
};

// ---------------------------------------------------------------------------
// SyncMessage
// ---------------------------------------------------------------------------

/**
 * A message queued for synchronization across the device cluster.
 */
export interface SyncMessage {
  messageId: string;
  encryptedPayload: Uint8Array;
  receivedAt: number;
  receivedBy: string;
  syncedTo: Set<string>;
}

// ---------------------------------------------------------------------------
// ClusterStatus
// ---------------------------------------------------------------------------

export interface ClusterStatus {
  deviceCount: number;
  primaryId: string;
  syncPending: number;
}

// ---------------------------------------------------------------------------
// MessageSyncManager
// ---------------------------------------------------------------------------

/**
 * Manages the queue of messages waiting to be synchronized to other
 * devices in the cluster.
 */
export class MessageSyncManager {
  private readonly messages: Map<string, SyncMessage> = new Map();

  /**
   * Enqueue a received message for sync to other cluster devices.
   */
  queueForSync(message: SyncMessage): void {
    if (!message.messageId) {
      throw new TypeError('SyncMessage must have a non-empty messageId');
    }
    // Clone syncedTo so the caller cannot mutate our internal state.
    this.messages.set(message.messageId, {
      ...message,
      syncedTo: new Set(message.syncedTo),
    });
  }

  /**
   * Retrieve all messages that have **not** yet been synced to `deviceId`.
   */
  getUnsyncedMessages(deviceId: string): SyncMessage[] {
    const result: SyncMessage[] = [];
    for (const msg of this.messages.values()) {
      if (!msg.syncedTo.has(deviceId)) {
        result.push(this.cloneMessage(msg));
      }
    }
    return result;
  }

  /**
   * Mark a single message as synced to a specific device.
   */
  markSynced(messageId: string, deviceId: string): void {
    const msg = this.messages.get(messageId);
    if (msg) {
      msg.syncedTo.add(deviceId);
    }
  }

  /**
   * Convenience method: returns all unsynced messages for `targetDeviceId`
   * and marks each one as synced to that device in a single pass.
   */
  sync(targetDeviceId: string): SyncMessage[] {
    const unsynced = this.getUnsyncedMessages(targetDeviceId);
    for (const msg of unsynced) {
      this.markSynced(msg.messageId, targetDeviceId);
    }
    return unsynced;
  }

  /**
   * Total count of messages that still need to be synced to at least one
   * device.  Used by `DeviceCluster.getClusterStatus()`.
   */
  getPendingCount(allDeviceIds: string[]): number {
    let count = 0;
    for (const msg of this.messages.values()) {
      for (const id of allDeviceIds) {
        if (!msg.syncedTo.has(id)) {
          count++;
          break; // only count each message once
        }
      }
    }
    return count;
  }

  /**
   * Remove all tracked messages.
   */
  clear(): void {
    this.messages.clear();
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private cloneMessage(msg: SyncMessage): SyncMessage {
    return {
      ...msg,
      syncedTo: new Set(msg.syncedTo),
    };
  }
}

// ---------------------------------------------------------------------------
// DeviceCluster
// ---------------------------------------------------------------------------

/**
 * Manages a personal device cluster.
 *
 * A cluster groups all of a single user's devices so they can:
 *  - elect a primary receiver (best battery/connectivity/willingness)
 *  - accept messages on behalf of the user from any member
 *  - synchronize messages to all other members when connectivity allows
 */
export class DeviceCluster {
  private readonly localDeviceId: string;
  private readonly clusterKey: Uint8Array;
  private readonly devices: Map<string, ClusterDevice> = new Map();
  private primaryDeviceId: string | null = null;
  private running = false;

  /** Public message sync manager. */
  readonly syncManager: MessageSyncManager = new MessageSyncManager();

  constructor(identityKey: Uint8Array, localDeviceId: string) {
    if (!localDeviceId) {
      throw new TypeError('localDeviceId must be a non-empty string');
    }
    if (identityKey.length === 0) {
      throw new TypeError('identityKey must not be empty');
    }

    this.localDeviceId = localDeviceId;
    this.clusterKey = DeviceCluster.deriveClusterKey(identityKey);
  }

  // -----------------------------------------------------------------------
  // Cluster key derivation
  // -----------------------------------------------------------------------

  /**
   * Derive a cluster key from the user's identity private key.
   *
   *   clusterKey = BLAKE3(identity_key || "meshwhisper-cluster-v1")
   */
  static deriveClusterKey(identityPrivateKey: Uint8Array): Uint8Array {
    const domain = new TextEncoder().encode(CLUSTER_KEY_DOMAIN);
    const input = new Uint8Array(identityPrivateKey.length + domain.length);
    input.set(identityPrivateKey, 0);
    input.set(domain, identityPrivateKey.length);
    return blake3(input);
  }

  // -----------------------------------------------------------------------
  // Device registration
  // -----------------------------------------------------------------------

  /**
   * Register a device in the cluster.
   */
  addDevice(device: ClusterDevice): void {
    if (!device.deviceId) {
      throw new TypeError('ClusterDevice must have a non-empty deviceId');
    }
    this.devices.set(device.deviceId, { ...device });

    if (this.running) {
      this.reelectPrimary();
    }
  }

  /**
   * Remove a device from the cluster.
   */
  removeDevice(deviceId: string): void {
    this.devices.delete(deviceId);

    if (this.primaryDeviceId === deviceId) {
      this.primaryDeviceId = null;
    }

    if (this.running && this.devices.size > 0) {
      this.reelectPrimary();
    }
  }

  /**
   * Return a snapshot of all devices currently in the cluster.
   */
  getDevices(): ClusterDevice[] {
    return Array.from(this.devices.values()).map((d) => ({ ...d }));
  }

  /**
   * Return the local device entry.
   *
   * @throws if the local device has not been added to the cluster.
   */
  getLocalDevice(): ClusterDevice {
    const local = this.devices.get(this.localDeviceId);
    if (!local) {
      throw new Error(
        `Local device "${this.localDeviceId}" has not been added to the cluster`,
      );
    }
    return { ...local };
  }

  /**
   * Check whether a device ID belongs to this cluster.
   */
  isClusterMember(deviceId: string): boolean {
    return this.devices.has(deviceId);
  }

  // -----------------------------------------------------------------------
  // Primary receiver election
  // -----------------------------------------------------------------------

  /**
   * Elect the most available device as primary receiver.
   *
   * Scoring criteria (in priority order):
   *  1. Battery state  (charging > high > medium > low > critical)
   *  2. Connectivity   (internet > local_net > platform_p2p)
   *  3. Relay willingness (eager > willing > reluctant > unavailable)
   *  4. Inbound connectable (true preferred)
   *
   * Returns the elected primary device, or throws if the cluster is empty.
   */
  electPrimary(): ClusterDevice {
    if (this.devices.size === 0) {
      throw new Error('Cannot elect primary: cluster has no devices');
    }

    let best: ClusterDevice | null = null;
    let bestScore = -1;

    for (const device of this.devices.values()) {
      const score = DeviceCluster.scoreDevice(device);
      if (score > bestScore) {
        bestScore = score;
        best = device;
      }
    }

    // best is guaranteed non-null because devices.size > 0
    const elected = best!;

    // Update isPrimary flags
    for (const device of this.devices.values()) {
      device.isPrimary = device.deviceId === elected.deviceId;
    }

    this.primaryDeviceId = elected.deviceId;
    return { ...elected, isPrimary: true };
  }

  /**
   * Return the current primary device, or `null` if no election has run.
   */
  getPrimary(): ClusterDevice | null {
    if (this.primaryDeviceId === null) {
      return null;
    }
    const device = this.devices.get(this.primaryDeviceId);
    return device ? { ...device } : null;
  }

  /**
   * Whether the local device is currently the primary receiver.
   */
  isPrimary(): boolean {
    return this.primaryDeviceId === this.localDeviceId;
  }

  // -----------------------------------------------------------------------
  // Capability updates
  // -----------------------------------------------------------------------

  /**
   * Update the local device's capabilities and re-elect primary if the
   * cluster is running.
   */
  updateLocalCapabilities(capabilities: DeviceCapability): void {
    const local = this.devices.get(this.localDeviceId);
    if (!local) {
      throw new Error(
        `Local device "${this.localDeviceId}" has not been added to the cluster`,
      );
    }
    local.capabilities = { ...capabilities };

    if (this.running) {
      this.reelectPrimary();
    }
  }

  /**
   * Handle a capability update broadcast from a remote device.
   */
  handleCapabilityUpdate(deviceId: string, capabilities: DeviceCapability): void {
    const device = this.devices.get(deviceId);
    if (!device) {
      throw new Error(`Device "${deviceId}" is not a member of this cluster`);
    }
    device.capabilities = { ...capabilities };

    if (this.running) {
      this.reelectPrimary();
    }
  }

  // -----------------------------------------------------------------------
  // Cluster lifecycle
  // -----------------------------------------------------------------------

  /**
   * Start cluster operations.  Triggers an initial primary election.
   */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;

    if (this.devices.size > 0) {
      this.reelectPrimary();
    }
  }

  /**
   * Stop cluster operations gracefully.
   */
  stop(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.primaryDeviceId = null;

    // Reset isPrimary on all devices
    for (const device of this.devices.values()) {
      device.isPrimary = false;
    }
  }

  /**
   * Return a summary of the current cluster state.
   */
  getClusterStatus(): ClusterStatus {
    const deviceIds = Array.from(this.devices.keys());
    return {
      deviceCount: this.devices.size,
      primaryId: this.primaryDeviceId ?? '',
      syncPending: this.syncManager.getPendingCount(deviceIds),
    };
  }

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------

  /** The derived cluster key shared by all devices. */
  getClusterKey(): Uint8Array {
    return new Uint8Array(this.clusterKey);
  }

  /** Whether the cluster has been started. */
  isRunning(): boolean {
    return this.running;
  }

  // -----------------------------------------------------------------------
  // Static scoring helpers
  // -----------------------------------------------------------------------

  /**
   * Compute an availability score for a device.
   *
   * Higher score = more suitable as primary receiver.
   * The score is a composite of battery, connectivity, relay willingness,
   * and inbound-connectable flag, weighted so battery dominates.
   */
  static scoreDevice(device: ClusterDevice): number {
    const cap = device.capabilities;

    const battery = BATTERY_SCORE[cap.batteryState];
    const connectivity = DeviceCluster.connectivityScore(cap);
    const relay = RELAY_SCORE[cap.relayWillingness];
    const inbound = cap.inboundConnectable ? 1 : 0;

    // Weight battery most heavily so charging/plugged-in devices are
    // strongly preferred, then connectivity, relay, inbound.
    return battery * 1000 + connectivity * 100 + relay * 10 + inbound;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Compute a connectivity score from capability flags.
   * A device can have multiple bearers; we use the best available.
   */
  private static connectivityScore(cap: DeviceCapability): number {
    if (cap.bearerInternet) return CONNECTIVITY_SCORE.internet;
    if (cap.bearerLocalNet) return CONNECTIVITY_SCORE.local_net;
    if (cap.bearerPlatformP2P) return CONNECTIVITY_SCORE.platform_p2p;
    return CONNECTIVITY_SCORE.none;
  }

  /**
   * Run a primary election and update internal state.
   */
  private reelectPrimary(): void {
    this.electPrimary();
  }
}
