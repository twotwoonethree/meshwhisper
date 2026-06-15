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

/** Target number of one-time pre-keys to maintain in the pool. */
const OPK_POOL_SIZE = 10;

/** Replenish the pool when it drops below this many keys. */
const OPK_LOW_WATERMARK = 3;

export class SessionManager {
  // Double Ratchet session state, keyed by peer ID
  private readonly sessions: Map<string, RatchetState> = new Map();

  // Re-establishment debounce — prevents spamming handshakes on bursts of
  // undecryptable packets and enforces a 60s cooldown between attempts.
  private reestablishTimer: ReturnType<typeof setTimeout> | null = null;
  private lastReestablishAt = 0;
  private static readonly REESTABLISH_COOLDOWN_MS = 60_000;

  // Per-peer last-handshake-attempt timestamp for targeted re-handshake.
  // Independent of the global cooldown: lets a single broken pair re-handshake
  // immediately, but caps churn at one attempt per 30s per peer to prevent
  // tight loops if both sides are continuously failing.
  private readonly lastTargetedReestablishAt: Map<string, number> = new Map();
  private static readonly TARGETED_REESTABLISH_COOLDOWN_MS = 30_000;

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

  // ML-KEM-768 key pair for PQXDH. Generated alongside the signed pre-key
  // and persisted in storage. Public key is included in the pre-key bundle;
  // secret key is used to decapsulate incoming handshakes.
  private pqSecretKey: Uint8Array | null = null;
  private pqPublicKey: Uint8Array | null = null;

