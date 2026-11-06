// Share links this origin has published.
//
// A link carries the AES key in its fragment, so keeping it here puts that key in
// localStorage in plaintext. That is acceptable because the blob is encrypted
// session *metadata* only — owner addresses, labels, threshold, a pending
// transaction — and never key material; whoever reads this store could already
// read the session from the app itself. The list exists so a publisher can get a
// link back after closing the tab, and each entry can be removed on its own.
//
// Rune-free: `bun test` imports this directly.

export const SHARE_LINKS_KEY = 'sso.shares.v1';
/** Enough history to find last week's link without letting the store grow forever. */
export const SHARE_LINKS_LIMIT = 20;

export type StoredShare = {
  /** The full link, fragment included. */
  url: string;
  versionedHash: `0x${string}`;
  createdAt: string;
  signerCount: number;
  threshold: number;
};

function store(): Storage | null {
  try {
    return localStorage;
  } catch {
    // Storage is blocked (private mode, policy): sharing still works, the link
    // just is not remembered.
    return null;
  }
}

function isStoredShare(value: unknown): value is StoredShare {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.url === 'string' &&
    typeof v.versionedHash === 'string' &&
    /^0x[0-9a-fA-F]{64}$/.test(v.versionedHash) &&
    typeof v.createdAt === 'string' &&
    typeof v.signerCount === 'number' &&
    typeof v.threshold === 'number'
  );
}

/**
 * Every remembered link, newest first. Anything that does not parse is dropped
 * rather than thrown: a stale or hand-edited entry must not break the wizard.
 */
export function listShares(): StoredShare[] {
  const storage = store();
  if (!storage) return [];
  let raw: string | null = null;
  try {
    raw = storage.getItem(SHARE_LINKS_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isStoredShare);
}

function write(storage: Storage, shares: StoredShare[]): boolean {
  try {
    storage.setItem(SHARE_LINKS_KEY, JSON.stringify(shares));
    return true;
  } catch {
    // A full store costs the memory of the link, not the published blob.
    return false;
  }
}

/**
 * Remembers a published link. The same blob is never listed twice: publishing the
 * same session again is a different transaction with a different hash anyway, so a
 * repeated hash means the same link and it moves to the front.
 *
 * Returns what is actually stored, not what was attempted: when storage is blocked
 * the caller is told nothing was remembered rather than being handed a list that
 * will be gone after a reload.
 */
export function saveShare(entry: StoredShare): StoredShare[] {
  const storage = store();
  if (!storage) return [];
  const hash = entry.versionedHash.toLowerCase();
  const next = [entry, ...listShares().filter((s) => s.versionedHash.toLowerCase() !== hash)].slice(
    0,
    SHARE_LINKS_LIMIT,
  );
  return write(storage, next) ? next : listShares();
}

export function forgetShare(versionedHash: `0x${string}`): StoredShare[] {
  const storage = store();
  if (!storage) return [];
  const hash = versionedHash.toLowerCase();
  const next = listShares().filter((s) => s.versionedHash.toLowerCase() !== hash);
  write(storage, next);
  return next;
}

export function forgetAllShares(): void {
  const storage = store();
  if (!storage) return;
  try {
    storage.removeItem(SHARE_LINKS_KEY);
  } catch {
    // Nothing stored where we could remove it.
  }
}
