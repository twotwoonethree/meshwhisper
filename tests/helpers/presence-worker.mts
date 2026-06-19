// Child-process worker for the presence test.
// argv: <nodeUrl> <username>
//
// Line protocol (stdio):
//   stdout:  READY <peerId>
//            ADDED <peerId>
//            PRESENCE <peerId> <status>        onPresence fired
//            MSG <senderId> <text>             inbound DM
//            GOTP <peerId> <status>            answer to GETP
//            SENT
//            ERR <detail>
//   stdin:   ADD <@username>
//            SEND <peerId> <text>
//            ANNOUNCE <peerId>
//            GETP <peerId>

import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MeshWhisper } from '../../src/index.js';
import { NodeStorage } from '../../src/persistence/node-storage.js';

const [, , nodeUrl, username] = process.argv;
const DEV_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mw-pres-${username}-`));

const mw = await MeshWhisper.init({
  namespace: 'com.test.presence',
  node: nodeUrl,
  developerKey: DEV_KEY,
  username,
  storage: new NodeStorage(dir),
  transports: { lan: false },
  onMessage: (message) => {
    const me = MeshWhisper.getLocalPeerId();
    if (message.senderId === me) return;
    const text = new TextDecoder().decode(new Uint8Array(message.payload));
    if (text.startsWith('{"__') && text.includes('_ctrl')) return;
    console.log(`MSG ${message.senderId} ${text}`);
  },
  onPresence: (peerId, status) => {
    console.log(`PRESENCE ${peerId} ${status}`);
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
      if (line.startsWith('SEND ')) {
        const idx = line.indexOf(' ', 5);
        const peerId = line.slice(5, idx);
        const text = line.slice(idx + 1);
        await MeshWhisper.send(peerId, new TextEncoder().encode(text));
        console.log('SENT');
        return;
      }
      if (line.startsWith('ANNOUNCE ')) {
        MeshWhisper.announcePresence([line.slice(9).trim()]);
        return;
      }
      if (line.startsWith('GETP ')) {
        const peerId = line.slice(5).trim();
        console.log(`GOTP ${peerId} ${MeshWhisper.getPresence(peerId)}`);
        return;
      }
    } catch (err) {
      console.log(`ERR ${(err as Error).message?.slice(0, 120)}`);
    }
  })();
});
rl.on('close', () => process.exit(0));
