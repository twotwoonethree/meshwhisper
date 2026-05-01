// ============================================================
// MeshWhisper SDK — Group Messaging Module
// Dynamic Relay Trees (§10.1) and Sender Key Management (§10.2)
// ============================================================

import { gcm } from '@noble/ciphers/aes';
import { randomBytes } from '../crypto/index.js';
import type { Group, GroupMember, PermissionModel } from '../types.js';

// ---- Constants ----

/** Sender key length in bytes. */
const SENDER_KEY_LENGTH = 32;

/** AES-GCM nonce length in bytes (96-bit). */
const GCM_NONCE_LENGTH = 12;

/** AES-GCM authentication tag length in bytes. */
const GCM_TAG_LENGTH = 16;

/** Group ID length in bytes (128-bit random). */
const GROUP_ID_LENGTH = 16;

/** Activity window for relay tree scoring, in milliseconds (5 minutes). */
const ACTIVITY_WINDOW_MS = 5 * 60 * 1000;

/** Minimum interval between relay tree rebuilds, in milliseconds. */
const TREE_REBUILD_INTERVAL_MS = 60 * 1000;

// ---- Exported Interfaces ----

/** Relay tree node representing a group member's position in the relay topology. */
export interface TreeNode {
  peerId: string;
  children: TreeNode[];
  activityScore: number;
  lastActive: number;
}

/** Invitation payload to join a group, distributed via pairwise encrypted channels. */
export interface GroupInvite {
  groupId: string;
  groupName: string;
  invitedBy: string;
  senderKeys: Map<string, Uint8Array>;
  members: string[];
  /**
   * Per-member Ed25519 identity keys, keyed by peer ID. Required so that
   * accepting members can establish pairwise X3DH sessions with other
   * group members they haven't met before — X3DH lookup needs the
   * Ed25519 key, not just the X25519 routing key (= peer ID).
   * Optional for backwards-compat with invites generated before this field
   * existed; missing entries fall back to a relay directory lookup keyed
   * by the X25519 conversion (which the SDK can derive itself when needed).
   */
  memberEdKeys?: Map<string, Uint8Array>;
}

/** Distribution message for a single sender key. */
export interface SenderKeyDistribution {
  groupId: string;
  senderId: string;
  senderKey: Uint8Array;
  iteration: number;
}

// ---- Internal Types ----

/** Per-member activity tracking entry. */
interface ActivityRecord {
  timestamps: number[];
  lastActive: number;
}

/** Internal state associated with each group. */
interface GroupState {
  group: Group;
  /** Sender keys indexed by member peer ID. */
  senderKeys: Map<string, Uint8Array>;
  /** Key iteration counters indexed by member peer ID. */
  keyIterations: Map<string, number>;
  /** Activity history indexed by member peer ID. */
  activity: Map<string, ActivityRecord>;
  /** Cached relay tree root (rebuilt periodically). */
  relayTree: TreeNode | null;
  /** Timestamp of last relay tree rebuild. */
  lastTreeBuild: number;
}

// ============================================================
// GroupManager
// ============================================================

export class GroupManager {
  private readonly localPeerId: string;
  private readonly groups: Map<string, GroupState> = new Map();

  constructor(localPeerId: string) {
    this.localPeerId = localPeerId;
  }

  // ---- Group Lifecycle ----

