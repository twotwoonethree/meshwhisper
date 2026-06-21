// =============================================================================
// Customer service — compliance supervisor
//
// Same behaviour as supervised-chat / ticket-lifecycle: a silent group member
// that writes a JSON-Lines audit log of everything said in the escalated
// conversations it's invited to. It reads via group MEMBERSHIP — the relay
// stays blind. Point the supervised-chat dashboard at AUDIT_LOG_PATH to browse.
// =============================================================================

import 'dotenv/config';
import { MeshWhisper } from '@meshwhisper/sdk';
import { startActor, decodeText } from './shared.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const USERNAME = process.env.SUPERVISOR_USERNAME ?? 'acme-supervisor';
const DATA_DIR = process.env.SUPERVISOR_DATA_DIR ?? './data/supervisor';
const AUDIT_LOG = process.env.SUPERVISOR_AUDIT_LOG ?? path.join(DATA_DIR, 'audit.jsonl');

fs.mkdirSync(path.dirname(AUDIT_LOG), { recursive: true });
const auditStream = fs.createWriteStream(AUDIT_LOG, { flags: 'a' });

await startActor({
  username: USERNAME,
  dataDir: DATA_DIR,

  onGroupInvite: (groupId, groupName, invitedBy, members) => {
    console.log(`[supervising] "${groupName}" (${groupId.slice(0, 8)}, ${members.length} members)`);
    MeshWhisper.acceptGroupInvite(groupId);
  },

  onMessage: (msg) => {
    if (!msg.groupId) return;
    const me = MeshWhisper.getLocalPeerId();
    if (msg.groupSenderId === me) return;

    const text = decodeText(msg.payload);
    if (text === null) return;

    auditStream.write(JSON.stringify({
      ts: new Date(msg.timestamp ?? Date.now()).toISOString(),
      observedAt: new Date().toISOString(),
      groupId: msg.groupId,
      senderPeerId: msg.senderId,
      groupSenderId: msg.groupSenderId,
      text,
    }) + '\n');

    console.log(`[audit ${msg.groupId.slice(0, 8)}] ${(msg.groupSenderId ?? msg.senderId).slice(0, 8)}: ${text.slice(0, 80)}`);
  },
});

console.log(`  audit log: ${AUDIT_LOG}`);
