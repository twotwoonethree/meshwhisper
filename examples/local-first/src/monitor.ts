// ============================================================
// local-first monitor — receives encrypted telemetry from sensors
//
//   npx tsx src/monitor.ts monitor --lan-port 19404
//
// Start this first (sensors look it up by username), then start
// any number of sensor.ts instances. Stop the relay once they're
// paired: readings keep flowing peer-to-peer over the LAN.
// ============================================================

import { MeshWhisper } from '@meshwhisper/sdk';
import { NodeStorage } from '@meshwhisper/sdk/persistence/node';

const NAMESPACE = process.env.MW_NAMESPACE ?? 'org.example.local-first';
const NODE_URL = process.env.MW_NODE_URL ?? 'ws://localhost:8080';

const username = process.argv[2] ?? 'monitor';
const lanPortIdx = process.argv.indexOf('--lan-port');
const lanTcpPort = lanPortIdx > 0 ? parseInt(process.argv[lanPortIdx + 1]!, 10) : undefined;

let relayUp = false;

await MeshWhisper.init({
  namespace: NAMESPACE,
  node: NODE_URL,
  username,
  storage: new NodeStorage(`./.meshwhisper/${username}`),
  transports: { lan: lanTcpPort ? { tcpPort: lanTcpPort } : true },
  onConnectionStatus: (s) => {
    relayUp = s === 'connected';
    console.log(relayUp ? '[monitor] relay up' : '[monitor] relay down — LAN-only mode');
  },
  onMessage: async (message) => {
    try {
      const r = JSON.parse(new TextDecoder().decode(new Uint8Array(message.payload)));
      const path = relayUp ? 'relay/lan' : 'lan only';
      console.log(`[${r.ts}] ${r.sensor}: ${r.pressureKpa} kPa, ${r.tempC} °C  (${path})`);
    } catch {
      console.log('[monitor] non-telemetry message ignored');
    }
    await MeshWhisper.markRead(message.id, message.senderId);
  },
});

console.log(`[monitor] @${username} listening — start sensors, then try stopping the relay`);