  /**
   * Creates a new group. The local peer is the initial admin and tree root.
   * Generates sender keys for the local peer and all initial members.
   */
  createGroup(name: string, members: string[], permissionModel: PermissionModel): Group {
    const groupId = this.generateGroupId();
    const now = Date.now();

    const memberMap = new Map<string, GroupMember>();
    const senderKeys = new Map<string, Uint8Array>();
    const keyIterations = new Map<string, number>();
    const activity = new Map<string, ActivityRecord>();

    // Add self as admin
    const selfKey = this.generateSenderKey();
    memberMap.set(this.localPeerId, {
      id: this.localPeerId,
      senderKey: selfKey,
      role: 'admin',
      joinedAt: now,
    });
    senderKeys.set(this.localPeerId, selfKey);
    keyIterations.set(this.localPeerId, 0);
    activity.set(this.localPeerId, { timestamps: [], lastActive: now });

    // Add initial members
    for (const peerId of members) {
      if (peerId === this.localPeerId) continue;

      const memberKey = this.generateSenderKey();
      memberMap.set(peerId, {
        id: peerId,
        senderKey: memberKey,
        role: 'member',
        joinedAt: now,
      });
      senderKeys.set(peerId, memberKey);
      keyIterations.set(peerId, 0);
      activity.set(peerId, { timestamps: [], lastActive: now });
    }

    const group: Group = {
      id: groupId,
      name,
      members: memberMap,
      treeRoot: this.localPeerId,
      permissionModel,
      createdAt: now,
    };

    this.groups.set(groupId, {
      group,
      senderKeys,
      keyIterations,
      activity,
      relayTree: null,
      lastTreeBuild: 0,
    });

    return group;
  }

  /**
   * Joins an existing group using invite data received via a pairwise channel.
   * Stores all distributed sender keys from the invite.
   */
  joinGroup(groupId: string, inviteData: GroupInvite): Group {
    const now = Date.now();

    const memberMap = new Map<string, GroupMember>();
    const senderKeys = new Map<string, Uint8Array>();
    const keyIterations = new Map<string, number>();
    const activity = new Map<string, ActivityRecord>();

    // Populate members from the invite
    for (const peerId of inviteData.members) {
      const existingKey = inviteData.senderKeys.get(peerId);
      memberMap.set(peerId, {
        id: peerId,
        senderKey: existingKey ?? new Uint8Array(SENDER_KEY_LENGTH),
        role: peerId === inviteData.invitedBy ? 'admin' : 'member',
        joinedAt: now,
      });
      if (existingKey) {
        senderKeys.set(peerId, existingKey);
      }
      keyIterations.set(peerId, 0);
      activity.set(peerId, { timestamps: [], lastActive: now });
    }

    // Add self if not already in the member list
    if (!memberMap.has(this.localPeerId)) {
      const selfKey = this.generateSenderKey();
      memberMap.set(this.localPeerId, {
        id: this.localPeerId,
        senderKey: selfKey,
        role: 'member',
        joinedAt: now,
      });
      senderKeys.set(this.localPeerId, selfKey);
      keyIterations.set(this.localPeerId, 0);
      activity.set(this.localPeerId, { timestamps: [], lastActive: now });
    }

    const group: Group = {
      id: groupId,
      name: inviteData.groupName,
      members: memberMap,
      treeRoot: inviteData.invitedBy,
      permissionModel: 'open',
      createdAt: now,
    };

    this.groups.set(groupId, {
      group,
      senderKeys,
      keyIterations,
      activity,
      relayTree: null,
      lastTreeBuild: 0,
    });

    return group;
  }

  /**
   * Leaves a group, removing all local state for it.
   */
  leaveGroup(groupId: string): void {
    const state = this.requireGroupState(groupId);

    // Remove self from the member list
    state.group.members.delete(this.localPeerId);
    state.senderKeys.delete(this.localPeerId);
    state.keyIterations.delete(this.localPeerId);
    state.activity.delete(this.localPeerId);

    // Discard all local state for this group
    this.groups.delete(groupId);
  }

  /**
   * Returns the group with the given ID, or null if not found.
   */
  getGroup(groupId: string): Group | null {
    const state = this.groups.get(groupId);
    return state?.group ?? null;
  }

  /**
   * Returns all groups the local peer is participating in.
   */
  getGroups(): Group[] {
    return Array.from(this.groups.values()).map((s) => s.group);
  }

  // ---- Member Management ----

