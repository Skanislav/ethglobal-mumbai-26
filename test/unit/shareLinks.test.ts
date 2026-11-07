import { beforeEach, describe, expect, it } from 'bun:test';
import {
  SHARE_LINKS_KEY,
  SHARE_LINKS_LIMIT,
  forgetAllShares,
  forgetShare,
  listShares,
  saveShare,
} from '../../src/lib/shareLinks';
import type { StoredShare } from '../../src/lib/shareLinks';

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

function installStorage(storage: Storage = new MemoryStorage()): void {
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
}

function share(nonce: number): StoredShare {
  return {
    url: `http://localhost/#/share/${'A'.repeat(43)}/0x${nonce.toString(16).padStart(64, '0')}`,
    versionedHash: `0x${nonce.toString(16).padStart(64, '0')}`,
    createdAt: new Date(1_700_000_000_000 + nonce).toISOString(),
    signerCount: 2,
    threshold: 2,
  };
}

beforeEach(() => {
  installStorage();
});

describe('share link store', () => {
  it('keeps a published link and lists it newest first', () => {
    saveShare(share(1));
    const list = saveShare(share(2));
    expect(list).toHaveLength(2);
    expect(list[0].versionedHash).toBe(share(2).versionedHash);
    expect(listShares()).toEqual(list);
    // The whole link, fragment included, survives: without the key it is useless.
    expect(listShares()[0].url).toContain('#/share/');
  });

  it('moves a re-saved link to the front instead of duplicating it', () => {
    saveShare(share(1));
    saveShare(share(2));
    const list = saveShare(share(1));
    expect(list).toHaveLength(2);
    expect(list[0].versionedHash).toBe(share(1).versionedHash);
  });

  it('is case-insensitive about the versioned hash', () => {
    const entry = share(1);
    saveShare(entry);
    const upper = { ...entry, versionedHash: entry.versionedHash.toUpperCase().replace('0X', '0x') as `0x${string}` };
    expect(saveShare(upper)).toHaveLength(1);
  });

  it('drops one link on request and all of them on the explicit clear', () => {
    saveShare(share(1));
    saveShare(share(2));
    expect(forgetShare(share(1).versionedHash)).toHaveLength(1);
    expect(listShares()).toHaveLength(1);
    forgetAllShares();
    expect(listShares()).toEqual([]);
  });

  it('caps the history so the store cannot grow without bound', () => {
    for (let i = 0; i < SHARE_LINKS_LIMIT + 5; i += 1) saveShare(share(i + 1));
    expect(listShares()).toHaveLength(SHARE_LINKS_LIMIT);
    // The newest survive; the oldest are the ones evicted.
    expect(listShares()[0].versionedHash).toBe(share(SHARE_LINKS_LIMIT + 5).versionedHash);
  });

  it('ignores a corrupt store and malformed entries instead of throwing', () => {
    localStorage.setItem(SHARE_LINKS_KEY, 'not json');
    expect(listShares()).toEqual([]);

    localStorage.setItem(
      SHARE_LINKS_KEY,
      JSON.stringify([share(1), { url: 'x' }, null, 7, { ...share(2), versionedHash: 'nope' }]),
    );
    expect(listShares()).toHaveLength(1);
    expect(listShares()[0].versionedHash).toBe(share(1).versionedHash);
  });

  it('degrades to "no memory" when storage is blocked', () => {
    const blocked = new MemoryStorage();
    blocked.getItem = () => {
      throw new Error('blocked');
    };
    blocked.setItem = () => {
      throw new Error('blocked');
    };
    installStorage(blocked);
    // Sharing still succeeds; only the remembering fails.
    expect(saveShare(share(1))).toEqual([]);
    expect(listShares()).toEqual([]);
    expect(() => forgetAllShares()).not.toThrow();
  });
});
