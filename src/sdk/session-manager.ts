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
  generateOneTimePreKeys,
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

/** How long to wait for an x3dh_response before discarding the pending entry. */
const HANDSHAKE_TIMEOUT_MS = 60_000;

export class SessionManager {
  // Double Ratchet session state, keyed by peer ID
  private readonly sessions: Map<string, RatchetState> = new Map();

  // Peer pre-key bundles (needed for initiating X3DH and re-establishment)
  private readonly peerPreKeyBundles: Map<string, PreKeyBundle> = new Map();

  // Ed25519 identity key for each known peer (X25519 peerId → Ed25519 pubKey).
  // Stored separately because responders never receive the initiator's full
  // pre-key bundle — only their identity key in the x3dh_init envelope.
  // Required for directory lookups when trying to re-establish a lost session.
  private readonly peerEdKeys: Map<string, Uint8Array> = new Map();

  // Tracks in-flight outbound handshakes. Entries expire after HANDSHAKE_TIMEOUT_MS
  // so the map doesn't grow without bound when peers never respond.
  private readonly pendingHandshakes: Map<string, {
    resolve: () => void;
    timer: ReturnType<typeof setTimeout>;
  }> = new Map();

  // Index from a peer's ratchet DH public key (hex) to their peer ID.
  // Populated on successful decryption; allows O(1) session lookup instead
  // of trying every session for each incoming packet.
  private readonly dhKeyIndex: Map<string, string> = new Map();

  // Signed pre-key pair — loaded from storage on start or generated fresh.
  // Must survive restarts so incoming X3DH handshakes can be completed with
  // the same key that was published in the pre-key bundle / contact QR.
  private signedPreKeyPair: KeyPair | null = null;