  /**
   * Adds a new member to the group. The admin (creator) generates a fresh
   * sender key locally; non-admin members reach this via a
   * group_member_added control message and pass through `providedKey` so
   * everyone agrees on the new member's sender key.
   */
  addMember(groupId: string, peerId: string, providedKey?: Uint8Array): void {
    const state = this.requireGroupState(groupId);

    if (state.group.members.has(peerId)) {
      return; // Already a member
    }

    const now = Date.now();
    const memberKey = providedKey ?? this.generateSenderKey();

    state.group.members.set(peerId, {
      id: peerId,
      senderKey: memberKey,
      role: 'member',
      joinedAt: now,
    });
    state.senderKeys.set(peerId, memberKey);
    state.keyIterations.set(peerId, 0);
    state.activity.set(peerId, { timestamps: [], lastActive: now });

    // Invalidate cached tree
    state.relayTree = null;
  }

  /**
   * Removes a member from the group. Each remaining member calls this
   * locally on receipt of a group_leave (or group_kick) control message
   * to keep their roster in sync.
   *
   * KNOWN LIMITATION — forward secrecy on member removal: a previous
   * version of this method also called rotateAllSenderKeys to invalidate
   * the leaver's keys. That rotation is local-only and was never
   * distributed to the other remaining members, so every member ended
   * up with a different "new" key and group messaging silently broke.
   * The rotation is disabled here until proper key-distribution is
   * implemented (each member rotates only their own key and broadcasts
   * the new key to other current members via a future
   * `group_sender_key_update` control message). Until then, a leaver
   * who keeps a copy of the other members' sender keys can still
   * decrypt traffic they intercept after leaving. The relay never
   * sees plaintext, so this only matters against an adversary with
   * separate wire-level intercept capability.
   */
  removeMember(groupId: string, peerId: string): void {
    const state = this.requireGroupState(groupId);

    if (!state.group.members.has(peerId)) {
      return; // Not a member
    }

    state.group.members.delete(peerId);
    state.senderKeys.delete(peerId);
    state.keyIterations.delete(peerId);
    state.activity.delete(peerId);

    // Invalidate cached tree
    state.relayTree = null;
  }

  /**
   * Returns the list of all members in a group.
   */
  getMembers(groupId: string): GroupMember[] {
    const state = this.requireGroupState(groupId);
    return Array.from(state.group.members.values());
  }

  /**
   * Returns the role of a member in a group, or null if not a member.
   */
  getMemberRole(groupId: string, peerId: string): 'admin' | 'member' | null {
    const state = this.groups.get(groupId);
    if (!state) return null;
    const member = state.group.members.get(peerId);
    return member?.role ?? null;
  }

  /**
   * Updates a member's role within the group.
   */
  setMemberRole(groupId: string, peerId: string, role: 'admin' | 'member'): void {
    const state = this.requireGroupState(groupId);
    const member = state.group.members.get(peerId);
    if (!member) {
      throw new Error(`Peer ${peerId} is not a member of group ${groupId}`);
    }
    member.role = role;
  }

  // ---- Sender Keys ----

  /**
   * Generates a new 32-byte sender key using cryptographically secure randomness.
   */
  generateSenderKey(): Uint8Array {
    return randomBytes(SENDER_KEY_LENGTH);
  }

  /**
   * Creates a sender key distribution message for a specific recipient.
   * This message should be encrypted via the pairwise channel before transmission.
   */
  distributeSenderKey(
    groupId: string,
    senderKey: Uint8Array,
    _recipientId: string,
  ): SenderKeyDistribution {
    const state = this.requireGroupState(groupId);
    const iteration = state.keyIterations.get(this.localPeerId) ?? 0;

    // Store locally
    state.senderKeys.set(this.localPeerId, senderKey);
    const member = state.group.members.get(this.localPeerId);
    if (member) {
      member.senderKey = senderKey;
    }

    return {
      groupId,
      senderId: this.localPeerId,
      senderKey,
      iteration,
    };
  }

