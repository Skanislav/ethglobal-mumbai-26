// Session sharing over EIP-4844 blobs. Pure functions + WebCrypto: no runes, no
// viem client, so `bun test` runs this directly.
//
// Trust model: one writer, one reader, single hop. The payload is AES-GCM
// encrypted and the 32-byte key travels in the URL fragment, which a browser
// never puts on the wire. Whoever holds the link can read the session; the blob
// itself (public, permanent) stays opaque without it.

import { fromBlobs, hexToBytes, toBlobs } from 'viem';
import { decodeSession, encodeSession } from './session';
import type { Session } from './session';

/** ASCII `sso1`: lets a wrong-key or foreign blob fail before any crypto runs. */
const MAGIC = new Uint8Array([0x73, 0x73, 0x6f, 0x31]);
const IV_BYTES = 12;
const KEY_BYTES = 32;
const HEADER_BYTES = MAGIC.length + IV_BYTES;

const BLOBSCAN = 'https://api.sepolia.blobscan.com/blobs';
/** Blobscan indexes a confirmed blob a few blocks after inclusion. */
const FETCH_TIMEOUT_MS = 60_000;
const FETCH_INTERVAL_MS = 5_000;

export class ShareFormatError extends Error {
  constructor(detail: string) {
    super(`ShareFormatError: ${detail}`);
    this.name = 'ShareFormatError';
  }
}

export class WrongShareKey extends Error {
  constructor() {
    super('WrongShareKey: this link’s key does not open that blob');
    this.name = 'WrongShareKey';
  }
}

export class BlobNotIndexed extends Error {
  constructor(detail?: string) {
    super(`BlobNotIndexed: the blob is not indexed yet${detail ? ` (${detail})` : ''}`);
    this.name = 'BlobNotIndexed';
  }
}

/**
 * The indexer has never heard of this versioned hash. Distinct from
 * {@link BlobNotIndexed} because the remedy differs: waiting does not help, the
 * blob was never published to Sepolia (or the link names the wrong hash).
 */
export class BlobUnknown extends Error {
  constructor(versionedHash: string) {
    super(`BlobUnknown: no blob on Sepolia has versioned hash ${versionedHash}`);
    this.name = 'BlobUnknown';
  }
}

/** Indexed, but the indexer has no storage URL to serve the bytes from. */
export class BlobUnavailable extends Error {
  constructor(versionedHash: string) {
    super(`BlobUnavailable: the indexer knows ${versionedHash} but has no data URL for it`);
    this.name = 'BlobUnavailable';
  }
}

/** The request never reached the indexer: offline, DNS, CORS, or a blocker. */
export class BlobUnreachable extends Error {
  constructor(detail: string) {
    super(`BlobUnreachable: could not reach the blob indexer (${detail})`);
    this.name = 'BlobUnreachable';
  }
}

export type ShareBlob = {
  /** 32 random bytes, base64url — goes in the URL fragment and nowhere else. */
  keyB64: string;
  /** The full 131072-byte blob, hex — the `blobs` entry of a type-3 transaction. */
  blobHex: `0x${string}`;
};

export type ShareRef = { keyB64: string; versionedHash: `0x${string}` };

async function importKey(keyB64: string): Promise<CryptoKey> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(keyB64)) throw new ShareFormatError('the key is not 32 base64url bytes');
  const b64 = keyB64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const raw = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
  if (raw.length !== KEY_BYTES) throw new ShareFormatError('the key is not 32 bytes');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * Encrypts one session into exactly one blob. The envelope version keeps the
 * payload readable if `encodeSession`'s format ever changes.
 */
export async function packSession(session: Session): Promise<ShareBlob> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  let bin = '';
  for (const b of rawKey) bin += String.fromCharCode(b);
  const keyB64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify({ v: 1, session: encodeSession(session) }));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));

  const payload = new Uint8Array(HEADER_BYTES + ciphertext.length);
  payload.set(MAGIC, 0);
  payload.set(iv, MAGIC.length);
  payload.set(ciphertext, HEADER_BYTES);

  const blobs = toBlobs({ data: payload, to: 'hex' });
  if (blobs.length !== 1) throw new ShareFormatError(`the session needed ${blobs.length} blobs`);
  return { keyB64, blobHex: blobs[0] };
}

/**
 * The inverse of {@link packSession}, applied to the raw onchain blob: strip the
 * field-element padding, then authenticate and decrypt. Every failure mode is a
 * named error so the UI can tell "wrong link" from "not our blob at all".
 */