  // Pool of one-time pre-keys, keyed by public key hex. Maintained locally;
  // public keys are uploaded to the relay so initiators can claim one atomically.
  // On startup the pool is loaded from storage and replenished up to OPK_POOL_SIZE.
  private readonly opkPool: Map<string, KeyPair> = new Map();

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
    private readonly onContactEstablished: (peerId: string, peerNamespace?: Uint8Array) => void,
    /**
     * Called immediately after we send an outbound x3dh_init. The coordinator
     * uses this to send a tiny ratchet "activate" message so the receiver's
     * sending chain is initialised on first decrypt — without it, a receiver
     * is stuck in receive-only mode until the initiator happens to send a
     * real ratchet message, which can leave Prudence-style apps unable to
     * surface the contact request UI.
     */
    private readonly onHandshakeInitiated: (peerId: string) => void,
    private readonly namespace: string,
    private readonly nodeUrl: string | string[] | 'mesh',
    /** Resolves the namespace id to address a peer in — their own when
     *  cross-namespace (ADR-009), ours otherwise. */
    private readonly namespaceIdFor: (peerId: string) => Uint8Array,
    /** Our namespace id to announce in outbound handshakes when interop is on,
     *  or null when it's off (so the envelope stays byte-identical). ADR-009. */
    private readonly interopNamespace: () => Uint8Array | null,
    /**
     * Called when a handshake completes and a fresh session is in place.
     * The coordinator uses this to schedule a session-health ping that
     * confirms the new session is usable in both directions — silent
     * half-broken sessions (where the handshake "succeeded" but messages
     * don't decrypt on the other side) are detected and recovered from
     * rather than persisting.
     *
     * `role` is `'initiator'` when WE called initiateHandshake, and
     * `'responder'` when the peer's x3dh_init landed and we called
     * completeIncomingHandshake. Only the initiator should actually
     * send the ping; the responder uses the hook to clear stale health
     * state from a prior session.
     */
    private readonly onSessionEstablished: (peerId: string, role: 'initiator' | 'responder') => void = () => {},
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
   * Load or generate the signed pre-key pair and initialise the OPK pool.
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
      const savedPQSK = await this.storage.get('pq_secret_key');
      const savedPQPK = await this.storage.get('pq_public_key');
      if (savedPQSK && savedPQPK) {
        this.pqSecretKey = hexToUint8Array(savedPQSK);
        this.pqPublicKey = hexToUint8Array(savedPQPK);
      }
    }

    if (!this.signedPreKeyPair) {
      const { signedPreKeyPair, pqSecretKey, bundle } = generatePreKeyBundle(edKeyPair);
      this.signedPreKeyPair = signedPreKeyPair;
      this.pqSecretKey = pqSecretKey;
      this.pqPublicKey = bundle.pqPublicKey!;
      if (this.storage) {
        await this.storage.set(
          'signed_pre_key',
          `${uint8ArrayToHex(signedPreKeyPair.publicKey)}:${uint8ArrayToHex(signedPreKeyPair.privateKey)}`,
        );
        await this.storage.set('pq_secret_key', uint8ArrayToHex(pqSecretKey));
        await this.storage.set('pq_public_key', uint8ArrayToHex(bundle.pqPublicKey!));
      }
    }

    await this.initOPKPool();
  }

  /**
   * Loads the OPK pool from storage, generates new keys if below OPK_POOL_SIZE,
   * and uploads the full pool to the relay (handles relay restarts gracefully).
   */
  private async initOPKPool(): Promise<void> {
    if (this.storage) {
      const keys = await this.storage.keys('opks/');
      for (const key of keys) {
        const privHex = await this.storage.get(key);
        if (!privHex) continue;
        const pubHex = key.replace(/^opks\//, '');
        this.opkPool.set(pubHex, {
          publicKey: hexToUint8Array(pubHex),
          privateKey: hexToUint8Array(privHex),
        });
      }
    }

    // Generate fresh keys if the pool is short. Persist BEFORE uploading
    // (same ordering rule as replenishOPKPool — relay must not know about
    // OPKs that aren't yet durable on disk).
    const newKeys: KeyPair[] = [];
    if (this.opkPool.size < OPK_POOL_SIZE) {
      const needed = OPK_POOL_SIZE - this.opkPool.size;
      const edKeyPair = { publicKey: this.identity.getEdPublicKey(), privateKey: this.identity.getEdPrivateKey() };
      const generated = generateOneTimePreKeys(edKeyPair, needed);
      for (const kp of generated) {
        const pubHex = uint8ArrayToHex(kp.publicKey);
        this.opkPool.set(pubHex, kp);
        if (this.storage) {
          await this.storage.set(`opks/${pubHex}`, uint8ArrayToHex(kp.privateKey));
        }
        newKeys.push(kp);
      }
    }

    // One-shot migration after the OPK-resurrection fix.
    //
    // The pre-fix SDK bulk-re-uploaded the full local pool on every init,
    // which silently resurrected OPKs at the relay that had been claimed
    // by other peers (and consequently deleted locally). The next peer
    // to claim a "fresh" OPK from the relay could get one we no longer
    // had — Alice does 4-DH, Bob falls back to 3-DH, every ratchet
    // packet between them silently fails to decrypt.
    //
    // The fix prevents NEW resurrection but doesn't clean up the zombies
    // already accumulated at the relay. This migration purges the relay's
    // entire OPK pool for our identity and re-uploads only what's
    // actually in our local store — guaranteeing relay-side pool ==
    // local-side pool.
    //
    // Runs exactly once per device (gated by the storage flag below);
    // best-effort, retries on next init if anything fails.
    const migrationDone = this.storage ? await this.storage.get('opk_migration_v2_done') : null;
    if (!migrationDone) {
      await this.purgeRelayOPKPool();
      await this.uploadOPKs([...this.opkPool.values()]);
      await this.storage?.set('opk_migration_v2_done', '1');
    } else if (newKeys.length > 0) {
      // Migration already ran — just upload any freshly-generated keys
      // (the relay's pool is in sync; we only need to push the deltas).
      await this.uploadOPKs(newKeys);
    }
  }

  /**
   * Generates new OPKs and uploads them when the pool drops below OPK_LOW_WATERMARK.
   * Called after an OPK is consumed (incoming handshake) or claimed (outgoing handshake).
   */
  private async replenishOPKPool(): Promise<void> {
    if (this.opkPool.size >= OPK_LOW_WATERMARK) return;
    const needed = OPK_POOL_SIZE - this.opkPool.size;
    const edKeyPair = { publicKey: this.identity.getEdPublicKey(), privateKey: this.identity.getEdPrivateKey() };
    const newKeys = generateOneTimePreKeys(edKeyPair, needed);
    // CRITICAL ORDERING: persist locally BEFORE uploading to the relay.
    // If the relay learns about an OPK we don't have on disk yet, a
    // peer who claims that OPK will compute a 4-DH shared secret; we'll
    // look up the OPK locally, miss, and fall back to 3-DH. The shared
    // secrets diverge silently and every subsequent ratchet packet from
    // that peer fails to decrypt. Caused the "messages don't go through
    // after re-add" bug.
    for (const kp of newKeys) {
      const pubHex = uint8ArrayToHex(kp.publicKey);
      this.opkPool.set(pubHex, kp);
      if (this.storage) {
        await this.storage.set(`opks/${pubHex}`, uint8ArrayToHex(kp.privateKey));
      }
    }
    await this.uploadOPKs(newKeys);
  }

  /**
   * Derive the per-identity OPK-pool auth token. Same HKDF construction as
   * deriveArchiveToken but with a different info string so the OPK-pool
   * authority is independent from the archive authority — losing one
   * doesn't expose the other.
   */
  private async deriveOPKPoolToken(): Promise<string> {
    const identityKey = this.identity.getEdPrivateKey();
    const base = await globalThis.crypto.subtle.importKey(
      'raw', identityKey.buffer as ArrayBuffer, 'HKDF', false, ['deriveBits'],
    );
    const bits = await globalThis.crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new TextEncoder().encode('meshwhisper:opks:v1'),
        info: new TextEncoder().encode('pool-purge-token'),
      },
      base,
      256,
    );
    return btoa(String.fromCharCode(...new Uint8Array(bits)));
  }

  /**
   * Purges every OPK at the relay for our identity in the configured
   * namespace. Used by the one-shot migration that follows the OPK-
   * resurrection fix — clients with bad zombie OPKs (uploaded by the
   * buggy pre-fix bulk re-upload) wipe the relay's pool and re-upload
   * what's actually in their local store. After that, the relay's
   * pool and the client's pool are guaranteed to match.
   *
   * Authenticated via TOFU per identity_pubkey at the relay.
   */
  private async purgeRelayOPKPool(): Promise<void> {
    const wsUrls = Array.isArray(this.nodeUrl) ? this.nodeUrl : [this.nodeUrl];
    const primaryWsUrl = wsUrls[0];
    if (!primaryWsUrl || primaryWsUrl === 'mesh') return;
    const httpUrl = primaryWsUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
    const token = await this.deriveOPKPoolToken();
    await fetch(`${httpUrl}/opks`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        namespace: this.namespace,
        publicKey: uint8ArrayToHex(this.identity.getEdPublicKey()),
      }),
    }).catch(() => {
      // Best-effort. If the purge fails, the migration flag stays unset
      // and we'll retry on next init.
    });
  }

  /** Uploads OPK public keys to the relay. Best-effort — silently ignored on failure. */
  private async uploadOPKs(opks: KeyPair[]): Promise<void> {
    if (opks.length === 0) return;
    const wsUrls = Array.isArray(this.nodeUrl) ? this.nodeUrl : [this.nodeUrl];
    const primaryWsUrl = wsUrls[0];
    if (!primaryWsUrl || primaryWsUrl === 'mesh') return;
    const httpUrl = primaryWsUrl
      .replace(/^wss:\/\//, 'https://')
      .replace(/^ws:\/\//, 'http://');
    await fetch(`${httpUrl}/opks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        namespace: this.namespace,
        publicKey: uint8ArrayToHex(this.identity.getEdPublicKey()),
        opks: opks.map((kp) => uint8ArrayToBase64(kp.publicKey)),
      }),
    }).catch(() => {});
  }

  /**
   * Claims one OPK public key for a peer from the relay (atomic — the relay removes
   * it so no other initiator can use the same key). Returns null if unavailable,
   * in which case the caller falls back to 3-DH.
   */
  async claimRemoteOPK(peerEdPublicKeyHex: string): Promise<Uint8Array | null> {
    const wsUrls = Array.isArray(this.nodeUrl) ? this.nodeUrl : [this.nodeUrl];
    const primaryWsUrl = wsUrls[0];
    if (!primaryWsUrl || primaryWsUrl === 'mesh') return null;
    const httpUrl = primaryWsUrl
      .replace(/^wss:\/\//, 'https://')
      .replace(/^ws:\/\//, 'http://');
    try {
      const res = await fetch(
        `${httpUrl}/opks/claim?namespace=${encodeURIComponent(this.namespace)}&publicKey=${encodeURIComponent(peerEdPublicKeyHex)}`,
      );
      if (!res.ok) return null;
      const json = await res.json() as { opk?: string };
      if (!json.opk) return null;
      return base64ToUint8Array(json.opk);
    } catch {
      return null;
    }
  }


  /**
   * Re-initiates X3DH sessions with all contacts whose prekey bundles or
   * Ed25519 identity keys are known. Called on startup when session state
   * is missing — handles storage wipe / new-device-with-same-identity-key
   * scenarios. After a fresh-device archive restore, contacts and edKeys
   * are present but bundles aren't (bundles are short-lived, not archived);
   * we fetch the bundle from the relay directory using the cached edKey,
   * then handshake.
   */
  async reinitiateSessionsOnStartup(contacts: string[]): Promise<void> {
    for (const contactId of contacts) {
      // Skip if we already have an active session — avoids both sides
      // simultaneously re-handshaking on restart (double-handshake race).
      if (this.sessions.has(contactId)) continue;

      let bundle = this.peerPreKeyBundles.get(contactId);
      if (!bundle) {
        // No cached bundle — try the relay directory by Ed25519 key.
        // This is the post-archive-restore path: edkeys/* are in the
        // archive, bundles are not, so we must refetch.
        const edKey = this.peerEdKeys.get(contactId);
        if (!edKey) continue;
        try {
          const fresh = await this.lookupPreKeyBundle(uint8ArrayToHex(edKey));
          if (!fresh) continue;
          this.setBundle(contactId, fresh.bundle);
          bundle = fresh.bundle;
        } catch {
          continue;
        }
      }

      try {
        await this.initiateHandshake(contactId, bundle);
      } catch {
        // Best effort — peer may be offline; session will re-establish on reconnect
      }
    }
  }

  /**
   * Immediately re-handshake with a single peer whose session looks broken
   * (e.g. an inbound packet's dhKey indexed to them but ratchetDecrypt
   * threw). Per-peer cooldown of 30s prevents tight handshake loops if
   * both sides are continuously failing. Best-effort: silently no-ops when
   * we have no cached bundle and the directory lookup fails.
   *
   * Prefer this over scheduleReestablishment when the failing peer is
   * known — it's faster (no 2s debounce) and narrower (doesn't ping every
   * contact).
   */
  async targetedReestablish(peerId: string, force = false): Promise<void> {
    const now = Date.now();
    if (!force) {
      const last = this.lastTargetedReestablishAt.get(peerId) ?? 0;
      if (now - last < SessionManager.TARGETED_REESTABLISH_COOLDOWN_MS) return;
    }
    this.lastTargetedReestablishAt.set(peerId, now);

    let bundle = this.peerPreKeyBundles.get(peerId);
    if (!bundle) {
      const edKey = this.peerEdKeys.get(peerId);
      if (!edKey) return;
      try {
        const fresh = await this.lookupPreKeyBundle(uint8ArrayToHex(edKey));
        if (!fresh) return;
        this.setBundle(peerId, fresh.bundle);
        bundle = fresh.bundle;
      } catch {
        return;
      }
    }

    try {
      await this.initiateHandshake(peerId, bundle);
    } catch {
      // Peer offline or unreachable — cooldown still applies; next failure
      // after cooldown expires gets another shot.
    }
  }

  /**
   * Schedules a re-establishment attempt with all known contacts.
   * Debounced: waits 2s after the first trigger, then enforces a 60s cooldown
   * so a burst of undecryptable packets doesn't flood the network with handshakes.
   */
  scheduleReestablishment(): void {
    if (this.reestablishTimer !== null) return; // already pending
    if (Date.now() - this.lastReestablishAt < SessionManager.REESTABLISH_COOLDOWN_MS) return;
    this.reestablishTimer = setTimeout(() => {
      this.reestablishTimer = null;
      this.lastReestablishAt = Date.now();
      this.reestablishAllSessions().catch(() => {});
    }, 2_000);
  }

  private async reestablishAllSessions(): Promise<void> {
    for (const [peerId, bundle] of this.peerPreKeyBundles) {
      try {
        await this.initiateHandshake(peerId, bundle);
      } catch {
        // Peer offline — try again on next decrypt failure after cooldown
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
      const { signedPreKeyPair, pqSecretKey, bundle } = generatePreKeyBundle(edKeyPair);
      this.signedPreKeyPair = signedPreKeyPair;
      this.pqSecretKey = pqSecretKey;
      this.pqPublicKey = bundle.pqPublicKey!;
      if (this.storage) {
        this.storage.set(
          'signed_pre_key',
          `${uint8ArrayToHex(signedPreKeyPair.publicKey)}:${uint8ArrayToHex(signedPreKeyPair.privateKey)}`,
        ).catch(() => {});
        this.storage.set('pq_secret_key', uint8ArrayToHex(pqSecretKey)).catch(() => {});
        this.storage.set('pq_public_key', uint8ArrayToHex(bundle.pqPublicKey!)).catch(() => {});
      }
    }

    return {
      identityKey: this.identity.getEdPublicKey(),
      signedPreKey: this.signedPreKeyPair.publicKey,
      signedPreKeySignature: this.identity.signData(this.signedPreKeyPair.publicKey),
      pqPublicKey: this.pqPublicKey ?? undefined,
      // OPKs are distributed via the relay /opks pool, not embedded in the bundle.
    };
  }

  /**
   * Looks up a peer's pre-key bundle from the relay's /directory endpoint.
   *
   * `query` may be:
   *   - a hex Ed25519 public key (64 chars)
   *   - a `@username` string (relay resolves to public key)
   *
   * Returns null if the peer is not found or the relay is unreachable.
   */
  async lookupPreKeyBundle(query: string): Promise<{ bundle: PreKeyBundle; publicKey: string; username?: string } | null> {
    const wsUrls = Array.isArray(this.nodeUrl) ? this.nodeUrl : [this.nodeUrl];
    const primaryWsUrl = wsUrls[0];
    if (!primaryWsUrl || primaryWsUrl === 'mesh') return null;

    const httpUrl = primaryWsUrl
      .replace(/^wss:\/\//, 'https://')
      .replace(/^ws:\/\//, 'http://');

    const isUsername = query.startsWith('@');
    const param = isUsername ? 'username' : 'publicKey';
    // Strip the leading '@' for the wire query — the relay's validateUsername
    // requires a bare `[a-z0-9_-]{3,30}` and rejects '@' with a 400.
    const value = isUsername ? query.slice(1) : query;
    const res = await fetch(
      `${httpUrl}/directory?namespace=${encodeURIComponent(this.namespace)}&${param}=${encodeURIComponent(value)}`,
    );
    if (!res.ok) return null;

    const json = await res.json() as { bundle?: string; publicKey?: string; username?: string };
    if (!json.bundle) return null;

    const resolvedKey = json.publicKey ?? (param === 'publicKey' ? query : null);
    if (!resolvedKey) return null;

    return {
      bundle: deserializePreKeyBundle(base64ToUint8Array(json.bundle)),
      publicKey: resolvedKey,
      username: json.username,
    };
  }

  /**
   * Publishes the pre-key bundle to the relay's /directory endpoint so peers
   * can initiate contact without an out-of-band QR exchange.
   * If `username` is provided it is registered alongside the bundle.
   *
   * Under the namespace's signed-transfer policy (the SDK default), a
   * username taken by a different identity returns `{ ok: false, usernameTaken: true }`.
   * In that case the bundle is re-published without the username so the
   * identity remains discoverable by peerId, and the caller can surface
   * the conflict to the user.
   */
  async publishPreKeyBundle(
    bundle: PreKeyBundle,
    username?: string,
    transferAuth?: { fromPublicKey: string; expiresAt: number; signature: string },
  ): Promise<{ ok: boolean; usernameTaken?: boolean; transferAuthInvalid?: boolean }> {
    const wsUrls = Array.isArray(this.nodeUrl) ? this.nodeUrl : [this.nodeUrl];
    const primaryWsUrl = wsUrls[0];
    if (!primaryWsUrl || primaryWsUrl === 'mesh') return { ok: false };

    const httpUrl = primaryWsUrl
      .replace(/^wss:\/\//, 'https://')
      .replace(/^ws:\/\//, 'http://');

    const post = (withUsername: string | undefined, withTransferAuth?: typeof transferAuth) =>
      fetch(`${httpUrl}/directory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          namespace: this.namespace,
          publicKey: uint8ArrayToHex(this.identity.getEdPublicKey()),
          bundle: uint8ArrayToBase64(serializePreKeyBundle(bundle)),
          ...(withUsername ? { username: withUsername } : {}),
          ...(withTransferAuth ? { transferAuth: withTransferAuth } : {}),
        }),
      });

    const res = await post(username, transferAuth);
    if (res.status === 403 && transferAuth) {
      // Relay rejected the transfer-auth proof. Fall back to a username-less
      // publish so the identity stays discoverable, and surface the failure.
      await post(undefined).catch(() => {});
      return { ok: false, transferAuthInvalid: true };
    }
    if (res.status === 409 && username) {
      await post(undefined).catch(() => {});
      return { ok: false, usernameTaken: true };
    }
    return { ok: res.ok };
  }

  /**
   * Sets the namespace-wide policy that governs username ownership.
   * First-writer-wins at the relay — the first call locks the policy in.
   * Subsequent calls with the same value succeed; with a different value
   * the relay returns 409 and this method throws.
   */
  async setNamespacePolicy(
    usernamePolicy: 'signed-transfer' | 'last-writer-wins',
  ): Promise<void> {
    const wsUrls = Array.isArray(this.nodeUrl) ? this.nodeUrl : [this.nodeUrl];
    const primaryWsUrl = wsUrls[0];
    if (!primaryWsUrl || primaryWsUrl === 'mesh') return;

    const httpUrl = primaryWsUrl
      .replace(/^wss:\/\//, 'https://')
      .replace(/^ws:\/\//, 'http://');

    const res = await fetch(`${httpUrl}/namespace-policy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ namespace: this.namespace, usernamePolicy }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `setNamespacePolicy failed: HTTP ${res.status}`);
    }
  }

  /**
   * Reads the effective namespace policy from the relay. Returns
   * 'signed-transfer' as the default when no policy row exists.
   */
  async getNamespacePolicy(): Promise<'signed-transfer' | 'last-writer-wins'> {
    const wsUrls = Array.isArray(this.nodeUrl) ? this.nodeUrl : [this.nodeUrl];
    const primaryWsUrl = wsUrls[0];
    if (!primaryWsUrl || primaryWsUrl === 'mesh') return 'signed-transfer';

    const httpUrl = primaryWsUrl
      .replace(/^wss:\/\//, 'https://')
      .replace(/^ws:\/\//, 'http://');

    const res = await fetch(
      `${httpUrl}/namespace-policy?namespace=${encodeURIComponent(this.namespace)}`,
    );
    if (!res.ok) return 'signed-transfer';
    const body = await res.json() as { usernamePolicy?: string };
    return body.usernamePolicy === 'last-writer-wins'
      ? 'last-writer-wins'
      : 'signed-transfer';
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

  /**
   * Drop a session entirely — both in-memory and persisted. Also clears
   * any cached pre-key bundle and ed25519 identity key for the peer.
   * Used by deleteConversation to ensure that re-adding a contact really
   * starts from scratch rather than reusing a stale (possibly corrupted)
   * ratchet state.
   */
  deleteSession(peerId: string): void {
    this.sessions.delete(peerId);
    this.peerPreKeyBundles.delete(peerId);
    this.peerEdKeys.delete(peerId);
    // Also drop any DH-key-index entries that point at this peer.
    for (const [dhKey, indexedPeer] of this.dhKeyIndex) {
      if (indexedPeer === peerId) this.dhKeyIndex.delete(dhKey);
    }
    this.storage?.delete(`sessions/${peerId}`).catch(() => {});
    this.storage?.delete(`edkeys/${peerId}`).catch(() => {});
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

  /**
   * Register an Ed25519 identity key for a peer we haven't met directly
   * yet. Used by the group-invite acceptance flow so that fellow group
   * members can be looked up in the relay directory and X3DH-handshaked
   * on demand. Persisted so it survives restarts.
   */
  rememberPeerEdKey(peerId: string, edKey: Uint8Array): void {
    if (this.peerEdKeys.has(peerId)) return; // don't overwrite a known good value
    this.peerEdKeys.set(peerId, edKey);
    this.storage?.set(`edkeys/${peerId}`, uint8ArrayToHex(edKey)).catch(() => {});
  }

  getSignedPreKeyPair(): KeyPair | null {
    return this.signedPreKeyPair;
  }

  // ----------------------------------------------------------------
  // Session establishment
  // ----------------------------------------------------------------

  /**
   * Ensures a Double Ratchet session exists with `recipientId`.
   * If no session exists at all, initiates X3DH from a cached or
   * directory-fetched bundle. If a session exists — even a fresh
   * receiver session that hasn't yet received its first inbound
   * ratchet message — we leave it alone. Auto-reinitiating in that
   * window causes a session ping-pong: an internal `sendControl`
   * (e.g. entropy_challenge fired by onContactEstablished) on a
   * just-created receiver session would trigger a fresh x3dh_init
   * back at the original sender, who would then overwrite their
   * sender session, who would then auto-reinitiate, etc. The
   * `handshake_activate` ratchet message that initiateHandshake now
   * sends covers the original "stuck receiver-only" concern.
   * Recovery from genuinely-stuck states is via addContactByKey.
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
        this.setBundle(recipientId, fresh.bundle);
        await this.initiateHandshake(recipientId, fresh.bundle);
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

    // Claim one OPK from the relay for full 4-DH. Falls back to 3-DH if none
    // are available (relay offline, peer hasn't uploaded any yet).
    const peerEdKeyHex = uint8ArrayToHex(bundle.identityKey);
    const claimedOPK = await this.claimRemoteOPK(peerEdKeyHex);
    const bundleWithOPK: PreKeyBundle = claimedOPK
      ? { ...bundle, oneTimePreKey: claimedOPK }
      : bundle;

    const result = initiateKeyExchange(aliceIdentity, bundleWithOPK);

    const ratchetState = initSender(result.sharedSecret, bundle.signedPreKey);
    this.sessions.set(peerId, ratchetState);
    this.storage?.set(`sessions/${peerId}`, serializeRatchetState(ratchetState)).catch(() => {});

    const handshakeEnvelope: HandshakeEnvelope = {
      type: 'x3dh_init',
      senderId: uint8ArrayToHex(this.identity.getPublicKey()),
      ephemeralPublicKey: Array.from(result.ephemeralPublicKey),
      identityKey: Array.from(this.identity.getEdPublicKey()),
      // Tell Bob which OPK we consumed so he can look up the private key.
      ...(result.usedOneTimePreKey && bundleWithOPK.oneTimePreKey
        ? { usedOneTimePreKeyPublic: Array.from(bundleWithOPK.oneTimePreKey) }
        : {}),
      // Include ML-KEM-768 ciphertext when PQXDH was used.
      ...(result.pqCiphertext
        ? { pqCiphertext: Array.from(result.pqCiphertext) }
        : {}),
      // Announce our namespace so the recipient can reply cross-namespace —
      // only when interop is opted in (else absent, envelope unchanged).
      ...((): { senderNamespace?: number[] } => {
        const ns = this.interopNamespace();
        return ns ? { senderNamespace: Array.from(ns) } : {};
      })(),
    };

    const envelopeBytes = new TextEncoder().encode(JSON.stringify(handshakeEnvelope));
    const recipientPublicKey = this.peerCache.getPeerPublicKey(peerId);
    if (!recipientPublicKey) return;

    const destHash = deriveDestHash(this.namespaceIdFor(peerId), recipientPublicKey, getCurrentEpochHour());
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

    // Tell the coordinator to send a handshake-activate ratchet message.
    // This advances the receiver's state from receive-only to fully usable
    // on first decrypt. See the constructor doc comment.
    this.onHandshakeInitiated(peerId);

    // Schedule the session-health ping. Coordinator decides timing.
    this.onSessionEstablished(peerId, 'initiator');
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

    // Look up the OPK private key if Alice used one. The lookup is synchronous
    // (in-memory) — the pool is always ready so there's no async gap.
    let bobOPK: KeyPair | null = null;
    if (envelope.usedOneTimePreKeyPublic) {
      const opkPubHex = uint8ArrayToHex(new Uint8Array(envelope.usedOneTimePreKeyPublic));
      bobOPK = this.opkPool.get(opkPubHex) ?? null;
      if (bobOPK) {
        this.opkPool.delete(opkPubHex);
        this.storage?.delete(`opks/${opkPubHex}`).catch(() => {});
        // Replenish in the background — keeps pool topped up without blocking
        this.replenishOPKPool().catch(() => {});
      }
      // If OPK not found (already consumed), bobOPK stays null → 3-DH fallback.
      // Alice computed 4-DH, so the secrets won't match and decryption fails.
      // This only happens on duplicate x3dh_init delivery, which the dedup
      // layer prevents in practice.
    }

    const pqCiphertext = envelope.pqCiphertext
      ? new Uint8Array(envelope.pqCiphertext)
      : undefined;

    const sharedSecret = completeKeyExchange(
      bobIdentity,
      bobSignedPreKey,
      bobOPK,
      aliceIdentityKey,
      aliceEphemeralKey,
      pqCiphertext,
      this.pqSecretKey ?? undefined,
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

    // Notify the coordinator so it can update the permission manager. Pass the
    // sender's namespace (if they announced one) so cross-namespace replies can
    // be addressed into it (ADR-009).
    const senderNs = envelope.senderNamespace ? new Uint8Array(envelope.senderNamespace) : undefined;
    this.onContactEstablished(envelope.senderId, senderNs);

    // Fresh session as the responder — clear any stale health state. We
    // do NOT initiate a ping ourselves; the initiator handles that.
    this.onSessionEstablished(envelope.senderId, 'responder');

    // Send handshake response
    const response: HandshakeEnvelope = {
      type: 'x3dh_response',
      senderId: uint8ArrayToHex(this.identity.getPublicKey()),
    };

    const responseBytes = new TextEncoder().encode(JSON.stringify(response));
    const peerPublicKey = this.peerCache.getPeerPublicKey(envelope.senderId);
    if (!peerPublicKey) return;

    const destHash = deriveDestHash(this.namespaceIdFor(envelope.senderId), peerPublicKey, getCurrentEpochHour());
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
