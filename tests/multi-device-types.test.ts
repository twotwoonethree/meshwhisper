// ============================================================
// Multi-device phase A — data structure tests
//
// Phase A introduces the (accountKey, deviceKeys[]) vocabulary
// in PermissionManager and the corresponding 'contacts_v2'
// storage key. For single-device flows nothing should change
// — these tests pin that down and also verify the new APIs.
// ============================================================

import { describe, it, expect } from 'vitest';
import { PermissionManager } from '../src/permissions/index.js';
import { mergeKv } from '../src/sdk/archive.js';
import type { StorageBackend } from '../src/types.js';

// In-memory StorageBackend for the archive-merge test.
function makeStorage(seed: Record<string, string> = {}): StorageBackend {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    async get(key) { return map.get(key) ?? null; },
    async set(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); },
    async keys(prefix) {
      const out: string[] = [];
      for (const k of map.keys()) if (k.startsWith(prefix)) out.push(k);
      return out;
    },
    async clear() { map.clear(); },
  };
}

describe('PermissionManager — single-device behavior preserved', () => {
  it('addContact / getContacts behave identically to v1', () => {
    const pm = new PermissionManager('open');
    pm.addContact('peerA');
    pm.addContact('peerB');
    expect(pm.getContacts().sort()).toEqual(['peerA', 'peerB']);
    expect(pm.isContact('peerA')).toBe(true);
    expect(pm.isContact('peerC')).toBe(false);
  });

  it('addContact creates a single-device account (accountKey === deviceKey)', () => {
    const pm = new PermissionManager('open');
    pm.addContact('peerA');
    expect(pm.getAccountForDevice('peerA')).toBe('peerA');
    expect(pm.getDevicesForAccount('peerA')).toEqual(['peerA']);
    expect(pm.getAllContactAccounts()).toEqual(['peerA']);
  });

  it('loadContacts (v1 format) round-trips', () => {
    const pm = new PermissionManager('open');
    pm.loadContacts(['peerA', 'peerB', 'peerC']);
    expect(pm.getContacts().sort()).toEqual(['peerA', 'peerB', 'peerC']);
    expect(pm.getAllContactAccounts().sort()).toEqual(['peerA', 'peerB', 'peerC']);
  });

  it('removeContact wipes both device and account when single-device', () => {
    const pm = new PermissionManager('open');
    pm.addContact('peerA');
    pm.addContact('peerB');
    pm.removeContact('peerA');
    expect(pm.isContact('peerA')).toBe(false);
    expect(pm.getAccountForDevice('peerA')).toBe(null);
    expect(pm.getAllContactAccounts()).toEqual(['peerB']);
  });
});

describe('PermissionManager — multi-device additions', () => {
  it('addContactAccount records multiple devices for one account', () => {
    const pm = new PermissionManager('open');
    pm.addContactAccount('accA', ['accA', 'deviceA2', 'deviceA3']);
    expect(pm.getDevicesForAccount('accA').sort()).toEqual(['accA', 'deviceA2', 'deviceA3']);
    expect(pm.getContacts().sort()).toEqual(['accA', 'deviceA2', 'deviceA3']);
    expect(pm.getAccountForDevice('deviceA2')).toBe('accA');
    expect(pm.getAccountForDevice('deviceA3')).toBe('accA');
  });

  it('addDeviceToContact appends to an existing account', () => {
    const pm = new PermissionManager('open');
    pm.addContact('accA');
    pm.addDeviceToContact('accA', 'deviceA2');
    expect(pm.getDevicesForAccount('accA').sort()).toEqual(['accA', 'deviceA2']);
    expect(pm.getAccountForDevice('deviceA2')).toBe('accA');
  });

  it('removeDeviceFromContact removes only that device; account survives', () => {
    const pm = new PermissionManager('open');
    pm.addContactAccount('accA', ['accA', 'deviceA2']);
    pm.removeDeviceFromContact('accA', 'deviceA2');
    expect(pm.getDevicesForAccount('accA')).toEqual(['accA']);
    expect(pm.isContact('deviceA2')).toBe(false);
    expect(pm.getAllContactAccounts()).toEqual(['accA']);
  });

  it('removing the last device collapses the account', () => {
    const pm = new PermissionManager('open');
    pm.addContactAccount('accA', ['accA']);
    pm.removeDeviceFromContact('accA', 'accA');
    expect(pm.getAllContactAccounts()).toEqual([]);
    expect(pm.isContact('accA')).toBe(false);
  });

  it('removeContact(accountKey) wipes the whole account', () => {
    const pm = new PermissionManager('open');
    pm.addContactAccount('accA', ['accA', 'deviceA2', 'deviceA3']);
    pm.removeContact('accA');
    expect(pm.getAllContactAccounts()).toEqual([]);
    expect(pm.isContact('deviceA2')).toBe(false);
    expect(pm.getAccountForDevice('deviceA2')).toBe(null);
  });

  it('removeContact(deviceKey) on a non-account peerId removes just that device', () => {
    const pm = new PermissionManager('open');
    pm.addContactAccount('accA', ['accA', 'deviceA2']);
    pm.removeContact('deviceA2');
    expect(pm.getDevicesForAccount('accA')).toEqual(['accA']);
    expect(pm.isContact('deviceA2')).toBe(false);
  });
});

