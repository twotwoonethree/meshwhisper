import { idbStorage } from './storage.ts';

const KEY = 'prudence:groups';

export interface StoredGroup {
  id: string;
  name: string;
  creatorId: string;
  members: { peerId: string; username?: string; role: 'admin' | 'member' }[];
  senderKeys: Record<string, number[]>;
  createdAt: number;
}

export async function loadGroups(): Promise<StoredGroup[]> {
  const raw = await idbStorage.get(KEY);
  if (!raw) return [];
  try { return JSON.parse(raw) as StoredGroup[]; }
  catch { return []; }
}

export async function upsertGroup(group: StoredGroup): Promise<void> {
  const groups = await loadGroups();
  const idx = groups.findIndex((g) => g.id === group.id);
  if (idx >= 0) groups[idx] = group; else groups.push(group);
  await idbStorage.set(KEY, JSON.stringify(groups));
}

export async function removeStoredGroup(groupId: string): Promise<void> {
  const groups = await loadGroups();
  await idbStorage.set(KEY, JSON.stringify(groups.filter((g) => g.id !== groupId)));
}
