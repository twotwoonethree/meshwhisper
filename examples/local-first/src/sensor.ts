// ============================================================
// local-first sensor — machine-to-machine on-site comms
//
// A machine peer that emits encrypted telemetry every few seconds.
// Pair it with monitor.ts. After the first pairing, the readings
// flow peer-to-peer over the LAN — stop the relay and watch them
// keep arriving. The same shape works for robots, PLCs, kiosks,
// or agents on an isolated shop-floor network.
//
//   npx tsx src/sensor.ts pump-7 @monitor --lan-port 19403
// ============================================================

import { MeshWhisper } from '@meshwhisper/sdk';
import { NodeStorage } from '@meshwhisper/sdk/persistence/node';

const NAMESPACE = process.env.MW_NAMESPACE ?? 'org.example.local-first';
const NODE_URL = process.env.MW_NODE_URL ?? 'ws://localhost:8080';
const INTERVAL_MS = 3_000;

const [, , sensorName, monitorHandle] = process.argv;
if (!sensorName || !monitorHandle) {
  console.error('usage: npx tsx src/sensor.ts <sensor-name> <@monitor-username> [--lan-port <tcpPort>]');
  process.exit(1);
}
const lanPortIdx = process.argv.indexOf('--lan-port');
const lanTcpPort = lanPortIdx > 0 ? parseInt(process.argv[lanPortIdx + 1]!, 10) : undefined;

const mw = await MeshWhisper.init({
  namespace: NAMESPACE,
  node: NODE_URL,
  username: sensorName,
  storage: new NodeStorage(`./.meshwhisper/${sensorName}`),
  transports: { lan: lanTcpPort ? { tcpPort: lanTcpPort } : true },
  onConnectionStatus: (s) => console.log(`[${sensorName}] relay ${s} — telemetry continues either way`),
});

console.log(`[${sensorName}] up (${mw.getLocalPeerId().slice(0, 12)}…), pairing with ${monitorHandle}`);

// First contact needs the relay directory; retry until the monitor registers.
let monitorId: string | null = null;
while (!monitorId) {
  monitorId = await MeshWhisper.addContactByKey(monitorHandle).catch(() => null);
  if (!monitorId) await new Promise((r) => setTimeout(r, 2_000));
}
console.log(`[${sensorName}] paired → ${monitorId.slice(0, 12)}… — emitting every ${INTERVAL_MS / 1000}s`);

setInterval(() => {
  const reading = {
    sensor: sensorName,
    ts: new Date().toISOString(),
    pressureKpa: Math.round((480 + Math.random() * 40) * 10) / 10,
    tempC: Math.round((61 + Math.random() * 6) * 10) / 10,
  };
  MeshWhisper.send(monitorId!, new TextEncoder().encode(JSON.stringify(reading))).catch(() => {
    // Relay unreachable — the LAN copy is already on its way.
  });
}, INTERVAL_MS);
