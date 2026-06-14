// Tracks which contacts the user has verified by comparing safety numbers
// out-of-band. The SDK computes/validates the number (getSafetyNumber /
// verifySafetyNumber) but does not persist a "verified" decision — that's an
// app-level trust UI concern, so Prudence stores it locally per peerId.

const KEY = 'prudence:verified-contacts';

function load(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function save(set: Set<string>): void {
  localStorage.setItem(KEY, JSON.stringify([...set]));
}

export function isVerified(peerId: string): boolean {
  return load().has(peerId);
}

export function markVerified(peerId: string): void {
  const set = load();
  set.add(peerId);
  save(set);
}

export function unverify(peerId: string): void {
  const set = load();
  if (set.delete(peerId)) save(set);
}
