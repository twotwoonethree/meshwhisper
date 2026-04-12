// ============================================================
// MeshWhisper SDK — Session Manager
//
// Owns all X3DH + Double Ratchet state:
//   - signed pre-key pair (loaded from / persisted to storage)
//   - per-peer Double Ratchet sessions
//   - peer pre-key bundle cache
//   - pending handshake map
//   - handshake packet handling (both initiator and responder sides)
//   - pre-key bundle directory publish
// ============================================================

import { edwardsToMontgomeryPub } from '@noble/curves/ed25519';
import type { KeyPair, Packet, PreKeyBundle, StorageBackend } from '../types.js';
import {
  deriveDestHash,
  getCurrentEpochHour,
  concat,
} from '../crypto/index.js';
import {
  generatePreKeyBundle,
  initiateKeyExchange,
  completeKeyExchange,
  serializePreKeyBundle,
  deserializePreKeyBundle,
} from '../x3dh/index.js';
import type { RatchetState } from '../ratchet/index.js';
import {
  initSender,
  initReceiver,
} from '../ratchet/index.js';
import {
  createHandshakePacket,
  PROTOCOL_VERSION,
} from '../packet/index.js';
import type { LocalIdentity, PeerIdentityCache } from '../namespace/index.js';
import {
  serializeRatchetState,
  deserializeRatchetState,
} from '../persistence/serialization.js';
import {
  uint8ArrayToHex,
  hexToUint8Array,
  uint8ArrayToBase64,
  base64ToUint8Array,
  type HandshakeEnvelope,
} from './utils.js';

export class SessionManager {
  // Double Ratchet session state, keyed by peer ID
  private readonly sessions: Map<string, RatchetState> = new Map();

  // Peer pre-key bundles (needed for initiating X3DH and re-establishment)
  private readonly peerPreKeyBundles: Map<string, PreKeyBundle> = new Map();

  // Tracks in-flight outbound handshakes. The `resolve` is called when the
  // peer sends back an x3dh_response, confirming the session is live.
  private readonly pendingHandshakes: Map<string, { resolve: () => void }> = new Map();

  // Signed pre-key pair — loaded from storage on start or generated fresh.
  // Must survive restarts so incoming X3DH handshakes can be completed with
  // the same key that was published in the pre-key bundle / contact QR.
  private signedPreKeyPair: KeyPair | null = null;

  constructor(
    private readonly identity: LocalIdentity,
    private readonly peerCache: PeerIdentityCache,
    private readonly storage: StorageBackend | null,
    /**
     * Called by the session manager whenever it needs to send a packet
     * (handshake init, handshake response). Implemented by the MeshWhisper
     * coordinator via routeAndSend().
     */
    private readonly sendPacket: (packet: Packet, peerId: string) => Promise<void>,
    /**
     * Called when an inbound x3dh_init establishes a new session, so the
     * coordinator can register the new contact with the permission manager.
     */
    private readonly onContactEstablished: (peerId: string) => void,
    private readonly namespace: string,
    private readonly nodeUrl: string | string[] | 'mesh',
  ) {}

  // ----------------------------------------------------------------
  // Startup
  // ----------------------------------------------------------------

