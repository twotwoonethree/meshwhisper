// ============================================================
// MeshWhisper SDK — Compliance API
// Optional compliance layer for message logging, audit export,
// content scanning, and middleware hooks as described in PRD §12.3.
//
// The protocol never accesses plaintext — the developer's app does.
// All hooks are entirely optional and the app developer's
// responsibility.
// ============================================================

import { gcm } from '@noble/ciphers/aes';
import { randomBytes } from '@noble/hashes/utils';
import type { ComplianceConfig, Message, MessageHook, AuditExportMode } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** AES-256-GCM nonce length in bytes. */
const AES_GCM_NONCE_LENGTH = 12;

/** AES-256 key length in bytes. */
const AES_256_KEY_LENGTH = 32;

/** Default retention enforcement interval: 1 hour. */
const DEFAULT_ENFORCEMENT_INTERVAL_MS = 60 * 60 * 1000;

/** Milliseconds per day. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single logged message with metadata. */
export interface LogEntry {
  message: Message;
  direction: 'sent' | 'received';
  loggedAt: number;
}

/** Options for filtering the message log. */
export interface LogQueryOptions {
  /** Only entries logged at or after this timestamp (ms). */
  since?: number;
  /** Only entries logged at or before this timestamp (ms). */
  until?: number;
  /** Only entries involving this peer (as sender or recipient). */
  peerId?: string;
}

/** Options for exporting the audit log. */
export interface AuditExportOptions {
  /** Only entries logged at or after this timestamp (ms). */
  since?: number;
  /** Only entries logged at or before this timestamp (ms). */
  until?: number;
}

/** Result of a content scan. */
export interface ScanResult {
  approved: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Text encoder / decoder
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();

// ---------------------------------------------------------------------------
// ComplianceManager
// ---------------------------------------------------------------------------

export class ComplianceManager {
  private config: ComplianceConfig;
  private log: LogEntry[] = [];
  private complianceKey: Uint8Array | null = null;

  private beforeSendHooks: MessageHook[] = [];
  private afterReceiveHooks: MessageHook[] = [];

  private retentionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: ComplianceConfig) {
    this.config = config ?? {};
  }

  // -----------------------------------------------------------------------
  // Configuration
  // -----------------------------------------------------------------------

  /**
   * Apply a new compliance configuration. Merges with the existing config.
   */
  configure(config: ComplianceConfig): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Return a shallow copy of the current compliance configuration.
   */
  getConfig(): ComplianceConfig {
    return { ...this.config };
  }

  /**
   * Returns true if any compliance feature is active:
   * logging enabled, audit export mode set, retention configured,
   * or a content scanner registered.
   */
  isEnabled(): boolean {
    return (
      this.config.logging === true ||
      this.config.auditExport !== undefined ||
      this.config.retentionDays !== undefined ||
      this.config.contentScanning !== undefined
    );
  }

  // -----------------------------------------------------------------------
  // Message logging
  // -----------------------------------------------------------------------

  /**
   * Store a plaintext message in the local log.
   * Only records when logging is enabled in the config.
   */
  logMessage(message: Message, direction: 'sent' | 'received'): void {
    if (!this.config.logging) return;

    const entry: LogEntry = {
      message,
      direction,
      loggedAt: Date.now(),
    };

    this.log.push(entry);
  }

  /**
   * Retrieve logged messages, optionally filtering by time range and peer.
   */
  getMessageLog(options?: LogQueryOptions): LogEntry[] {
    if (!options) return [...this.log];

    const { since, until, peerId } = options;

    return this.log.filter((entry) => {
      if (since !== undefined && entry.loggedAt < since) return false;
      if (until !== undefined && entry.loggedAt > until) return false;
      if (peerId !== undefined) {
        const msg = entry.message;
        if (msg.senderId !== peerId && msg.recipientId !== peerId) return false;
      }
      return true;
    });
  }

  /**
   * Clear log entries older than the given timestamp.
   * If no timestamp is provided, clears the entire log.
   * Returns the number of entries removed.
   */
  clearLog(before?: number): number {
    if (before === undefined) {
      const count = this.log.length;
      this.log = [];
      return count;
    }

    const originalLength = this.log.length;
    this.log = this.log.filter((entry) => entry.loggedAt >= before);
    return originalLength - this.log.length;
  }

  // -----------------------------------------------------------------------
  // Audit export
  // -----------------------------------------------------------------------

  /**
   * Export the audit log as a Uint8Array.
   *
   * - If auditExport is 'plaintext', returns UTF-8 encoded JSON.
   * - If auditExport is 'encrypted', encrypts the JSON with AES-256-GCM
   *   using the compliance key set via setComplianceKey().
   * - If auditExport is not configured, defaults to 'plaintext'.
   *
   * The encrypted format is: [12-byte nonce][ciphertext+tag].
   */
  exportAuditLog(options?: AuditExportOptions): Uint8Array {
    const entries = this.getFilteredEntries(options);
    const json = JSON.stringify(entries, serializeReplacer);
    const plainBytes = textEncoder.encode(json);

    const mode: AuditExportMode = this.config.auditExport ?? 'plaintext';

    if (mode === 'plaintext') {
      return plainBytes;
    }

    // Encrypted export
    if (!this.complianceKey) {
      throw new Error(
        'Compliance key not set. Call setComplianceKey() before exporting an encrypted audit log.',
      );
    }

    if (this.complianceKey.length !== AES_256_KEY_LENGTH) {
      throw new Error(
        `Compliance key must be ${AES_256_KEY_LENGTH} bytes for AES-256-GCM.`,
      );
    }

    const nonce = randomBytes(AES_GCM_NONCE_LENGTH);
    const cipher = gcm(this.complianceKey, nonce);
    const ciphertext = cipher.encrypt(plainBytes);

    // Pack as [nonce][ciphertext+tag]
    const result = new Uint8Array(nonce.length + ciphertext.length);
    result.set(nonce, 0);
    result.set(ciphertext, nonce.length);

    return result;
  }

