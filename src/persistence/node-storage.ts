// ============================================================
// MeshWhisper SDK — Node.js StorageBackend
// Filesystem-based persistence using one file per key.
// Files are written with mode 0600 (owner read/write only).
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StorageBackend } from './types.js';

/**
 * Node.js StorageBackend backed by the local filesystem.
 *
 * Usage:
 * ```ts
 * import { MeshWhisper } from '@meshwhisper/sdk';
 * import { NodeStorage } from '@meshwhisper/sdk/persistence/node';
 *
 * const mw = await MeshWhisper.init({
 *   namespace: 'com.example.myapp',
 *   storage: new NodeStorage('./data/meshwhisper'),
 * });
 * ```
 *
 * Data layout under `dataDir/`:
 *   identity          — hex-encoded Ed25519 private key
 *   sessions/<id>     — serialized RatchetState (JSON)
 *   peers/<id>        — hex-encoded X25519 public key
 *   contacts          — JSON array of peer ID strings
 *   messages/<id>     — JSON array of StoredMessage
 *   seen_ids          — JSON array of { id, ts } for deduplication
 */
export class NodeStorage implements StorageBackend {
  private readonly root: string;

  constructor(dataDir: string) {
    this.root = path.resolve(dataDir);
    fs.mkdirSync(this.root, { recursive: true });
  }

  private resolve(key: string): string {
    // Sanitize: only allow alphanumeric, underscore, hyphen, forward slash, dot
    const safe = key.replace(/[^a-zA-Z0-9/_.-]/g, '_');
    const abs = path.join(this.root, safe);
    // Guard against path traversal
    if (!abs.startsWith(this.root + path.sep) && abs !== this.root) {
      throw new Error(`Storage key escapes data directory: ${key}`);
    }
    return abs;
  }

  async get(key: string): Promise<string | null> {
    try {
      return fs.readFileSync(this.resolve(key), 'utf-8');
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    const filePath = this.resolve(key);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Write atomically: write to a temp file, then rename
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, value, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, filePath);
  }

  async delete(key: string): Promise<void> {
    try {
      fs.unlinkSync(this.resolve(key));
    } catch {
      // File doesn't exist — fine
    }
  }

  async keys(prefix: string): Promise<string[]> {
    // Walk the directory corresponding to the prefix
    const prefixPath = this.resolve(prefix);
    // The prefix may itself be a directory (e.g. "sessions/") or a path fragment
    const dir = prefix.endsWith('/') ? prefixPath : path.dirname(prefixPath);
    const base = prefix.endsWith('/') ? '' : path.basename(prefixPath);

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && e.name.startsWith(base))
        .map((e) => {
          const rel = path.relative(this.root, path.join(dir, e.name));
          return rel.replace(/\\/g, '/'); // normalise on Windows
        });
    } catch {
      return [];
    }
  }
}
