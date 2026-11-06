// What survives a reload. These are the guarantees the wizard depends on: the
// session blob, the step, and the demo key all have to come back — and the key must
// still be excluded from the exported blob.

import { beforeEach, describe, expect, it } from 'bun:test';
import { decodeSession, encodeSession, newSession, renameSigner, EmptyLabel, UnknownOwner } from '../../src/lib/session';
import type { SignerRecord } from '../../src/lib/signer-types';
import {
  EPHEMERAL_KEY_PREFIX,
  ephemeralKeyFor,
  forgetAllEphemeralKeys,
  forgetEphemeralKey,
  hasStoredEphemeralKey,
  storeEphemeralKey,
} from '../../src/lib/ephemeral';

/** Minimal Storage stand-in: bun test has no DOM. */
class MemoryStorage implements Storage {
  #map = new Map<string, string>();
  get length(): number {
    return this.#map.size;
  }
  clear(): void {
    this.#map.clear();
  }
  getItem(key: string): string | null {
    return this.#map.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.#map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.#map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.#map.set(key, value);
  }
}

const OWNER = '0x1111111111111111111111111111111111111111' as const;
const KEY = `0x${'ab'.repeat(32)}` as const;

function installStorage(): void {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { value: local, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: session, configurable: true, writable: true });
}

beforeEach(() => {
  installStorage();
});

describe('demo key persistence', () => {
  it('round-trips a key through localStorage', () => {
    storeEphemeralKey(OWNER, KEY);
    expect(localStorage.getItem(`${EPHEMERAL_KEY_PREFIX}${OWNER.toLowerCase()}`)).toBe(KEY);
    expect(ephemeralKeyFor(OWNER)).toBe(KEY);
  });

  it('is case-insensitive on the owner address', () => {
    storeEphemeralKey(OWNER, KEY);
    const upper = OWNER.toUpperCase().replace('0X', '0x') as `0x${string}`;
    expect(ephemeralKeyFor(upper)).toBe(KEY);
  });

  it('migrates a key left in sessionStorage by an older build', () => {
    const legacyKey = `0x${'cd'.repeat(32)}`;
    sessionStorage.setItem(`${EPHEMERAL_KEY_PREFIX}${OWNER.toLowerCase()}`, legacyKey);
    expect(ephemeralKeyFor(OWNER)).toBe(legacyKey);
    // Moved, not copied: the old location no longer holds the secret.
    expect(sessionStorage.getItem(`${EPHEMERAL_KEY_PREFIX}${OWNER.toLowerCase()}`)).toBeNull();
    expect(localStorage.getItem(`${EPHEMERAL_KEY_PREFIX}${OWNER.toLowerCase()}`)).toBe(legacyKey);
  });

  it('forgets one key and all keys', () => {
    storeEphemeralKey(OWNER, KEY);
    expect(hasStoredEphemeralKey()).toBe(true);
    forgetEphemeralKey(OWNER);
    expect(ephemeralKeyFor(OWNER)).toBeNull();

    storeEphemeralKey(OWNER, KEY);
    storeEphemeralKey('0x2222222222222222222222222222222222222222', KEY);
    expect(forgetAllEphemeralKeys()).toBe(2);
    expect(hasStoredEphemeralKey()).toBe(false);
  });

  it('reports a blocked store instead of silently losing the key', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage blocked');
      },
    });
    expect(ephemeralKeyFor(OWNER)).toBeNull();
    expect(hasStoredEphemeralKey()).toBe(false);
    expect(() => storeEphemeralKey(OWNER, KEY)).toThrow(/storage is blocked/);
  });

  it('never puts the key into the exported session blob', () => {
    storeEphemeralKey(OWNER, KEY);
    const signer: SignerRecord = { kind: 'ephemeral', address: OWNER, label: 'Demo key', canSign: true };
    const blob = encodeSession({ ...newSession('create'), signers: [signer], threshold: 1 });
    const decodedJSON = JSON.stringify(decodeSession(blob));
    expect(decodedJSON).not.toContain(KEY.slice(2));
    expect(blob).not.toContain(KEY.slice(2));
  });
});

describe('renameSigner', () => {
  const signer: SignerRecord = { kind: 'injected', address: OWNER, label: 'Old name', canSign: true };

  it('renames only the label', () => {
    const next = renameSigner({ ...newSession('create'), signers: [signer], threshold: 1 }, OWNER, 'Alice');
    expect(next.signers[0].label).toBe('Alice');
    expect(next.signers[0].address).toBe(OWNER);
    expect(next.signers[0].kind).toBe('injected');
  });

  it('trims and truncates', () => {
    const session = { ...newSession('create'), signers: [signer], threshold: 1 };
    expect(renameSigner(session, OWNER, '  Bob  ').signers[0].label).toBe('Bob');
    expect(renameSigner(session, OWNER, 'x'.repeat(200)).signers[0].label).toHaveLength(64);
  });

  it('refuses a blank label rather than erasing the owner name', () => {
    const session = { ...newSession('create'), signers: [signer], threshold: 1 };
    expect(() => renameSigner(session, OWNER, '   ')).toThrow(EmptyLabel);
  });

  it('refuses an address that is not in the session', () => {
    const session = { ...newSession('create'), signers: [signer], threshold: 1 };
    expect(() => renameSigner(session, '0x3333333333333333333333333333333333333333', 'X')).toThrow(UnknownOwner);
  });
});
