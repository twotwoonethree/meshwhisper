// Child-process worker for the LAN dual-send tests (tests/lan-transport.test.ts).
// The SDK is a per-process singleton, so each peer in a multi-peer live test
// runs in its own process. Line protocol on stdio:
//
//   stdout:  READY <peerId>     after init
//            ADDED <peerId>     after ADD completes
//            MSG <text>         on every delivered message
//            ERR <detail>       on command failure
//   stdin:   ADD <@username>    add contact (relay directory lookup)
//            SEND <text>        send to the last-added contact
//
// argv: <nodeUrl> <username> <lanTcpPort>

import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MeshWhisper } from '../../src/index.js';
import { NodeStorage } from '../../src/persistence/node-storage.js';

const [, , nodeUrl, username, lanTcpPort] = process.argv;
const DEV_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mw-lan-${username}-`));

const mw = await MeshWhisper.init({
  namespace: 'com.test.lan',
  node: nodeUrl,
  developerKey: DEV_KEY,
  username,
  storage: new NodeStorage(dir),
  transports: { lan: { tcpPort: parseInt(lanTcpPort!, 10) } },
  onMessage: (message) => {
    const text = new TextDecoder().decode(new Uint8Array(message.payload));
    console.log(`MSG ${text}`);
  },
});

console.log(`READY ${mw.getLocalPeerId()}`);

let currentPeer: string | null = null;
const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  void (async () => {
    try {
      if (line.startsWith('ADD ')) {
        const peerId = await MeshWhisper.addContactByKey(line.slice(4).trim());
        if (peerId) {
          currentPeer = peerId;
          console.log(`ADDED ${peerId}`);
        } else {
          console.log('ERR add-failed');
        }
      } else if (line.startsWith('SEND ')) {
        if (!currentPeer) {
          console.log('ERR no-peer');
          return;
        }
        // Sends may surface relay errors when the node is down — the LAN
        // offer has already gone out by then, so report but don't exit.
        await MeshWhisper.send(currentPeer, new TextEncoder().encode(line.slice(5))).catch((e) => {
          console.log(`ERR send ${(e as Error).message?.slice(0, 60)}`);
        });
      }
    } catch (err) {
      console.log(`ERR ${(err as Error).message?.slice(0, 80)}`);
    }
  })();
});

rl.on('close', () => process.exit(0));
