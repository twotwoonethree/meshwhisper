const KEY = 'prudence:contact-names';

type NamesMap = Record<string, string>;

function load(): NamesMap {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as NamesMap;
  } catch {
    return {};
  }
}

export function saveContactName(peerId: string, username: string): void {
  const map = load();
  map[peerId] = username;
  localStorage.setItem(KEY, JSON.stringify(map));
}

export function getContactName(peerId: string): string | undefined {
  return load()[peerId];
}

export function getAllContactNames(): NamesMap {
  return load();
}

export function removeContactName(peerId: string): void {
  const map = load();
  delete map[peerId];
  localStorage.setItem(KEY, JSON.stringify(map));
}
