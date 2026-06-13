// Child-process worker for multi-device self-fan-out tests.
// argv: <nodeUrl> <username>
//
// stdout line protocol:
//   READY <peerId>
//   ADDED <peerId>
//   OFFER <json>                               offer payload from secondary
//   LINKED <accountPeerId> <contactCount>      onDeviceLinked fired
//   MSG <conv> <mid> <inbound|outbound> <text>
//   STORED <conv> <mid> <fields-json>
//   ERR <detail>
//
// stdin line protocol:
//   ADD <@user>
//   LINKOFFER
//   LINKACCEPT <json>
//   SEND <peerOrGroupId> <text>
//   SHOW <conv> <messageId>

import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MeshWhisper } from '../../src/index.js';
import { NodeStorage } from '../../src/persistence/node-storage.js';

const [, , nodeUrl, username] = process.argv;
const DEV_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mw-md-${username}-`));

const mw = await MeshWhisper.init({
  namespace: 'com.test.selffanout',
  node: nodeUrl,
  developerKey: DEV_KEY,
  username,
  storage: new NodeStorage(dir),
  transports: { lan: false },
  onMessage: (message) => {
    const conv = message.groupId ?? (message.senderId === mw.getLocalPeerId() ? message.recipientId : message.senderId);
    const direction = message.senderId === mw.getLocalPeerId() ? 'outbound' : 'inbound';
    const text = new TextDecoder().decode(new Uint8Array(message.payload));
    console.log(`MSG ${conv} ${message.id} ${direction} ${text}`);
  },
  onDeviceLinked: (accountPeerId, contactCount) => {
    console.log(`LINKED ${accountPeerId} ${contactCount}`);
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
      if (line === 'LINKOFFER') {
        const offer = await MeshWhisper.createDeviceLinkOffer({ ttlMs: 5 * 60_000 });
        console.log(`OFFER ${JSON.stringify(offer)}`);
        return;
      }
      if (line.startsWith('LINKACCEPT ')) {
        const offer = JSON.parse(line.slice(11));
        await MeshWhisper.acceptDeviceLinkOffer(offer);
        return;
      }
      if (line.startsWith('SEND ')) {
        const idx = line.indexOf(' ', 5);
        const target = line.slice(5, idx);
        const text = line.slice(idx + 1);
        // Auto-route by whether target is a known group
        const group = MeshWhisper.getGroup(target);
        if (group) {
          await group.send(new TextEncoder().encode(text));
        } else {
          await MeshWhisper.send(target, new TextEncoder().encode(text));
        }
        return;
      }
      if (line.startsWith('SHOW ')) {
        const [conv, mid] = line.slice(5).trim().split(/\s+/);
        const msgs = await MeshWhisper.getMessages(conv!, { limit: 200 });
        const m = msgs.find((x) => x.id === mid);
        if (!m) { console.log(`STORED ${conv} ${mid} null`); return; }
        const fields = {
          direction: m.direction,
          status: m.status,
          senderId: m.senderId,
          groupId: m.groupId ?? null,
          replyTo: m.replyTo ?? null,
          forwardedFrom: m.forwardedFrom ?? null,
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
