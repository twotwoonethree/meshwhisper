// Tier 1 "Export my data" — a single downloadable copy of everything Prudence
// holds locally for this account: conversation transcripts, local metadata
// (contact names, accepted/declined contacts, group rosters) and, when a
// passphrase is given, the account identity key.
//
// This is an EXPORT, not a restore: there is no SDK message-import API, so the
// bundle can't be re-loaded into the message store in-app. See ADR-007 for the
// Tier 2 design (E2EE relay-backed message backup with a recovery key) that
// would make a true round-trip restore possible.
//
// Security posture (mirrors WhatsApp's password-protected backup):
//   - passphrase set   -> whole bundle encrypted (PBKDF2 + AES-256-GCM), and
//                         the account identity key is included.
//   - no passphrase    -> plaintext JSON, and the identity key is OMITTED
//                         (we never write raw key material to an unencrypted
//                         download). Messages are still the user's own data.

import { MeshWhisper } from '@meshwhisper/sdk';
import type { StoredMessage } from '@meshwhisper/sdk';
import { getSDK } from './sdk.ts';
import { getAllContactNames } from './contact-names.ts';
import { getAll as getAllAccepted, getDeclined } from './accepted-contacts.ts';
import { loadGroups } from './group-storage.ts';
import { isImageMime } from './media.ts';

const PBKDF2_ITERATIONS = 210_000; // OWASP 2023 floor for PBKDF2-HMAC-SHA256

function decodePayload(payload: number[] | Uint8Array): string {
  try {
    return new TextDecoder().decode(new Uint8Array(payload));
  } catch {
    return '';
  }
}

function isControl(text: string): boolean {
  try {
    return typeof (JSON.parse(text) as { __prudence_ctrl?: unknown }).__prudence_ctrl === 'string';
  } catch {
    return false;
  }
}

function mediaSummary(text: string): string | null {
  try {
    const obj = JSON.parse(text) as { __mw_media?: boolean; mimeType?: string; fileName?: string };
    if (!obj.__mw_media) return null;
    return isImageMime(obj.mimeType ?? '') ? '[Photo]' : `[File: ${obj.fileName ?? 'attachment'}]`;
  } catch {
    return null;
  }
}

function stamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function deriveKey(passphrase: string, salt: Uint8Array, usage: KeyUsage[]): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    usage,
  );
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function encryptBundle(plaintext: string, passphrase: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)),
  );
  return JSON.stringify({
    format: 'prudence-export-encrypted',
    version: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS },
    cipher: 'AES-256-GCM',
    salt: toHex(salt),
    iv: toHex(iv),
    ciphertext: toHex(ciphertext),
  }, null, 2);
}

function download(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface ExportResult {
  filename: string;
  encrypted: boolean;
  conversationCount: number;
}

/**
 * Build and trigger a download of the user's data bundle. When `passphrase` is
 * a non-empty string the whole bundle is encrypted and the identity key is
 * included; otherwise it's plaintext JSON with the identity key omitted.
 */
export async function exportMyData(myUsername: string, passphrase: string): Promise<ExportResult> {
  const sdk = getSDK();
  if (!sdk) throw new Error('Not connected');

  const myPeerId = MeshWhisper.getLocalPeerId();
  const names = getAllContactNames();
  const groups = await loadGroups();
  const groupNameById = new Map(groups.map((g) => [g.id, g.name] as const));

  // Display-name map for the transcript formatter: me, plus every known contact.
  const displayName: Record<string, string> = { [myPeerId]: `${myUsername} (you)` };
  for (const [peerId, name] of Object.entries(names)) displayName[peerId] = `@${name}`;

  const nameFor = (peerId: string): string => displayName[peerId] ?? peerId.slice(0, 8);

  const transcripts = await MeshWhisper.exportAllConversations({
    format: 'text',
    displayName,
    filter: (m: StoredMessage) => !isControl(decodePayload(m.payload)),
    textFormatter: (m: StoredMessage) => {
      const raw = decodePayload(m.payload);
      const body = mediaSummary(raw) ?? (raw || '[binary]');
      const sender = m.direction === 'outbound' ? myPeerId : (m.groupSenderId ?? m.senderId);
      return `[${stamp(m.timestamp)}] ${nameFor(sender)}: ${body}`;
    },
  });

  const conversations = Object.entries(transcripts).map(([peerId, transcript]) => ({
    peerId,
    label: groupNameById.get(peerId) ?? nameFor(peerId),
    type: groupNameById.has(peerId) ? 'group' : 'dm',
    transcript,
  }));

  const bundle: Record<string, unknown> = {
    format: 'prudence-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    account: { username: myUsername, peerId: myPeerId },
    conversations,
    metadata: {
      contactNames: names,
      acceptedContacts: getAllAccepted(),
      declinedContacts: getDeclined(),
      groups,
    },
  };

  if (passphrase) {
    // Identity key only travels inside the encrypted bundle. exportIdentity
    // already encrypts it under the passphrase; the outer layer encrypts the
    // whole bundle under the same passphrase.
    bundle.identity = await MeshWhisper.exportIdentity(passphrase);
  }

  const date = new Date().toISOString().slice(0, 10);
  const json = JSON.stringify(bundle, null, 2);

  if (passphrase) {
    const filename = `prudence-backup-${myUsername}-${date}.enc.json`;
    download(filename, await encryptBundle(json, passphrase));
    return { filename, encrypted: true, conversationCount: conversations.length };
  }

  const filename = `prudence-data-${myUsername}-${date}.json`;
  download(filename, json);
  return { filename, encrypted: false, conversationCount: conversations.length };
}