  /**
   * Set the AES-256 key used to encrypt audit exports.
   */
  setComplianceKey(key: Uint8Array): void {
    if (key.length !== AES_256_KEY_LENGTH) {
      throw new Error(
        `Compliance key must be ${AES_256_KEY_LENGTH} bytes for AES-256-GCM.`,
      );
    }
    this.complianceKey = new Uint8Array(key);
  }

  // -----------------------------------------------------------------------
  // Content scanning
  // -----------------------------------------------------------------------

  /**
   * Run the developer-supplied content scanner on a message.
   * Returns { approved: true } if no scanner is configured.
   */
  async scanMessage(message: Message): Promise<ScanResult> {
    if (!this.config.contentScanning) {
      return { approved: true };
    }

    return this.config.contentScanning(message);
  }

  // -----------------------------------------------------------------------
  // Middleware hooks
  // -----------------------------------------------------------------------

  /** Register a hook that runs before a message is sent. */
  addBeforeSendHook(hook: MessageHook): void {
    this.beforeSendHooks.push(hook);
  }

  /** Register a hook that runs after a message is received. */
  addAfterReceiveHook(hook: MessageHook): void {
    this.afterReceiveHooks.push(hook);
  }

  /** Remove a previously registered before-send hook. */
  removeBeforeSendHook(hook: MessageHook): void {
    const idx = this.beforeSendHooks.indexOf(hook);
    if (idx !== -1) {
      this.beforeSendHooks.splice(idx, 1);
    }
  }

  /** Remove a previously registered after-receive hook. */
  removeAfterReceiveHook(hook: MessageHook): void {
    const idx = this.afterReceiveHooks.indexOf(hook);
    if (idx !== -1) {
      this.afterReceiveHooks.splice(idx, 1);
    }
  }

  /**
   * Run all before-send hooks in order.
   * Returns false if any hook returns false (message should be blocked).
   */
  async runBeforeSendHooks(message: Message): Promise<boolean> {
    return this.runHooks(this.beforeSendHooks, message);
  }

  /**
   * Run all after-receive hooks in order.
   * Returns false if any hook returns false (message should be rejected).
   */
  async runAfterReceiveHooks(message: Message): Promise<boolean> {
    return this.runHooks(this.afterReceiveHooks, message);
  }

  // -----------------------------------------------------------------------
  // Retention enforcement
  // -----------------------------------------------------------------------

  /**
   * Start a periodic timer that prunes log entries older than
   * retentionDays. No-op if retentionDays is not configured.
   *
   * @param intervalMs How often to run the prune (default: 1 hour).
   */
  startRetentionEnforcement(intervalMs?: number): void {
    if (this.retentionTimer !== null) return; // already running
    if (this.config.retentionDays === undefined) return;

    const interval = intervalMs ?? DEFAULT_ENFORCEMENT_INTERVAL_MS;

    this.retentionTimer = setInterval(() => {
      this.pruneExpiredEntries();
    }, interval);

    // Prevent the timer from keeping the process alive in Node.js.
    if (typeof this.retentionTimer === 'object' && 'unref' in this.retentionTimer) {
      (this.retentionTimer as NodeJS.Timeout).unref();
    }

    // Run an initial prune immediately.
    this.pruneExpiredEntries();
  }

  /**
   * Stop the periodic retention enforcement timer.
   */
  stopRetentionEnforcement(): void {
    if (this.retentionTimer !== null) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = null;
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Run an ordered list of hooks against a message.
   * Returns false as soon as any hook returns false; true if all pass.
   */
  private async runHooks(hooks: MessageHook[], message: Message): Promise<boolean> {
    for (const hook of hooks) {
      const result = await hook(message);
      if (result === false) return false;
    }
    return true;
  }

  /**
   * Remove log entries older than the configured retentionDays.
   */
  private pruneExpiredEntries(): void {
    if (this.config.retentionDays === undefined) return;
    const cutoff = Date.now() - this.config.retentionDays * MS_PER_DAY;
    this.log = this.log.filter((entry) => entry.loggedAt >= cutoff);
  }

  /**
   * Filter log entries by optional time range.
   */
  private getFilteredEntries(options?: AuditExportOptions): LogEntry[] {
    if (!options) return [...this.log];

    const { since, until } = options;
    return this.log.filter((entry) => {
      if (since !== undefined && entry.loggedAt < since) return false;
      if (until !== undefined && entry.loggedAt > until) return false;
      return true;
    });
  }
}

// ---------------------------------------------------------------------------
// JSON serialization helpers
// ---------------------------------------------------------------------------

/**
 * Custom replacer for JSON.stringify that converts Uint8Array fields
 * to base64 strings so the audit log is portable.
 */
function serializeReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { __type: 'Uint8Array', data: uint8ArrayToBase64(value) };
  }
  return value;
}

/**
 * Encode a Uint8Array to a base64 string without depending on Node.js
 * Buffer.  Works in both browser and Node.js environments.
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
