// ============================================================
// MeshWhisper SDK — Contact Permissions Module
// Endpoint-side permission enforcement for P2P contact initiation.
// ============================================================

import type { PermissionModel } from '../types';

// --- Interfaces ---

export interface ContactContext {
  senderId: string;
  senderPublicKey: Uint8Array;
  timestamp: number;
  introductionBy?: string;
  transactionEvent?: string;
}

export interface PermissionOptions {
  customHandler?: (
    senderId: string,
    context: ContactContext,
  ) => boolean | Promise<boolean>;
  transactionVerifier?: (
    senderId: string,
    event: string,
  ) => boolean | Promise<boolean>;
  allowList?: Set<string>;
  blockList?: Set<string>;
}

export interface ContactRequest {
  id: string;
  fromPeerId: string;
  toPeerId: string;
  timestamp: number;
  status: 'pending' | 'accepted' | 'rejected';
}

export interface IntroductionRequest {
  id: string;
  fromPeerId: string;
  toPeerId: string;
  introducerPeerId: string;
  timestamp: number;
  status: 'pending' | 'introduced' | 'accepted' | 'rejected';
}

// --- Helpers ---

function generateId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// --- PermissionManager ---

export class PermissionManager {
  private model: PermissionModel;
  private readonly customHandler?: (
    senderId: string,
    context: ContactContext,
  ) => boolean | Promise<boolean>;
  private readonly transactionVerifier?: (
    senderId: string,
    event: string,
  ) => boolean | Promise<boolean>;

  private readonly contacts: Set<string> = new Set();
  private readonly blocked: Set<string> = new Set();
  private readonly allowed: Set<string> = new Set();

  /** Peers who have sent us a contact request (mutual model). */
  private readonly inboundRequests: Map<string, ContactRequest> = new Map();
  /** Peers we have sent a contact request to (mutual model). */
  private readonly outboundRequests: Map<string, ContactRequest> = new Map();

  /** Introduction requests keyed by request id. */
  private readonly introductionRequests: Map<string, IntroductionRequest> =
    new Map();

  /** Peers whose mutual contact has been confirmed (both sides accepted). */
  private readonly mutualConfirmed: Set<string> = new Set();

  /** Peers introduced to us via a trusted intermediary. */
  private readonly introducedPeers: Set<string> = new Set();

  constructor(model: PermissionModel, options?: PermissionOptions) {
    this.model = model;

    if (options?.customHandler) {
      this.customHandler = options.customHandler;
    }
    if (options?.transactionVerifier) {
      this.transactionVerifier = options.transactionVerifier;
    }
    if (options?.allowList) {
      for (const id of options.allowList) {
        this.allowed.add(id);
      }
    }
    if (options?.blockList) {
      for (const id of options.blockList) {
        this.blocked.add(id);
      }
    }
  }

  // ------------------------------------------------------------------
  // Model switching
  // ------------------------------------------------------------------

  setModel(model: PermissionModel): void {
    this.model = model;
  }

  getModel(): PermissionModel {
    return this.model;
  }

  // ------------------------------------------------------------------
  // Contact management
  // ------------------------------------------------------------------

  addContact(peerId: string): void {
    this.contacts.add(peerId);
  }

  removeContact(peerId: string): void {
    this.contacts.delete(peerId);
    this.mutualConfirmed.delete(peerId);
  }

  isContact(peerId: string): boolean {
    return this.contacts.has(peerId);
  }

  getContacts(): string[] {
    return Array.from(this.contacts);
  }

  loadContacts(contacts: string[]): void {
    for (const id of contacts) this.contacts.add(id);
  }

  blockPeer(peerId: string): void {
    this.blocked.add(peerId);
  }

  unblockPeer(peerId: string): void {
    this.blocked.delete(peerId);
  }

  isBlocked(peerId: string): boolean {
    return this.blocked.has(peerId);
  }

  // ------------------------------------------------------------------
  // Permission checks
  // ------------------------------------------------------------------

  /**
   * Main inbound permission check.
   * Order: blockList -> allowList -> model-specific logic.
   */
  async canReceiveFrom(
    senderId: string,
    context: ContactContext,
  ): Promise<boolean> {
    // Always deny blocked peers.
    if (this.blocked.has(senderId)) {
      return false;
    }

    // Always allow explicitly allowed peers.
    if (this.allowed.has(senderId)) {
      return true;
    }

    // Existing contacts are always permitted regardless of model.
    if (this.contacts.has(senderId)) {
      return true;
    }

    switch (this.model) {
      case 'open':
        return true;

      case 'mutual':
        return this.mutualConfirmed.has(senderId);

      case 'introduction':
        return this.introducedPeers.has(senderId) || this.checkIntroduction(senderId, context);

      case 'transactional':
        return this.checkTransaction(senderId, context);

      case 'custom':
        return this.checkCustom(senderId, context);

      default:
        return false;
    }
  }