export async function decryptSessionBlob(blobBytes: Uint8Array, keyB64: string): Promise<Session> {
  let payload: Uint8Array;
  try {
    payload = fromBlobs({ blobs: [blobBytes], to: 'bytes' });
  } catch (err) {
    throw new ShareFormatError(err instanceof Error ? err.message : String(err));
  }
  if (payload.length < HEADER_BYTES) throw new ShareFormatError('the blob is shorter than its header');
  for (let i = 0; i < MAGIC.length; i++) {
    if (payload[i] !== MAGIC[i]) throw new ShareFormatError('not an sso session blob');
  }

  const key = await importKey(keyB64);
  const iv = payload.slice(MAGIC.length, HEADER_BYTES);
  const ciphertext = payload.slice(HEADER_BYTES);
  let plaintext: Uint8Array;
  try {
    plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext));
  } catch {
    // GCM authenticates before it decrypts: a wrong key is indistinguishable from
    // tampering, and both mean "this link does not open that blob".
    throw new WrongShareKey();
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new ShareFormatError('the decrypted payload is not JSON');
  }
  if (!envelope || typeof envelope !== 'object') throw new ShareFormatError('the decrypted payload is not an object');
  const raw = envelope as Record<string, unknown>;
  if (raw.v !== 1) throw new ShareFormatError(`unknown envelope version ${String(raw.v)}`);
  if (typeof raw.session !== 'string') throw new ShareFormatError('the envelope carries no session string');
  return decodeSession(raw.session);
}

/** `#/share/<key>/<versionedHash>`, or null for anything else. */
export function parseShareLink(url: string): ShareRef | null {
  let hash: string;
  try {
    hash = new URL(url).hash;
  } catch {
    return null;
  }
  const match = /^#\/share\/([A-Za-z0-9_-]{43})\/(0x[0-9a-fA-F]{64})$/.exec(hash);
  if (!match) return null;
  return { keyB64: match[1], versionedHash: match[2].toLowerCase() as `0x${string}` };
}

/** Builds the link the reader opens. The key stays in the fragment by construction. */
export function shareLink(origin: string, pathname: string, ref: ShareRef): string {
  return `${origin}${pathname}#/share/${ref.keyB64}/${ref.versionedHash}`;
}

/**
 * The indexer's 404 body is `{ message, code, data }`. Only `message` is read, and
 * only to tell its two 404 meanings apart, so this narrows instead of asserting.
 */
function errorMessage(body: unknown): string {
  if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string') {
    return body.message;
  }
  return '';
}

/**
 * Reads the blob back from the indexer. Polling doubles as the inclusion wait:
 * blobscan only lists a blob once it is confirmed on Sepolia.
 *
 * The endpoint answers `200 application/json` with the blob as a quoted hex
 * string (`"0x00…"`), not as raw bytes — the OpenAPI schema types it as
 * `string` matching `^0x[0-9a-fA-F]+$`. Reading `arrayBuffer()` here would hand
 * the ciphertext parser 262148 bytes of ASCII, so the body is parsed as JSON and
 * the hex decoded.
 */
export async function fetchShareBlob(versionedHash: `0x${string}`): Promise<Uint8Array> {
  const deadline = Date.now() + FETCH_TIMEOUT_MS;
  let lastError = '';
  for (;;) {
    try {
      const res = await fetch(`${BLOBSCAN}/${versionedHash}/data`);
      if (res.ok) {
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          throw new ShareFormatError('the indexer returned a body that is not JSON');
        }
        if (typeof body !== 'string' || !/^0x[0-9a-fA-F]*$/.test(body)) {
          throw new ShareFormatError('the indexer did not return a hex blob');
        }
        const bytes = hexToBytes(body as `0x${string}`);
        if (bytes.length === 0) throw new ShareFormatError('the indexer returned an empty blob');
        return bytes;
      }
      if (res.status === 404) {
        // The data endpoint answers "No blob data storage URLs found" for BOTH a
        // hash it has never seen and one it knows but cannot serve, so it cannot
        // tell them apart. The metadata endpoint can: it 404s "No blob with
        // versioned hash" only for a hash that is not on Sepolia at all. Probing
        // it once per attempt is what makes "wait" vs "the link is wrong" honest.
        const meta = await fetch(`${BLOBSCAN}/${versionedHash}`);
        if (meta.status === 404) throw new BlobUnknown(versionedHash);
        if (meta.ok) throw new BlobUnavailable(versionedHash);
        lastError = errorMessage(await res.json().catch(() => null));
      } else {
        throw new ShareFormatError(`the indexer rejected the read (HTTP ${res.status})`);
      }
    } catch (err) {
      if (
        err instanceof ShareFormatError ||
        err instanceof BlobUnknown ||
        err instanceof BlobUnavailable ||
        err instanceof BlobUnreachable
      ) {
        throw err;
      }
      // A transport failure is not "not indexed yet": a 404 is the indexer
      // answering, while `TypeError: Failed to fetch` means the request never
      // reached it (CORS, DNS, offline, a privacy extension). Retrying that for a
      // minute hides a real problem behind a spinner, so it fails immediately.
      if (err instanceof TypeError) throw new BlobUnreachable(err.message);
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() + FETCH_INTERVAL_MS > deadline) throw new BlobNotIndexed(lastError || undefined);
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, FETCH_INTERVAL_MS);
    await promise;
  }
}
