const KEY = 'prudence:accepted-contacts';

function load(): Set<string> {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[];
    return new Set(arr);
  } catch {
    return new Set();
  }
}

export function markAccepted(peerId: string): void {
  const set = load();
  set.add(peerId);
  localStorage.setItem(KEY, JSON.stringify([...set]));
}

export function markDeclined(peerId: string): void {
  const set = load();
  set.add(peerId);
  localStorage.setItem(KEY, JSON.stringify([...set]));
}

export function isHandled(peerId: string): boolean {
  return load().has(peerId);
}
