// Child-process SDK worker for the cross-operator + interop tests.
// The SDK is a per-process singleton, so each peer runs in its own process —
// which also lets two peers be LIVE on two different relays at once.
//
// argv: <nodeUrl> <username> <namespace> <interop:0|1> [homeRelayPubkeyHex]
//
// stdout:  READY <peerId>
//          QR <base64>                  our contact code
//          ACCEPTED                     ack for ACCEPT
//          SENT                         ack for SEND
//          MSG <conversationId> <messageId> <text>   inbound message
//          ERR <detail>
// stdin:   ACCEPT <qr>
//          SEND <peerId> <text...>

import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MeshWhisper } from '../../src/index.js';
import { NodeStorage } from '../../src/persistence/node-storage.js';

const [, , nodeUrl, username, namespace, interopArg, homeRelay] = process.argv;
const DEV_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const interop = interopArg === '1';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mw-xo-${username}-`));

const mw = await MeshWhisper.init({
  namespace,
  node: nodeUrl,
  developerKey: DEV_KEY,
  username,
  interop,
  ...(homeRelay ? { homeRelay } : {}),
  storage: new NodeStorage(dir),
  transports: { lan: false },
  onMessage: (m) => {
    const conv = m.groupId ?? m.senderId;
    const text = new TextDecoder().decode(new Uint8Array(m.payload));
    console.log(`MSG ${conv} ${m.id} ${text}`);
  },
});

console.log(`READY ${mw.getLocalPeerId()}`);
console.log(`QR ${MeshWhisper.generateContactQR()}`);

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line: string) => {
  void (async () => {
    try {
      if (line.startsWith('ACCEPT ')) {
        await MeshWhisper.acceptContact(line.slice('ACCEPT '.length).trim());
        console.log('ACCEPTED');
      } else if (line.startsWith('SEND ')) {
        const rest = line.slice('SEND '.length);
        const sp = rest.indexOf(' ');
        const peerId = rest.slice(0, sp);
        const text = rest.slice(sp + 1);
        await mw.sendMessage(peerId, new TextEncoder().encode(text));
        console.log('SENT');
      }
    } catch (e) {
      console.log(`ERR ${e instanceof Error ? e.message : String(e)}`);
    }
  })();
});