  /** Load persisted sessions and peer pre-key bundles from storage. */
  async loadSessions(): Promise<void> {
    if (!this.storage) return;

    const sessionKeys = await this.storage.keys('sessions/');
    for (const key of sessionKeys) {
      const data = await this.storage.get(key);
      if (!data) continue;
      const peerId = key.replace(/^sessions\//, '');
      try {
        this.sessions.set(peerId, deserializeRatchetState(data));
      } catch {
        // Corrupted session — skip; will re-establish on next contact
      }
    }

    const prekeyKeys = await this.storage.keys('prekeys/');
    for (const key of prekeyKeys) {
      const b64 = await this.storage.get(key);
      if (!b64) continue;
      const peerId = key.replace(/^prekeys\//, '');
      try {
        const bundle = deserializePreKeyBundle(base64ToUint8Array(b64));
        this.peerPreKeyBundles.set(peerId, bundle);
      } catch {
        // Corrupted bundle — skip
      }
    }
  }

  /**
   * Load or generate the signed pre-key pair.
   * Must be called during startup before any handshakes are processed.
   */
  async initSignedPreKey(): Promise<void> {
    const edKeyPair = {
      publicKey: this.identity.getEdPublicKey(),
      privateKey: this.identity.getEdPrivateKey(),
    };

    if (this.storage) {
      const saved = await this.storage.get('signed_pre_key');
      if (saved) {
        const [pubHex, privHex] = saved.split(':');
        this.signedPreKeyPair = {
          publicKey: hexToUint8Array(pubHex!),
          privateKey: hexToUint8Array(privHex!),
        };
        return;
      }
    }

    const { signedPreKeyPair } = generatePreKeyBundle(edKeyPair);
    this.signedPreKeyPair = signedPreKeyPair;
    if (this.storage) {
      await this.storage.set(
        'signed_pre_key',
        `${uint8ArrayToHex(signedPreKeyPair.publicKey)}:${uint8ArrayToHex(signedPreKeyPair.privateKey)}`,
      );
    }
  }

  /**
   * Re-initiates X3DH sessions with all contacts whose prekey bundles are saved.
   * Called on startup when session state is missing — handles storage wipe /
   * new-device-with-same-identity-key scenarios.
   */
  async reinitiateSessionsOnStartup(contacts: string[]): Promise<void> {
    for (const contactId of contacts) {
      const bundle = this.peerPreKeyBundles.get(contactId);
      if (!bundle) continue;
      try {
        await this.initiateHandshake(contactId, bundle);
      } catch {
        // Best effort — peer may be offline; session will re-establish on reconnect
      }
    }
  }

  // ----------------------------------------------------------------
  // Pre-key bundle (QR / directory)
  // ----------------------------------------------------------------

  /**
   * Constructs the local pre-key bundle suitable for embedding in a QR code
   * or publishing to the relay directory.
   * Reuses the existing signed pre-key — never rotates it — so previously
   * shared QR codes remain valid indefinitely.
   */
  getOrCreatePreKeyBundle(): PreKeyBundle {
    if (!this.signedPreKeyPair) {
      const edKeyPair = {
        publicKey: this.identity.getEdPublicKey(),
        privateKey: this.identity.getEdPrivateKey(),
      };
      const { signedPreKeyPair } = generatePreKeyBundle(edKeyPair);
      this.signedPreKeyPair = signedPreKeyPair;
      if (this.storage) {
        this.storage.set(
          'signed_pre_key',
          `${uint8ArrayToHex(signedPreKeyPair.publicKey)}:${uint8ArrayToHex(signedPreKeyPair.privateKey)}`,
        ).catch(() => {});
      }
    }

    return {
      identityKey: this.identity.getEdPublicKey(),
      signedPreKey: this.signedPreKeyPair.publicKey,
      signedPreKeySignature: this.identity.signData(this.signedPreKeyPair.publicKey),
    };
  }

  /**
   * Publishes the pre-key bundle to the relay's /directory endpoint so peers
   * can initiate contact without an out-of-band QR exchange.
   */
  async publishPreKeyBundle(bundle: PreKeyBundle): Promise<void> {
    const wsUrls = Array.isArray(this.nodeUrl) ? this.nodeUrl : [this.nodeUrl];
    const primaryWsUrl = wsUrls[0];
    if (!primaryWsUrl || primaryWsUrl === 'mesh') return;

    const httpUrl = primaryWsUrl
      .replace(/^wss:\/\//, 'https://')
      .replace(/^ws:\/\//, 'http://');

    await fetch(`${httpUrl}/directory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        namespace: this.namespace,
        publicKey: uint8ArrayToHex(this.identity.getEdPublicKey()),
        bundle: uint8ArrayToBase64(serializePreKeyBundle(bundle)),
      }),
    });
  }

  // ----------------------------------------------------------------
  // Session access
  // ----------------------------------------------------------------

  getSession(peerId: string): RatchetState | undefined {
    return this.sessions.get(peerId);
  }

  setSession(peerId: string, state: RatchetState): void {
    this.sessions.set(peerId, state);
    this.storage?.set(`sessions/${peerId}`, serializeRatchetState(state)).catch(() => {});
  }

  hasSession(peerId: string): boolean {
    return this.sessions.has(peerId);
  }

  getBundle(peerId: string): PreKeyBundle | undefined {
    return this.peerPreKeyBundles.get(peerId);
  }

  setBundle(peerId: string, bundle: PreKeyBundle): void {
    this.peerPreKeyBundles.set(peerId, bundle);
    this.storage?.set(
      `prekeys/${peerId}`,
      uint8ArrayToBase64(serializePreKeyBundle(bundle)),
    ).catch(() => {});
  }

  getSignedPreKeyPair(): KeyPair | null {
    return this.signedPreKeyPair;
  }

  // ----------------------------------------------------------------
  // Session establishment
  // ----------------------------------------------------------------

  /**
   * Ensures a Double Ratchet session exists with `recipientId`.
   * If no session exists but a pre-key bundle is cached, initiates X3DH.
   * Throws if no bundle is available.
   */
  async ensureSession(recipientId: string): Promise<void> {
    if (this.sessions.has(recipientId)) return;

    const bundle = this.peerPreKeyBundles.get(recipientId);
    if (bundle) {
      await this.initiateHandshake(recipientId, bundle);
      return;
    }

    throw new Error(
      `No pre-key bundle for ${recipientId}. ` +
      `Use acceptContact() or acceptContact(scannedQR) to establish first contact.`,
    );
  }

  async initiateHandshake(peerId: string, bundle: PreKeyBundle): Promise<void> {
    const aliceIdentity = {
      publicKey: this.identity.getEdPublicKey(),
      privateKey: this.identity.getEdPrivateKey(),
    };

    // TODO: implement one-time pre-key (OPK) storage.
    // generatePreKeyBundle() always produces an OPK, so bundles always have
    // oneTimePreKey set. initiateKeyExchange() then performs DH4 with it, but
    // completeIncomingHandshake() passes null for the OPK private key (it is
    // never persisted), producing a different shared secret on Bob's side.
    // Strip the OPK here so both sides compute the same 3-DH shared secret
    // until OPK private-key storage and lookup are implemented.
    const result = initiateKeyExchange(aliceIdentity, { ...bundle, oneTimePreKey: undefined });

    const ratchetState = initSender(result.sharedSecret, bundle.signedPreKey);
    this.sessions.set(peerId, ratchetState);
    this.storage?.set(`sessions/${peerId}`, serializeRatchetState(ratchetState)).catch(() => {});

    const handshakeEnvelope: HandshakeEnvelope = {
      type: 'x3dh_init',
      senderId: uint8ArrayToHex(this.identity.getPublicKey()),
      ephemeralPublicKey: Array.from(result.ephemeralPublicKey),
      identityKey: Array.from(this.identity.getEdPublicKey()),
    };

    const envelopeBytes = new TextEncoder().encode(JSON.stringify(handshakeEnvelope));
    const recipientPublicKey = this.peerCache.getPeerPublicKey(peerId);
    if (!recipientPublicKey) return;

    const destHash = deriveDestHash(recipientPublicKey, getCurrentEpochHour());
    const senderEphId = this.identity.generateEphemeralId();
    const handshakePacket = createHandshakePacket(destHash, senderEphId, envelopeBytes);

    await this.sendPacket(handshakePacket, peerId);

    // Track this handshake; resolved when the peer confirms with x3dh_response.
    new Promise<void>((resolve) => {
      this.pendingHandshakes.set(peerId, { resolve });
    });
  }

  completeIncomingHandshake(envelope: HandshakeEnvelope): void {
    if (!envelope.ephemeralPublicKey || !envelope.identityKey) return;

    const aliceEphemeralKey = new Uint8Array(envelope.ephemeralPublicKey);
    const aliceIdentityKey = new Uint8Array(envelope.identityKey);

    const bobSignedPreKey = this.signedPreKeyPair ?? {
      publicKey: this.identity.getPublicKey(),
      privateKey: this.identity.getPrivateKey(),
    };

    const bobIdentity = {
      publicKey: this.identity.getEdPublicKey(),
      privateKey: this.identity.getEdPrivateKey(),
    };

    const sharedSecret = completeKeyExchange(
      bobIdentity,
      bobSignedPreKey,
      null, // No one-time pre-key for now
      aliceIdentityKey,
      aliceEphemeralKey,
    );

    const ratchetState = initReceiver(sharedSecret, bobSignedPreKey);
    this.sessions.set(envelope.senderId, ratchetState);
    this.storage?.set(`sessions/${envelope.senderId}`, serializeRatchetState(ratchetState)).catch(() => {});

    // Cache and persist the peer's X25519 routing key.
    const peerX25519Key = edwardsToMontgomeryPub(new Uint8Array(envelope.identityKey));
    this.peerCache.addPeer(envelope.senderId, peerX25519Key);
    this.storage?.set(
      `peers/${envelope.senderId}`,
      uint8ArrayToHex(peerX25519Key),
    ).catch(() => {});

    // Notify the coordinator so it can update the permission manager
    this.onContactEstablished(envelope.senderId);

    // Send handshake response
    const response: HandshakeEnvelope = {
      type: 'x3dh_response',
      senderId: uint8ArrayToHex(this.identity.getPublicKey()),
    };

    const responseBytes = new TextEncoder().encode(JSON.stringify(response));
    const peerPublicKey = this.peerCache.getPeerPublicKey(envelope.senderId);
    if (!peerPublicKey) return;

    const destHash = deriveDestHash(peerPublicKey, getCurrentEpochHour());
    const senderEphId = this.identity.generateEphemeralId();
    const responsePacket = createHandshakePacket(destHash, senderEphId, responseBytes);

    this.sendPacket(responsePacket, envelope.senderId).catch(() => {});
  }

  // ----------------------------------------------------------------
  // Incoming handshake packet routing
  // ----------------------------------------------------------------

  handleHandshakePacket(payload: Uint8Array): void {
    try {
      const envelope: HandshakeEnvelope = JSON.parse(new TextDecoder().decode(payload));

      switch (envelope.type) {
        case 'prekey_bundle': {
          if (envelope.preKeyBundle) {
            const bundleBytes = new Uint8Array(envelope.preKeyBundle);
            const bundle = deserializePreKeyBundle(bundleBytes);
            this.peerPreKeyBundles.set(envelope.senderId, bundle);
            this.peerCache.addPeer(envelope.senderId, edwardsToMontgomeryPub(bundle.identityKey));
            this.storage?.set(
              `prekeys/${envelope.senderId}`,
              uint8ArrayToBase64(serializePreKeyBundle(bundle)),
            ).catch(() => {});
          }
          break;
        }

        case 'x3dh_init': {
          if (envelope.ephemeralPublicKey && envelope.identityKey) {
            this.completeIncomingHandshake(envelope);
          }
          break;
        }

        case 'x3dh_response': {
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

  // ----------------------------------------------------------------
  // Session iteration (used by message handler for decrypt-by-trial)
  // ----------------------------------------------------------------

  sessions_iter(): IterableIterator<[string, RatchetState]> {
    return this.sessions.entries();
  }
}
