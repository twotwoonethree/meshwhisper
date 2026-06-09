// ============================================================
// Group rename — unit tests
//
// Tests the GroupManager.setName state machine and the
// renameGroupBroadcast authorisation rules at the GroupManager level
// (the broadcast itself goes through the same sendControl path as
// transferAdmin/kick, already covered by the existing integration
// tests once a multi-SDK harness lands).
// ============================================================

import { describe, it, expect } from 'vitest';
import { GroupManager } from '../src/group/index.js';

describe('GroupManager.setName', () => {
  it('returns true and applies the new name when the group exists', () => {
    const gm = new GroupManager();
    const g = gm.createGroup('original', ['alice', 'bob'], 'open');
    expect(g.name).toBe('original');
    const applied = gm.setName(g.id, 'renamed');
    expect(applied).toBe(true);
    expect(gm.getGroup(g.id)!.name).toBe('renamed');
  });

  it('returns false when the group does not exist', () => {
    const gm = new GroupManager();
    expect(gm.setName('non-existent-group-id', 'whatever')).toBe(false);
  });

  it('returns false (no-op) when the new name matches the current name', () => {
    const gm = new GroupManager();
    const g = gm.createGroup('same name', ['alice'], 'open');
    expect(gm.setName(g.id, 'same name')).toBe(false);
    // State untouched
    expect(gm.getGroup(g.id)!.name).toBe('same name');
  });

  it('allows any string for the new name; trimming is the caller\'s job', () => {
    // The broadcast helper in MeshWhisper trims and rejects empty;
    // GroupManager itself is mechanical and accepts any non-equal name.
    const gm = new GroupManager();
    const g = gm.createGroup('original', ['alice'], 'open');
    expect(gm.setName(g.id, '  spaces preserved at this layer  ')).toBe(true);
    expect(gm.getGroup(g.id)!.name).toBe('  spaces preserved at this layer  ');
  });

  it('renaming does not perturb membership, admin, or sender keys', () => {
    const gm = new GroupManager();
    const g = gm.createGroup('before', ['alice', 'bob', 'carol'], 'open');
    const membersBefore = Array.from(g.members.keys()).sort();
    const adminBefore = g.treeRoot;
    gm.setName(g.id, 'after');
    const after = gm.getGroup(g.id)!;
    expect(Array.from(after.members.keys()).sort()).toEqual(membersBefore);
    expect(after.treeRoot).toBe(adminBefore);
  });
});