  /**
   * Processes a received sender key distribution message from another member.
   */
  receiveSenderKey(distribution: SenderKeyDistribution): void {
    const state = this.groups.get(distribution.groupId);
    if (!state) {
      throw new Error(`Unknown group ${distribution.groupId}`);
    }

    state.senderKeys.set(distribution.senderId, distribution.senderKey);
    state.keyIterations.set(distribution.senderId, distribution.iteration);

    const member = state.group.members.get(distribution.senderId);
    if (member) {
      member.senderKey = distribution.senderKey;
    }
  }

  /**
   * Rotates all sender keys in a group. Called when a member is removed
   * to ensure forward secrecy.
   */
  rotateAllSenderKeys(groupId: string): void {
    const state = this.requireGroupState(groupId);

    for (const [peerId, member] of state.group.members) {
      const newKey = this.generateSenderKey();
      const currentIteration = state.keyIterations.get(peerId) ?? 0;

      member.senderKey = newKey;
      state.senderKeys.set(peerId, newKey);
      state.keyIterations.set(peerId, currentIteration + 1);
    }
  }

  /**
   * Update a group's admin ('treeRoot'). Pass `''` for adminless. Used
   * when the admin transfers their role or steps down. Also called
   * implicitly when the admin leaves without an explicit transfer —
   * the receiving side falls back to adminless rather than leaving the
   * group in a permanently broken state.
   */
  setAdmin(groupId: string, newAdminId: string): void {
    const state = this.groups.get(groupId);
    if (!state) return;
    // Adminless is allowed (newAdminId === ''). Otherwise the new admin
    // must already be a current member.
    if (newAdminId !== '' && !state.group.members.has(newAdminId)) return;
    state.group.treeRoot = newAdminId;
    state.relayTree = null;
  }

  /**
   * Returns the sender key for a specific member in a group, or null if unknown.
   */
  getSenderKey(groupId: string, memberId: string): Uint8Array | null {
    const state = this.groups.get(groupId);
    if (!state) return null;
    return state.senderKeys.get(memberId) ?? null;
  }

  /**
   * Encrypts plaintext for the group using the local peer's sender key.
   * Uses AES-256-GCM. The ciphertext format is: nonce (12) || ciphertext || tag (16).
   */
  encryptForGroup(
    groupId: string,
    plaintext: Uint8Array,
  ): { ciphertext: Uint8Array; senderId: string } {
    const state = this.requireGroupState(groupId);
    const senderKey = state.senderKeys.get(this.localPeerId);
    if (!senderKey) {
      throw new Error('No sender key available for local peer');
    }

    const nonce = randomBytes(GCM_NONCE_LENGTH);
    const cipher = gcm(senderKey, nonce);
    const sealed = cipher.encrypt(plaintext);

    // Pack as: nonce || sealed (which is ciphertext || tag)
    const result = new Uint8Array(GCM_NONCE_LENGTH + sealed.length);
    result.set(nonce, 0);
    result.set(sealed, GCM_NONCE_LENGTH);

    // Record activity
    this.updateActivity(groupId, this.localPeerId);

    return { ciphertext: result, senderId: this.localPeerId };
  }

  /**
   * Decrypts a group message from a specific sender using their sender key.
   * Expects the ciphertext format: nonce (12) || ciphertext || tag (16).
   */
  decryptFromGroup(
    groupId: string,
    senderId: string,
    ciphertext: Uint8Array,
  ): Uint8Array {
    const state = this.requireGroupState(groupId);
    const senderKey = state.senderKeys.get(senderId);
    if (!senderKey) {
      throw new Error(`No sender key for peer ${senderId} in group ${groupId}`);
    }

    if (ciphertext.length < GCM_NONCE_LENGTH + GCM_TAG_LENGTH) {
      throw new Error('Ciphertext too short');
    }

    const nonce = ciphertext.slice(0, GCM_NONCE_LENGTH);
    const sealed = ciphertext.slice(GCM_NONCE_LENGTH);

    const cipher = gcm(senderKey, nonce);
    return cipher.decrypt(sealed);
  }

  // ---- Dynamic Relay Tree ----

