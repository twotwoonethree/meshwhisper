// ============================================================
// Multi-device phase C — fan-out send resolution
//
// Phase C v1 changes `sendMessage(recipientId)` from "send to one
// peerId" to "send to every device of recipientId's account."
// The CALCULATION (resolve devices) is small; the iteration itself
// reuses the per-device send path. This file pins the resolution
// contract so future refactors can't silently break fan-out.
//
// Full bidirectional multi-device delivery is exercised by the
// existing integration tests once a multi-device pairing flow lands.
// ============================================================

import { describe, it, expect } from 'vitest';
import { PermissionManager } from '../src/permissions/index.js';

/**
 * Mirrors the resolution logic inside `MeshWhisper.sendMessage` so
 * future changes there must also be reflected here — the helper is
 * the contract a sender depends on.
 */
function resolveSendDevices(pm: PermissionManager, recipientId: string): string[] {
  const accountKey = pm.getAccountForDevice(recipientId) ?? recipientId;
  const devices = pm.getDevicesForAccount(accountKey);
  return devices.length > 0 ? devices : [recipientId];
}

describe('Phase C fan-out resolution', () => {
  it('single-device contact: resolves to [accountKey]', () => {
    const pm = new PermissionManager('open');
    pm.addContact('alice');
    expect(resolveSendDevices(pm, 'alice')).toEqual(['alice']);
  });

  it('multi-device contact: caller passes primary, fan-out covers all devices', () => {
    const pm = new PermissionManager('open');
    pm.addContactAccount('alice', ['alice', 'alice-laptop']);
    expect(resolveSendDevices(pm, 'alice').sort()).toEqual(['alice', 'alice-laptop']);
  });

  it('multi-device contact: caller passes a non-primary device, still fans out', () => {
    const pm = new PermissionManager('open');
    pm.addContactAccount('alice', ['alice', 'alice-laptop']);
    expect(resolveSendDevices(pm, 'alice-laptop').sort()).toEqual(['alice', 'alice-laptop']);
  });

  it('multi-device contact with three devices fans out to all three', () => {
    const pm = new PermissionManager('open');
    pm.addContactAccount('alice', ['alice', 'alice-laptop', 'alice-tablet']);
    expect(resolveSendDevices(pm, 'alice').sort())
      .toEqual(['alice', 'alice-laptop', 'alice-tablet']);
  });

  it('unknown peerId: falls back to [recipientId] for back-compat', () => {
    const pm = new PermissionManager('open');
    expect(resolveSendDevices(pm, 'random-peer')).toEqual(['random-peer']);
  });

  it('contact removed → fan-out collapses back to fallback', () => {
    const pm = new PermissionManager('open');
    pm.addContactAccount('alice', ['alice', 'alice-laptop']);
    pm.removeContact('alice'); // wipes the whole account in phase A semantics
    expect(resolveSendDevices(pm, 'alice')).toEqual(['alice']);
  });

  it('one device removed but account survives → fan-out to remaining devices', () => {
    const pm = new PermissionManager('open');
    pm.addContactAccount('alice', ['alice', 'alice-laptop']);
    pm.removeDeviceFromContact('alice', 'alice-laptop');
    expect(resolveSendDevices(pm, 'alice')).toEqual(['alice']);
  });

  it('device added after initial setup is picked up by next send', () => {
    const pm = new PermissionManager('open');
    pm.addContact('alice');
    expect(resolveSendDevices(pm, 'alice')).toEqual(['alice']);

    // Later: a device_added announcement arrives, adding alice's laptop
    pm.addDeviceToContact('alice', 'alice-laptop');
    expect(resolveSendDevices(pm, 'alice').sort())
      .toEqual(['alice', 'alice-laptop']);
  });
});
