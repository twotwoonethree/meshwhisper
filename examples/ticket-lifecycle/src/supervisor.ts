// =============================================================================
// Ticket lifecycle — compliance supervisor
//
// Same behaviour as supervised-chat/src/supervisor.ts (silent group member,
// JSON-Lines audit log) — included here so this example is self-contained.
// In a real deployment one supervisor process can serve many escalation
// groups; this is the same code, just deployed under a different identity.
//
// Compatible with the supervised-chat dashboard — point it at this
// example's audit log via AUDIT_LOG_PATH.
// =============================================================================

import 'dotenv/config';
import { MeshWhisper } from '@meshwhisper/sdk';
import { startBot, decodeText } from './shared.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const USERNAME = process.env.SUPERVISOR_USERNAME ?? 'acme-compliance';
const DATA_DIR = process.env.SUPERVISOR_DATA_DIR ?? './data/supervisor';
const AUDIT_LOG = process.env.SUPERVISOR_AUDIT_LOG ?? path.join(DATA_DIR, 'audit.jsonl');

fs.mkdirSync(path.dirname(AUDIT_LOG), { recursive: true });
const auditStream = fs.createWriteStream(AUDIT_LOG, { flags: 'a' });

interface AuditEntry {
  ts: string;
  observedAt: string;
  groupId: string;
  senderPeerId: string;
  groupSenderId?: string | undefined;
  text: string;
}

function audit(entry: AuditEntry): void {
  auditStream.write(JSON.stringify(entry) + '\n');
}

await startBot({
  username: USERNAME,
  dataDir: DATA_DIR,

  onGroupInvite: (groupId, groupName, invitedBy, members) => {
    console.log(
      `[invite] supervising "${groupName}" (${groupId.slice(0, 8)}, ` +
      `${members.length} members) — invited by ${invitedBy.slice(0, 8)}`,
    );
    MeshWhisper.acceptGroupInvite(groupId);
  },

  onMessage: (msg) => {
    if (!msg.groupId) return;
    const me = MeshWhisper.getLocalPeerId();
    if (msg.groupSenderId === me) return;

    const text = decodeText(msg.payload);
    if (text === null) return;

    audit({
      ts: new Date(msg.timestamp ?? Date.now()).toISOString(),
      observedAt: new Date().toISOString(),
      groupId: msg.groupId,
      senderPeerId: msg.senderId,
      groupSenderId: msg.groupSenderId,
      text,
    });

    console.log(
      `[audit ${msg.groupId.slice(0, 8)}] ${(msg.groupSenderId ?? msg.senderId).slice(0, 8)}: ` +
      `${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`,
    );
  },
});

console.log(`  audit log: ${AUDIT_LOG}`);
