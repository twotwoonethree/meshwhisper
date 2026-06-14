// Tracks which inbound contact requests the user has already acted on, so a
// peer isn't re-prompted on every reconnect. Accepted and declined are kept in
// SEPARATE sets: conflating them meant (a) a declined peer could never be
// un-declined, and (b) the archive sync — which pushes the "accepted" set to
// the relay — was also shipping declined peers as if accepted. Only genuinely
// accepted peers belong in the synced set.

const ACCEPTED_KEY = 'prudence:accepted-contacts';
const DECLINED_KEY = 'prudence:declined-contacts';

function loadSet(key: string): Set<string> {
  try {
    const arr = JSON.parse(localStorage.getItem(key) ?? '[]') as string[];
    return new Set(arr);
  } catch {
    return new Set();
  }
}

function saveSet(key: string, set: Set<string>): void {
  localStorage.setItem(key, JSON.stringify([...set]));
}

export function markAccepted(peerId: string): void {
  const accepted = loadSet(ACCEPTED_KEY);
  accepted.add(peerId);
  saveSet(ACCEPTED_KEY, accepted);
  // A peer the user now accepts should no longer be considered declined.
  const declined = loadSet(DECLINED_KEY);
  if (declined.delete(peerId)) saveSet(DECLINED_KEY, declined);
}

export function markDeclined(peerId: string): void {
  const declined = loadSet(DECLINED_KEY);
  declined.add(peerId);
  saveSet(DECLINED_KEY, declined);
}

/** Reverse a prior decline so the peer can request again (e.g. a "show
 *  declined" recovery affordance). */
export function undecline(peerId: string): void {
  const declined = loadSet(DECLINED_KEY);
  if (declined.delete(peerId)) saveSet(DECLINED_KEY, declined);
}

/** True if the request has already been acted on (accepted OR declined) and
 *  shouldn't re-prompt. */
export function isHandled(peerId: string): boolean {
  return loadSet(ACCEPTED_KEY).has(peerId) || loadSet(DECLINED_KEY).has(peerId);
}

export function isDeclined(peerId: string): boolean {
  return loadSet(DECLINED_KEY).has(peerId);
}

/** Accepted peers only — this is what archive sync pushes to the relay. */
export function getAll(): string[] {
  return [...loadSet(ACCEPTED_KEY)];
}

export function getDeclined(): string[] {
  return [...loadSet(DECLINED_KEY)];
}

/** Merge accepted peers pulled from the relay archive into the local set. */
export function restoreAll(peerIds: string[]): void {
  const accepted = new Set([...loadSet(ACCEPTED_KEY), ...peerIds]);
  saveSet(ACCEPTED_KEY, accepted);
}
