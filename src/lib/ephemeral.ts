// Demo-key storage.
//
// This key is a Sepolia-only throwaway: it exists so an owner record is signable on a
// machine with no injected wallet. It is persisted in localStorage so a reload does
// not destroy the session — which also means it sits in plaintext on disk, readable by
// any script on this origin, until the user clears it. That is acceptable only because
// the key is testnet-only and holds nothing; the UI keeps a permanent TESTNET-ONLY
// badge and offers an explicit "forget" action. The key is never written into the
// exported session, into a URL, or into any server request.

export const EPHEMERAL_KEY_PREFIX = 'sso.ephemeral.';

function store(): Storage | null {
  try {
    return localStorage;
  } catch {
    // Storage is blocked (private mode, policy). Signing will report the key as absent.
    return null;
  }
}

/** Reads a demo key, migrating one left in sessionStorage by an older build. */
export function ephemeralKeyFor(address: `0x${string}`): `0x${string}` | null {
  const storage = store();
  if (!storage) return null;
  const key = `${EPHEMERAL_KEY_PREFIX}${address.toLowerCase()}`;
  const persisted = storage.getItem(key);
  if (persisted) return persisted as `0x${string}`;
  try {
    const legacy = sessionStorage.getItem(key);
    if (legacy) {
      storage.setItem(key, legacy);
      sessionStorage.removeItem(key);
      return legacy as `0x${string}`;
    }
  } catch {
    // No sessionStorage available; nothing to migrate.
  }
  return null;
}

export function storeEphemeralKey(address: `0x${string}`, privateKey: `0x${string}`): void {
  const storage = store();
  if (!storage) throw new Error('storage is blocked in this browser, so the demo key cannot be kept');
  storage.setItem(`${EPHEMERAL_KEY_PREFIX}${address.toLowerCase()}`, privateKey);
}

export function forgetEphemeralKey(address: `0x${string}`): void {
  const key = `${EPHEMERAL_KEY_PREFIX}${address.toLowerCase()}`;
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing stored where we could remove it.
  }
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Same.
  }
}

/**
 * Storage keys are read through the documented Storage API (`length` + `key(i)`), not
 * through `Object.keys`: the latter only works on the browser's exotic Storage object
 * and cannot be implemented by a test double.
 */
function ephemeralKeyNames(storage: Storage): string[] {
  const names: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const name = storage.key(i);
    if (name && name.startsWith(EPHEMERAL_KEY_PREFIX)) names.push(name);
  }
  return names;
}

/** Clears every demo key this app has ever stored. Used by the explicit "forget all". */
export function forgetAllEphemeralKeys(): number {
  const storage = store();
  if (!storage) return 0;
  try {
    const names = ephemeralKeyNames(storage);
    for (const name of names) storage.removeItem(name);
    return names.length;
  } catch {
    return 0;
  }
}

/** True when at least one demo key is persisted on this device. */
export function hasStoredEphemeralKey(): boolean {
  const storage = store();
  if (!storage) return false;
  try {
    return ephemeralKeyNames(storage).length > 0;
  } catch {
    return false;
  }
}
