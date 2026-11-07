import { describe, expect, it } from 'bun:test';
import { fromBlobs, hexToBytes, toBlobs } from 'viem';
import {
  BlobUnavailable,
  BlobUnknown,
  ShareFormatError,
  WrongShareKey,
  decryptSessionBlob,
  fetchShareBlob,
  packSession,
  parseShareLink,
  shareLink,
} from '../../src/lib/sessionShare';
import { decodeSession, encodeSession, newSession, addSigner, setThreshold } from '../../src/lib/session';
import type { Session } from '../../src/lib/session';

const A = '0x1111111111111111111111111111111111111111' as const;
const B = '0x2222222222222222222222222222222222222222' as const;
const C = '0x3333333333333333333333333333333333333333' as const;

function shareable(): Session {
  const withSigners = [A, B].reduce(
    (acc, address) => addSigner(acc, { kind: 'injected', address, label: 'Wallet', canSign: true }),
    newSession('create'),
  );
  return {
    ...setThreshold(withSigners, 2),
    safeAddress: C,
    deployed: true,
    pending: {
      to: A,
      value: '0',
      data: '0x',
      operation: 0,
      safeTxGas: '0',
      baseGas: '0',
      gasPrice: '0',
      gasToken: '0x0000000000000000000000000000000000000000',
      refundReceiver: '0x0000000000000000000000000000000000000000',
      nonce: 3,
      safeTxHash: `0x${'ab'.repeat(32)}`,
      signatures: { [A.toLowerCase()]: { blob: `0x${'cd'.repeat(65)}`, isContract: false } },
    },
  };
}

/** `hexToBytes(blobHex)` is exactly what the indexer serves: the raw 131072-byte blob. */
function unpackBlob(blobHex: `0x${string}`, keyB64: string): Promise<Session> {
  return decryptSessionBlob(hexToBytes(blobHex), keyB64);
}

describe('session share blob', () => {
  it('round-trips a session with a pending transaction through one blob', async () => {
    const session = shareable();
    const { keyB64, blobHex } = await packSession(session);
    expect(blobHex.length).toBe(2 + 131072 * 2);
    expect(keyB64).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await unpackBlob(blobHex, keyB64)).toEqual(decodeSession(encodeSession(session)));
  });

  it('refuses a different key and a blob that is not ours', async () => {
    const { blobHex } = await packSession(shareable());
    const other = (await packSession(shareable())).keyB64;
    await expect(unpackBlob(blobHex, other)).rejects.toBeInstanceOf(WrongShareKey);

    const foreign = toBlobs({ data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]), to: 'hex' })[0];
    await expect(unpackBlob(foreign, other)).rejects.toBeInstanceOf(ShareFormatError);
  });

  it('parses only the exact share link shape', () => {
    const keyB64 = 'A'.repeat(43);
    const versionedHash = `0x01${'ab'.repeat(31)}` as `0x${string}`;
    const url = shareLink('https://example.org', '/app/', { keyB64, versionedHash });
    expect(parseShareLink(url)).toEqual({ keyB64, versionedHash });

    const rejects = [
      'https://example.org/app/',
      'https://example.org/app/#/share/',
      `https://example.org/app/#/share/${keyB64}/${versionedHash.slice(2)}`,
      `https://example.org/app/#/share/${'A'.repeat(42)}/${versionedHash}`,
      `https://example.org/app/#/share/${'A'.repeat(43)}+/${versionedHash}`,
      `https://example.org/app/#/share/${'A'.repeat(43)}/${versionedHash}00`,
      `https://example.org/app/#/import/${keyB64}/${versionedHash}`,
      'not a url',
    ];
    for (const candidate of rejects) expect(parseShareLink(candidate)).toBeNull();
  });

  it('survives viem blob packing without changing the payload', () => {
    // The 32-byte chunks viem packs are field elements: 1 zero prefix byte + 31
    // payload bytes, then a single 0x80 terminator on the last element.
    const payload = Uint8Array.from({ length: 200 }, (_, i) => (i * 37) % 251);
    const [blob] = toBlobs({ data: payload, to: 'hex' });
    expect(fromBlobs({ blobs: [blob], to: 'bytes' })).toEqual(payload);
  });

  it('decodes the indexer body, which is JSON string hex and not raw bytes', async () => {
    // blobscan answers 200 application/json with `"0x…"`. Reading that body as
    // bytes yields 262148 bytes of ASCII and every share link fails to open, so
    // this pins the wire shape rather than merely "a fetch happened".
    const original = globalThis.fetch;
    const respond = (body: string, status = 200): void => {
      globalThis.fetch = (() =>
        Promise.resolve(
          new Response(body, { status, headers: { 'content-type': 'application/json' } }),
        )) as unknown as typeof fetch;
    };

    try {
      const { blobHex } = await packSession(shareable());
      respond(JSON.stringify(blobHex));
      const bytes = await fetchShareBlob(`0x01${'ab'.repeat(31)}`);
      expect(bytes.length).toBe(131_072);
      // Each field element is a zero byte followed by 31 payload bytes, so the
      // magic starts at index 1, not 0.
      expect([...bytes.slice(1, 5)]).toEqual([0x73, 0x73, 0x6f, 0x31]);

      // A body that is not a hex string is a format error, not a silent 262148 bytes.
      respond('not a blob');
      await expect(fetchShareBlob(`0x01${'ab'.repeat(31)}`)).rejects.toBeInstanceOf(ShareFormatError);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('tells a hash that was never published apart from one whose bytes are missing', async () => {
    // The /data endpoint gives the SAME 404 for both; only the metadata endpoint
    // distinguishes them. Treating them alike makes a wrong link look like a slow
    // indexer for a full minute.
    const original = globalThis.fetch;
    const notFound = (message: string) =>
      new Response(JSON.stringify({ message, code: 'NOT_FOUND' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    const DATA_404 = notFound(
      "No blob data storage URLs found for blob with id '0x01ab'.",
    );
    const route = (metaStatus: number): void => {
      globalThis.fetch = ((input: string | URL) => {
        const url = String(input);
        // /blobs/{id}/data vs /blobs/{id}
        return Promise.resolve(url.endsWith('/data') ? DATA_404.clone() : new Response(metaStatus === 200 ? '{}' : '{}', { status: metaStatus }));
      }) as unknown as typeof fetch;
    };

    try {
      route(404);
      await expect(fetchShareBlob(`0x01${'ab'.repeat(31)}`)).rejects.toBeInstanceOf(BlobUnknown);
      route(200);
      await expect(fetchShareBlob(`0x01${'ab'.repeat(31)}`)).rejects.toBeInstanceOf(BlobUnavailable);
    } finally {
      globalThis.fetch = original;
    }
  });
});