  /**
   * Outbound permission check — can we send to this recipient?
   * Primarily relevant for the mutual model where both sides
   * need to have each other as contacts.
   */
  async canSendTo(recipientId: string): Promise<boolean> {
    // Never send to blocked peers.
    if (this.blocked.has(recipientId)) {
      return false;
    }

    // Always allowed peers.
    if (this.allowed.has(recipientId)) {
      return true;
    }

    switch (this.model) {
      case 'open':
        return true;

      case 'mutual':
        // Can only send if mutual contact has been confirmed or they are
        // already a known contact.
        return this.contacts.has(recipientId) || this.mutualConfirmed.has(recipientId);

      case 'introduction':
        return (
          this.contacts.has(recipientId) || this.introducedPeers.has(recipientId)
        );

      case 'transactional':
        // For outbound in transactional model, allow if they are a contact.
        return this.contacts.has(recipientId);

      case 'custom':
        // Custom model defers to the handler for inbound only;
        // outbound is permitted to any non-blocked peer.
        return true;

      default:
        return false;
    }
  }

  // ------------------------------------------------------------------
  // Mutual model logic
  // ------------------------------------------------------------------

  /**
   * Create a contact request to send to a peer (mutual model).
   * The caller is responsible for transmitting the request over the wire.
   */
  requestMutualContact(peerId: string): ContactRequest {
    const request: ContactRequest = {
      id: generateId(),
      fromPeerId: '', // Will be filled by the caller with own peer ID
      toPeerId: peerId,
      timestamp: Date.now(),
      status: 'pending',
    };
    this.outboundRequests.set(peerId, request);
    return request;
  }

  /**
   * Handle an inbound contact request from a peer.
   * Returns true if the request is accepted (i.e. we already have an
   * outbound request to that peer, achieving mutual consent), false
   * if the request is stored as pending.
   */
  handleContactRequest(request: ContactRequest): boolean {
    if (this.blocked.has(request.fromPeerId)) {
      request.status = 'rejected';
      return false;
    }

    this.inboundRequests.set(request.fromPeerId, request);

    // If we already sent a request to this peer, auto-confirm mutual contact.
    if (this.outboundRequests.has(request.fromPeerId)) {
      request.status = 'accepted';
      const outbound = this.outboundRequests.get(request.fromPeerId)!;
      outbound.status = 'accepted';
      this.confirmMutualContact(request.fromPeerId);
      return true;
    }

    return false;
  }

  /**
   * Explicitly confirm mutual contact with a peer.
   * Adds the peer to contacts and the mutualConfirmed set.
   */
  confirmMutualContact(peerId: string): void {
    this.mutualConfirmed.add(peerId);
    this.contacts.add(peerId);
  }

  // ------------------------------------------------------------------
  // Introduction model logic
  // ------------------------------------------------------------------

  /**
   * Request an introduction to a target peer through a mutual contact.
   * The caller is responsible for transmitting the request to the introducer.
   */
  requestIntroduction(
    targetPeerId: string,
    introducerPeerId: string,
  ): IntroductionRequest {
    const request: IntroductionRequest = {
      id: generateId(),
      fromPeerId: '', // Will be filled by the caller with own peer ID
      toPeerId: targetPeerId,
      introducerPeerId,
      timestamp: Date.now(),
      status: 'pending',
    };
    this.introductionRequests.set(request.id, request);
    return request;
  }

  /**
   * Handle an introduction request as the intermediary.
   * Returns true if the introducer is a known contact of ours (trusted),
   * false otherwise (the intermediary should only broker introductions
   * between their own contacts).
   */
  handleIntroductionRequest(request: IntroductionRequest): boolean {
    if (this.blocked.has(request.fromPeerId)) {
      request.status = 'rejected';
      return false;
    }

    // The intermediary should know both parties as contacts.
    const knowsSender = this.contacts.has(request.fromPeerId);
    const knowsTarget = this.contacts.has(request.toPeerId);

    if (knowsSender && knowsTarget) {
      request.status = 'introduced';
      this.introductionRequests.set(request.id, request);
      return true;
    }

    request.status = 'rejected';
    this.introductionRequests.set(request.id, request);
    return false;
  }

  /**
   * Confirm an introduction — called on the receiving end once the
   * introduction has been brokered by the intermediary.
   */
  confirmIntroduction(request: IntroductionRequest): void {
    request.status = 'accepted';
    this.introductionRequests.set(request.id, request);
    this.introducedPeers.add(request.fromPeerId);
    this.contacts.add(request.fromPeerId);
  }

  // ------------------------------------------------------------------
  // Private model-specific checks
  // ------------------------------------------------------------------

  private checkIntroduction(
    senderId: string,
    context: ContactContext,
  ): boolean {
    // If the context carries a valid introduction reference, check it.
    if (context.introductionBy) {
      // The introducer must be one of our contacts.
      return this.contacts.has(context.introductionBy);
    }
    return false;
  }

  private async checkTransaction(
    senderId: string,
    context: ContactContext,
  ): Promise<boolean> {
    if (!this.transactionVerifier || !context.transactionEvent) {
      return false;
    }
    return this.transactionVerifier(senderId, context.transactionEvent);
  }

  private async checkCustom(
    senderId: string,
    context: ContactContext,
  ): Promise<boolean> {
    if (!this.customHandler) {
      // No custom handler configured — deny by default for safety.
      return false;
    }
    return this.customHandler(senderId, context);
  }
}