  // Current one-time pre-key. A single OPK is maintained at a time; it is
  // included in published bundles and consumed on the first incoming x3dh_init
  // that references it. A fresh OPK is generated automatically after use.
  private currentOPK: KeyPair | null = null;

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
    private readonly namespaceId: Uint8Array,
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
        // Ed key is embedded in the bundle — no separate load needed
        this.peerEdKeys.set(peerId, bundle.identityKey);
      } catch {
        // Corrupted bundle — skip
      }
    }

    const edKeyKeys = await this.storage.keys('edkeys/');
    for (const key of edKeyKeys) {
      const hex = await this.storage.get(key);
      if (!hex) continue;
      const peerId = key.replace(/^edkeys\//, '');
      // Don't overwrite if already populated from the bundle above
      if (!this.peerEdKeys.has(peerId)) {
        this.peerEdKeys.set(peerId, hexToUint8Array(hex));
      }
    }
  }

  /**
   * Load or generate the signed pre-key pair and current OPK.
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
      }

      const savedOPK = await this.storage.get('opk_current');
      if (savedOPK) {
        const [pubHex, privHex] = savedOPK.split(':');
        this.currentOPK = {
          publicKey: hexToUint8Array(pubHex!),
          privateKey: hexToUint8Array(privHex!),
        };
      }
    }

    if (!this.signedPreKeyPair) {
      const { signedPreKeyPair } = generatePreKeyBundle(edKeyPair);
      this.signedPreKeyPair = signedPreKeyPair;
      if (this.storage) {
        await this.storage.set(
          'signed_pre_key',
          `${uint8ArrayToHex(signedPreKeyPair.publicKey)}:${uint8ArrayToHex(signedPreKeyPair.privateKey)}`,
        );
      }
    }

    if (!this.currentOPK) {
      await this.rotateOPK();
    }
  }

  /**
   * Generates a fresh OPK and persists it, replacing any existing one.
   * Called on first startup and after the current OPK is consumed.
   */
  private async rotateOPK(): Promise<void> {
    const [opkPair] = generateOneTimePreKeys(
      { publicKey: new Uint8Array(32), privateKey: new Uint8Array(32) },
      1,
    );
    this.currentOPK = opkPair!;
    if (this.storage) {
      await this.storage.set(
        'opk_current',
        `${uint8ArrayToHex(opkPair!.publicKey)}:${uint8ArrayToHex(opkPair!.privateKey)}`,
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
      // Skip if we already have an active session — avoids both sides
      // simultaneously re-handshaking on restart (double-handshake race).
      if (this.sessions.has(contactId)) continue;
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
      // Include the current OPK so the initiator can perform 4-DH.
      // The OPK is consumed on first use and rotated automatically.
      oneTimePreKey: this.currentOPK?.publicKey,
    };
  }

  /**
   * Looks up a peer's pre-key bundle from the relay's /directory endpoint.
   * Returns null if the peer has not published a bundle or is not found.
   */
  async lookupPreKeyBundle(publicKey: string): Promise<PreKeyBundle | null> {
    const wsUrls = Array.isArray(this.nodeUrl) ? this.nodeUrl : [this.nodeUrl];
    const primaryWsUrl = wsUrls[0];
    if (!primaryWsUrl || primaryWsUrl === 'mesh') return null;

    const httpUrl = primaryWsUrl
      .replace(/^wss:\/\//, 'https://')
      .replace(/^ws:\/\//, 'http://');

    const res = await fetch(
      `${httpUrl}/directory?namespace=${encodeURIComponent(this.namespace)}&publicKey=${encodeURIComponent(publicKey)}`,
    );
    if (!res.ok) return null;

    const json = await res.json() as { bundle?: string };
    if (!json.bundle) return null;

    return deserializePreKeyBundle(base64ToUint8Array(json.bundle));
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
    this.peerEdKeys.set(peerId, bundle.identityKey);
    this.storage?.set(
      `prekeys/${peerId}`,
      uint8ArrayToBase64(serializePreKeyBundle(bundle)),
    ).catch(() => {});
    // Also persist the Ed25519 key standalone so session re-establishment
    // works even if the bundle entry gets corrupted.
    this.storage?.set(
      `edkeys/${peerId}`,
      uint8ArrayToHex(bundle.identityKey),
    ).catch(() => {});
  }

  getPeerEdKey(peerId: string): Uint8Array | null {
    return this.peerEdKeys.get(peerId) ?? null;
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

    const cached = this.peerPreKeyBundles.get(recipientId);
    if (cached) {
      await this.initiateHandshake(recipientId, cached);
      return;
    }

    // No bundle in cache — try the directory. This handles the case where
    // our session was lost but the peer has published their bundle, as well as
    // the case where we were the X3DH responder and never stored their bundle.
    const edKey = this.peerEdKeys.get(recipientId);
    if (edKey) {
      const fresh = await this.lookupPreKeyBundle(uint8ArrayToHex(edKey));
      if (fresh) {
        this.setBundle(recipientId, fresh);
        await this.initiateHandshake(recipientId, fresh);
        return;
      }
    }

    throw new Error(
      `Cannot reach ${recipientId}: no pre-key bundle available locally or in the directory. ` +
      `The peer may be offline and have not yet published a bundle.`,
    );
  }

  async initiateHandshake(peerId: string, bundle: PreKeyBundle): Promise<void> {
    const aliceIdentity = {
      publicKey: this.identity.getEdPublicKey(),
      privateKey: this.identity.getEdPrivateKey(),
    };

    // Use the full bundle including OPK if present (4-DH). Bob will look up
    // the OPK private key by the public key we include in the envelope.
    const result = initiateKeyExchange(aliceIdentity, bundle);

    const ratchetState = initSender(result.sharedSecret, bundle.signedPreKey);
    this.sessions.set(peerId, ratchetState);
    this.storage?.set(`sessions/${peerId}`, serializeRatchetState(ratchetState)).catch(() => {});

    const handshakeEnvelope: HandshakeEnvelope = {
      type: 'x3dh_init',
      senderId: uint8ArrayToHex(this.identity.getPublicKey()),
      ephemeralPublicKey: Array.from(result.ephemeralPublicKey),
      identityKey: Array.from(this.identity.getEdPublicKey()),
      // Tell Bob which OPK we consumed so he can look up the private key
      ...(result.usedOneTimePreKey && bundle.oneTimePreKey
        ? { usedOneTimePreKeyPublic: Array.from(bundle.oneTimePreKey) }
        : {}),
    };

    const envelopeBytes = new TextEncoder().encode(JSON.stringify(handshakeEnvelope));
    const recipientPublicKey = this.peerCache.getPeerPublicKey(peerId);
    if (!recipientPublicKey) return;

    const destHash = deriveDestHash(this.namespaceId, recipientPublicKey, getCurrentEpochHour());
    const senderEphId = this.identity.generateEphemeralId();
    const handshakePacket = createHandshakePacket(destHash, senderEphId, envelopeBytes);

    await this.sendPacket(handshakePacket, peerId);

    // Track this handshake; auto-expires after HANDSHAKE_TIMEOUT_MS so the map
    // doesn't grow without bound when a peer never responds.
    const existing = this.pendingHandshakes.get(peerId);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      this.pendingHandshakes.delete(peerId);
    }, HANDSHAKE_TIMEOUT_MS);
    // Let the timer be GC'd without keeping the process alive in Node.js
    if (typeof timer === 'object' && 'unref' in timer) (timer as NodeJS.Timeout).unref();

    this.pendingHandshakes.set(peerId, {
      resolve: () => {
        clearTimeout(timer);
        this.pendingHandshakes.delete(peerId);
      },
      timer,
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

    // Look up the OPK private key if Alice used one. The lookup is
    // synchronous (in-memory) to avoid a race where a data packet arrives
    // while an async lookup is still pending. Storage cleanup is fire-and-forget.
    let bobOPK: KeyPair | null = null;
    if (envelope.usedOneTimePreKeyPublic) {
      const opkPubHex = uint8ArrayToHex(new Uint8Array(envelope.usedOneTimePreKeyPublic));
      if (this.currentOPK && uint8ArrayToHex(this.currentOPK.publicKey) === opkPubHex) {
        bobOPK = this.currentOPK;
        this.currentOPK = null;
        if (this.storage) this.storage.delete('opk_current').catch(() => {});
        this.rotateOPK().catch(() => {});
      }
      // If OPK not found (already consumed), bobOPK stays null → 3-DH fallback.
      // Alice computed 4-DH, so the secrets won't match and decryption will
      // fail. This only happens on duplicate x3dh_init delivery, which the
      // dedup layer prevents in practice.
    }

    const sharedSecret = completeKeyExchange(
      bobIdentity,
      bobSignedPreKey,
      bobOPK,
      aliceIdentityKey,
      aliceEphemeralKey,
    );

    const ratchetState = initReceiver(sharedSecret, bobSignedPreKey);
    this.sessions.set(envelope.senderId, ratchetState);
    this.storage?.set(`sessions/${envelope.senderId}`, serializeRatchetState(ratchetState)).catch(() => {});

    // Cache and persist the peer's X25519 routing key and Ed25519 identity key.
    const peerEdKey = new Uint8Array(envelope.identityKey);
    const peerX25519Key = edwardsToMontgomeryPub(peerEdKey);
    this.peerCache.addPeer(envelope.senderId, peerX25519Key);
    this.peerEdKeys.set(envelope.senderId, peerEdKey);
    this.storage?.set(`peers/${envelope.senderId}`, uint8ArrayToHex(peerX25519Key)).catch(() => {});
    this.storage?.set(`edkeys/${envelope.senderId}`, uint8ArrayToHex(peerEdKey)).catch(() => {});

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

    const destHash = deriveDestHash(this.namespaceId, peerPublicKey, getCurrentEpochHour());
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
            pending.resolve(); // also clears the timer and removes from map
          }
          break;
        }
      }
    } catch {
      // Malformed handshake — drop
    }
  }

  // ----------------------------------------------------------------
  // DH key index — O(1) session lookup
  // ----------------------------------------------------------------

  /**
   * Records that `dhKeyHex` (a peer's ratchet DH public key) belongs to `peerId`.
   * Called after a successful decryption so future packets from the same
   * ratchet step are routed directly without trial decryption.
   */
  registerDhKey(dhKeyHex: string, peerId: string): void {
    this.dhKeyIndex.set(dhKeyHex, peerId);
  }

  /**
   * Returns the peer ID whose current ratchet DH key matches `dhKeyHex`,
   * or null if not yet indexed (first message from a new ratchet step).
   */
  lookupByDhKey(dhKeyHex: string): string | null {
    return this.dhKeyIndex.get(dhKeyHex) ?? null;
  }

  // ----------------------------------------------------------------
  // Session iteration (fallback trial decryption)
  // ----------------------------------------------------------------

  sessions_iter(): IterableIterator<[string, RatchetState]> {
    return this.sessions.entries();
  }
}
