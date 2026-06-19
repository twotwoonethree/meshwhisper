// Child-process worker for the group fan-out tests.
// argv: <nodeUrl> <username>
//
// Line protocol (stdio):
//   stdout:  READY <peerId>
//            ADDED <peerId>            ack for ADD
//            INVITED <groupId>         we received a group invite (auto-accepted)
//            CREATED <groupId>         we created a group
//            SENT <messageId>          we sent a group message
//            MSG <conversationId> <messageId> <text>          inbound msg
//            REACT <conversationId> <messageId> <emoji> <peerId> <add>  inbound reaction
//            GRECEIPT <groupId> <messageId> <peerId> <status>  group delivery/read receipt
//            DISAPPEAR <conversationId> <ttlMs|null> <by>     inbound TTL change
//            STORED <conversationId> <messageId> <fields-json>  on-demand inspection
//            ERR <detail>
//   stdin:   ADD <@username>
//            CREATE <name> <peerId>[ <peerId>...]
//            GSEND <groupId> <text>
//            GREAD <groupId> <messageId>
//            GREACT <groupId> <messageId> <emoji>
//            GDISAPPEAR <groupId> <ms|null>
//            GFORWARD <fromConv> <messageId> <toConv>
//            SHOW <conversationId> <messageId>
//            REPLYSEND <groupId> <targetMessageId> <snippet>::<text>

import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MeshWhisper } from '../../src/index.js';
import { NodeStorage } from '../../src/persistence/node-storage.js';

const [, , nodeUrl, username] = process.argv;
const DEV_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mw-grp-${username}-`));

const mw = await MeshWhisper.init({
  namespace: 'com.test.groupfanout',
  node: nodeUrl,
  developerKey: DEV_KEY,
  username,
  storage: new NodeStorage(dir),
  transports: { lan: false },                  // tests don't need (and don't want) LAN dual-send
  onMessage: (message) => {
    const conv = message.groupId ?? message.senderId;
    const text = new TextDecoder().decode(new Uint8Array(message.payload));
    console.log(`MSG ${conv} ${message.id} ${text}`);
  },
  onGroupInvite: (groupId) => {
    MeshWhisper.acceptGroupInvite(groupId);
    console.log(`INVITED ${groupId}`);
  },
  onReactionUpdated: (conversationId, messageId, peerId, emoji, add) => {
    console.log(`REACT ${conversationId} ${messageId} ${emoji} ${peerId} ${add}`);
  },
  onGroupReceipt: (groupId, messageId, peerId, status) => {
    console.log(`GRECEIPT ${groupId} ${messageId} ${peerId} ${status}`);
  },
  onDisappearingMessagesChanged: (conversationId, ttlMs, by) => {
    console.log(`DISAPPEAR ${conversationId} ${ttlMs ?? 'null'} ${by}`);
  },
});

console.log(`READY ${mw.getLocalPeerId()}`);

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  void (async () => {
    try {
      if (line.startsWith('ADD ')) {
        const peerId = await MeshWhisper.addContactByKey(line.slice(4).trim());
        console.log(peerId ? `ADDED ${peerId}` : 'ERR add-failed');
        return;
      }
      if (line.startsWith('CREATE ')) {
        const parts = line.slice(7).trim().split(/\s+/);
        const name = parts[0]!;
        const memberIds = parts.slice(1);
        const handle = MeshWhisper.createGroup({ name, members: memberIds });
        console.log(`CREATED ${handle.id}`);
        return;
      }
      if (line.startsWith('GSEND ')) {
        const idx = line.indexOf(' ', 6);
        const groupId = line.slice(6, idx);
        const text = line.slice(idx + 1);
        const handle = MeshWhisper.getGroup(groupId);
        if (!handle) { console.log('ERR no-group'); return; }
        await handle.send(new TextEncoder().encode(text));
        return;
      }
      if (line.startsWith('GREAD ')) {
        const [groupId, messageId] = line.slice(6).trim().split(/\s+/);
        await MeshWhisper.markGroupRead(groupId!, messageId!);
        return;
      }
      if (line.startsWith('GREACT ')) {
        const [groupId, messageId, emoji] = line.slice(7).trim().split(/\s+/);
        const outcome = await MeshWhisper.toggleReaction(groupId!, messageId!, emoji!);
        if (outcome === 'noop') console.log(`ERR react-noop ${messageId}`);
        return;
      }
      if (line.startsWith('GDISAPPEAR ')) {
        const [groupId, ttl] = line.slice(11).trim().split(/\s+/);
        const ttlMs = ttl === 'null' ? null : parseInt(ttl!, 10);
        await MeshWhisper.setDisappearingMessages(groupId!, ttlMs);
        return;
      }
      if (line.startsWith('GFORWARD ')) {
        const [fromConv, messageId, toConv] = line.slice(9).trim().split(/\s+/);
        const result = await MeshWhisper.forwardMessage(fromConv!, messageId!, toConv!);
        if (!result) console.log('ERR forward-noop');
        return;
      }
      if (line.startsWith('REPLYSEND ')) {
        const rest = line.slice(10);
        const sp1 = rest.indexOf(' ');
        const groupId = rest.slice(0, sp1);
        const sp2 = rest.indexOf(' ', sp1 + 1);
        const targetId = rest.slice(sp1 + 1, sp2);
        const payload = rest.slice(sp2 + 1);
        const [snippet, text] = payload.split('::');
        const handle = MeshWhisper.getGroup(groupId);
        if (!handle) { console.log('ERR no-group'); return; }
        await handle.send(new TextEncoder().encode(text!), {
          replyTo: { messageId: targetId, snippetText: snippet },
        });
        return;
      }
      if (line.startsWith('SHOW ')) {
        const [conv, mid] = line.slice(5).trim().split(/\s+/);
        const msgs = await MeshWhisper.getMessages(conv!, { limit: 200 });
        const m = msgs.find((x) => x.id === mid);
        if (!m) { console.log(`STORED ${conv} ${mid} null`); return; }
        const fields = {
          reactions: m.reactions ?? null,
          replyTo: m.replyTo ?? null,
          forwardedFrom: m.forwardedFrom ?? null,
          expiresAt: m.expiresAt ?? null,
          groupReceipts: m.groupReceipts ?? null,
        };
        console.log(`STORED ${conv} ${mid} ${JSON.stringify(fields)}`);
        return;
      }
    } catch (err) {
      console.log(`ERR ${(err as Error).message?.slice(0, 100)}`);
    }
  })();
});

rl.on('close', () => process.exit(0));
