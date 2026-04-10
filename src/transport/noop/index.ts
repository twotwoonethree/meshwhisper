// ============================================================
// MeshWhisper SDK — No-Op Transport
// Satisfies the Transport interface but does nothing.
// Used as a placeholder for transports that are unavailable
// in the current environment (e.g. LocalTransport in a browser).
// ============================================================

import type { Transport, Packet, BearerType } from '../../types.js';

export class NoOpTransport implements Transport {
  constructor(readonly type: BearerType) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async isAvailable(): Promise<boolean> { return false; }

  async send(_packet: Packet, _destination: string): Promise<void> {
    throw new Error(`NoOpTransport(${this.type}): not available in this environment`);
  }

  onReceive(_callback: (packet: Packet, source: string) => void): void {}
}