describe('PermissionManager — v1/v2 serialisation', () => {
  it('loadContactRecords accepts the v2 format', () => {
    const pm = new PermissionManager('open');
    pm.loadContactRecords([
      { accountKey: 'accA', deviceKeys: ['accA', 'deviceA2'] },
      { accountKey: 'accB', deviceKeys: ['accB'] },
    ]);
    expect(pm.getAllContactAccounts().sort()).toEqual(['accA', 'accB']);
    expect(pm.getDevicesForAccount('accA').sort()).toEqual(['accA', 'deviceA2']);
  });

  it('getContactRecords round-trips load → save', () => {
    const pm = new PermissionManager('open');
    pm.addContactAccount('accA', ['accA', 'deviceA2']);
    pm.addContact('accB');
    const records = pm.getContactRecords();
    const reloaded = new PermissionManager('open');
    reloaded.loadContactRecords(records);
    expect(reloaded.getAllContactAccounts().sort()).toEqual(['accA', 'accB']);
    expect(reloaded.getDevicesForAccount('accA').sort()).toEqual(['accA', 'deviceA2']);
    expect(reloaded.getDevicesForAccount('accB')).toEqual(['accB']);
  });
});

describe('Archive merge — contacts_v2', () => {
  it('unions accounts and devices across local and remote', async () => {
    const storage = makeStorage({
      contacts_v2: JSON.stringify([
        { accountKey: 'accA', deviceKeys: ['accA', 'deviceA2'] },
      ]),
    });
    const remoteKv = {
      contacts_v2: JSON.stringify([
        { accountKey: 'accA', deviceKeys: ['accA', 'deviceA3'] },
        { accountKey: 'accB', deviceKeys: ['accB'] },
      ]),
    };
    await mergeKv(remoteKv, storage);
    const merged = JSON.parse((await storage.get('contacts_v2'))!) as Array<{
      accountKey: string;
      deviceKeys: string[];
    }>;
    const byAccount = new Map(merged.map((r) => [r.accountKey, r.deviceKeys.sort()]));
    expect(byAccount.get('accA')).toEqual(['accA', 'deviceA2', 'deviceA3']);
    expect(byAccount.get('accB')).toEqual(['accB']);
  });

  it('drops tombstoned accounts from v2 merge', async () => {
    const storage = makeStorage({
      contacts_v2: JSON.stringify([
        { accountKey: 'accA', deviceKeys: ['accA'] },
      ]),
      tombstones: JSON.stringify({ accB: 1000 }),
    });
    const remoteKv = {
      contacts_v2: JSON.stringify([
        { accountKey: 'accA', deviceKeys: ['accA'] },
        { accountKey: 'accB', deviceKeys: ['accB', 'deviceB2'] },
      ]),
    };
    await mergeKv(remoteKv, storage);
    const merged = JSON.parse((await storage.get('contacts_v2'))!) as Array<{
      accountKey: string;
    }>;
    expect(merged.map((r) => r.accountKey)).toEqual(['accA']);
  });

  it('v1 contacts and v2 contacts_v2 merge independently (cross-version coexistence)', async () => {
    const storage = makeStorage({
      contacts: JSON.stringify(['accA']),
    });
    const remoteKv = {
      contacts_v2: JSON.stringify([
        { accountKey: 'accA', deviceKeys: ['accA', 'deviceA2'] },
        { accountKey: 'accB', deviceKeys: ['accB'] },
      ]),
    };
    await mergeKv(remoteKv, storage);
    // v1 wasn't sent, so it stays as-is.
    expect(JSON.parse((await storage.get('contacts'))!)).toEqual(['accA']);
    // v2 from remote is dropped into storage by the no-existing-local branch.
    const v2 = JSON.parse((await storage.get('contacts_v2'))!) as Array<{
      accountKey: string;
    }>;
    expect(v2.map((r) => r.accountKey).sort()).toEqual(['accA', 'accB']);
  });
});