  /**
   * Records a message-send activity for a member. Used to compute
   * activity scores that drive relay tree topology.
   */
  updateActivity(groupId: string, peerId: string): void {
    const state = this.requireGroupState(groupId);
    const record = state.activity.get(peerId);
    if (!record) return;

    const now = Date.now();
    record.timestamps.push(now);
    record.lastActive = now;

    // Prune timestamps older than the activity window
    const cutoff = now - ACTIVITY_WINDOW_MS;
    record.timestamps = record.timestamps.filter((t) => t >= cutoff);
  }

  /**
   * Builds (or returns cached) relay tree for the group. The tree is
   * structured so that the most active members form the trunk near the
   * root, and less active members are leaves.
   *
   * The tree is rebuilt at most once per TREE_REBUILD_INTERVAL_MS.
   */
  buildRelayTree(groupId: string): TreeNode {
    const state = this.requireGroupState(groupId);
    const now = Date.now();

    // Return cached tree if still fresh
    if (
      state.relayTree &&
      now - state.lastTreeBuild < TREE_REBUILD_INTERVAL_MS
    ) {
      return state.relayTree;
    }

    const memberIds = Array.from(state.group.members.keys());
    if (memberIds.length === 0) {
      throw new Error(`Group ${groupId} has no members`);
    }

    // Compute activity scores
    const scores = new Map<string, number>();
    const cutoff = now - ACTIVITY_WINDOW_MS;

    for (const peerId of memberIds) {
      const record = state.activity.get(peerId);
      if (!record) {
        scores.set(peerId, 0);
        continue;
      }
      const recentTimestamps = record.timestamps.filter((t) => t >= cutoff);
      scores.set(peerId, recentTimestamps.length);
    }

    // Sort members by activity score descending; tie-break: tree root first, then ID
    const sorted = [...memberIds].sort((a, b) => {
      // Tree root (group creator) wins ties
      if (a === state.group.treeRoot && b !== state.group.treeRoot) return -1;
      if (b === state.group.treeRoot && a !== state.group.treeRoot) return 1;
      const scoreA = scores.get(a) ?? 0;
      const scoreB = scores.get(b) ?? 0;
      if (scoreB !== scoreA) return scoreB - scoreA;
      return a.localeCompare(b);
    });

    // Build a balanced relay tree: most active peer is root, next most active
    // peers fill the trunk (first children), less active are leaves.
    // We use a breadth-first insertion approach to build a roughly balanced tree.
    const nodeMap = new Map<string, TreeNode>();

    for (const peerId of sorted) {
      const record = state.activity.get(peerId);
      nodeMap.set(peerId, {
        peerId,
        children: [],
        activityScore: scores.get(peerId) ?? 0,
        lastActive: record?.lastActive ?? 0,
      });
    }

    const root = nodeMap.get(sorted[0])!;

    // BFS queue for balanced insertion — each node gets at most 2 children
    // to keep tree depth logarithmic
    const MAX_CHILDREN = 2;
    const queue: TreeNode[] = [root];
    let queueIdx = 0;

    for (let i = 1; i < sorted.length; i++) {
      const child = nodeMap.get(sorted[i])!;

      // Find the next parent with capacity
      while (queueIdx < queue.length && queue[queueIdx].children.length >= MAX_CHILDREN) {
        queueIdx++;
      }

      if (queueIdx < queue.length) {
        queue[queueIdx].children.push(child);
        queue.push(child);
      }
    }

    state.relayTree = root;
    state.lastTreeBuild = now;

    return root;
  }

  /**
   * Determines which peer should relay a message to reach the target peer.
   * Returns the parent of the target in the relay tree, or null if the
   * target is the root or not found.
   */
  getRelayTarget(groupId: string, targetPeerId: string): string | null {
    const tree = this.buildRelayTree(groupId);

    // BFS to find the parent of the target
    const queue: Array<{ node: TreeNode; parent: TreeNode | null }> = [
      { node: tree, parent: null },
    ];

    while (queue.length > 0) {
      const { node, parent } = queue.shift()!;

      if (node.peerId === targetPeerId) {
        return parent?.peerId ?? null;
      }

      for (const child of node.children) {
        queue.push({ node: child, parent: node });
      }
    }

    return null;
  }

