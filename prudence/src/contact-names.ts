const KEY = 'prudence:contact-names';

/** Username format Prudence enforces everywhere (AddContact, Onboarding, and
 *  inbound contact-request validation). Centralised so the rule can't drift. */
export function isValidUsername(name: string): boolean {
  return /^[a-z0-9_-]{3,30}$/.test(name);
}

type NamesMap = Record<string, string>;

function load(): NamesMap {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as NamesMap;
  } catch {
    return {};
  }
}

function persist(map: NamesMap): void {
  localStorage.setItem(KEY, JSON.stringify(map));
}

function findCollision(map: NamesMap, peerId: string, name: string): string | null {
  for (const [otherPeerId, otherName] of Object.entries(map)) {
    if (otherPeerId !== peerId && otherName === name) return otherPeerId;
  }
  return null;
}

export function saveContactName(peerId: string, username: string): void {
  const map = load();
  map[peerId] = username;
  persist(map);
}

/**
 * Save the display name for a contact the user is actively adding or
 * accepting. If another contact already uses the same name, prompts
 * the user to enter a different name (so the conversation list never
 * shows two identical labels). Returns the name actually saved.
 */
export function saveContactNameInteractive(peerId: string, suggested: string): string {
  const map = load();
  if (map[peerId] === suggested) return suggested;
  const collidesWith = findCollision(map, peerId, suggested);
  if (!collidesWith) {
    map[peerId] = suggested;
    persist(map);
    return suggested;
  }
  const chosen = window.prompt(
    `You already have a contact named "@${suggested}". ` +
    `Enter a different name for this new one to tell them apart, ` +
    `or press Cancel to keep both as "@${suggested}":`,
    `${suggested} (new)`,
  );
  const finalName = chosen?.trim() || suggested;
  map[peerId] = finalName;
  persist(map);
  return finalName;
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
  persist(map);
}