  /**
   * Returns the list of peer IDs that the local peer should relay messages to
   * (i.e., the local peer's children in the relay tree).
   */
  getRelayChildren(groupId: string): string[] {
    const tree = this.buildRelayTree(groupId);
    const localNode = this.findNodeInTree(tree, this.localPeerId);
    if (!localNode) return [];
    return localNode.children.map((c) => c.peerId);
  }

  // ---- Group Message Routing ----

  /**
   * Routes a group message through the relay tree. Returns the list of peers
   * that the local peer should forward the message to, based on the relay
   * tree position.
   *
   * If the local peer is the sender (or root), it forwards to its children.
   * If the local peer is relaying, it forwards to its children plus its parent
   * (if the message didn't come from the parent direction).
   */
  routeGroupMessage(
    groupId: string,
    ciphertext: Uint8Array,
    senderId: string,
  ): Array<{ peerId: string; data: Uint8Array }> {
    const tree = this.buildRelayTree(groupId);
    const localNode = this.findNodeInTree(tree, this.localPeerId);

    if (!localNode) return [];

    const targets: Array<{ peerId: string; data: Uint8Array }> = [];

    // Recursively collect all descendants in a subtree so the sender can deliver
    // directly to every tree member. Each node is a direct relay connection (via
    // the MeshWhisper Node), so direct delivery is always possible.
    // NOTE: if hop-by-hop tree relay is ever implemented (incoming group relay
    // packets), change this back to direct-children-only for the sender case.
    const collectDescendants = (node: TreeNode): void => {
      for (const child of node.children) {
        if (child.peerId !== senderId) {
          targets.push({ peerId: child.peerId, data: ciphertext });
        }
        collectDescendants(child);
      }
    };

    // If we are the sender, deliver to all descendants in the relay tree.
    if (senderId === this.localPeerId) {
      collectDescendants(localNode);
    } else {
      // We are relaying — forward to our children (excluding the sender direction)
      for (const child of localNode.children) {
        if (child.peerId !== senderId && !this.isInSubtree(child, senderId)) {
          targets.push({ peerId: child.peerId, data: ciphertext });
        }
      }

      // Also forward to parent if the message came from a child
      const parent = this.findParentInTree(tree, this.localPeerId);
      if (parent && parent.peerId !== senderId) {
        targets.push({ peerId: parent.peerId, data: ciphertext });
      }
    }

    return targets;
  }

  // ---- Private Helpers ----

  /** Generates a random hex-encoded group ID. */
  private generateGroupId(): string {
    const bytes = randomBytes(GROUP_ID_LENGTH);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /** Retrieves group state or throws if the group is unknown. */
  private requireGroupState(groupId: string): GroupState {
    const state = this.groups.get(groupId);
    if (!state) {
      throw new Error(`Unknown group ${groupId}`);
    }
    return state;
  }

  /** Searches the relay tree for a node by peer ID. */
  private findNodeInTree(root: TreeNode, peerId: string): TreeNode | null {
    if (root.peerId === peerId) return root;
    for (const child of root.children) {
      const found = this.findNodeInTree(child, peerId);
      if (found) return found;
    }
    return null;
  }

  /** Finds the parent node of a given peer in the relay tree. */
  private findParentInTree(root: TreeNode, peerId: string): TreeNode | null {
    for (const child of root.children) {
      if (child.peerId === peerId) return root;
      const found = this.findParentInTree(child, peerId);
      if (found) return found;
    }
    return null;
  }

  /** Checks whether a peer is anywhere in the subtree rooted at the given node. */
  private isInSubtree(node: TreeNode, peerId: string): boolean {
    if (node.peerId === peerId) return true;
    return node.children.some((child) => this.isInSubtree(child, peerId));
  }
}
