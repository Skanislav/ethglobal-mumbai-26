// Session sharing in the URL itself. Rune-free and dependency-free so `bun test`
// runs it directly, and so a link can be produced on any device.
//
// Why not EIP-4844 blobs: publishing a blob needs a type-3 transaction, and
// ordinary wallets refuse to build one. A wallet that "accepts" the request can
// still send it as calldata, so the publisher pays and gets a link to a blob that
// was never published. Carrying the session in the link removes the wallet, the
// indexer and the fee from the path entirely — it works offline, and the reader
// needs no chain access to open it.
//
// Why not a Patricia trie: an MPT is a key→value structure whose nodes add one
// path element per nibble, so serialising this payload that way is several times
// *larger* than the payload itself (measured: a 3.2 KB lower bound for a small
// vault versus 947 bytes for plain base64url of the same session). A link needs
// the smallest encoding, and integrity here comes from validating the decoded
// session, not from trie structure.
//
// Wire format, all inside the fragment so no browser ever sends it to a server:
//
//   #/invite/<payload>
//
// `payload` = base64url( version byte 0x01 || deflate-raw(compact JSON) )

import { getAddress, isAddress } from 'viem';
import { deflateRaw, inflateRaw } from './deflate';
import { decodeSession, encodeSession, newSession } from './session';
import type { Session } from './session';
import type { SignerRecord } from './signer-types';

const VERSION = 0x01;
/**
 * A link past this length gets truncated. No RFC sets a URI limit — RFC 9110 has
 * none, and RFC 2616 §3.2.1 only cautions above 255 bytes — but the old 2048
 * figure (IE's 2083, Apache's request-line advice) is still what chat clients,
 * mail clients and link previews behave like. This payload lives in the fragment,
 * which a browser never sends, so no request-line limit applies; 2048 is used
 * because it is the smaller of the two constraints and costs nothing.
 */
export const MAX_SHARE_URL_LENGTH = 2048;
/**
 * Names are the only free text a member controls; bound what one link carries.
 * This is a sanity cap, not the size cap: the length limit below binds first, at
 * ~57 joined owners, so a vault between the two gets `ShareTooLarge` with the real
 * reason rather than a confusing "too many entries".
 */
const MAX_MEMBERS = 128;
const MAX_NAME = 40;

export class ShareFormatError extends Error {
  constructor(detail: string) {
    super(`ShareFormatError: ${detail}`);
    this.name = 'ShareFormatError';
  }
}

export class ShareTooLarge extends Error {
  constructor(length: number) {
    super(
      `ShareTooLarge: the link would be ${length} characters, over ${MAX_SHARE_URL_LENGTH}. Every joined owner adds ~33 characters, so remove a few members and share again.`,
    );
    this.name = 'ShareTooLarge';
  }
}

/**
 * What travels. Short keys because every byte is URL: names, joined owners,
 * threshold, and the fields needed to continue the same vault rather than
 * starting a different one.
 */
type CompactSession = {
  /** Planned members who have not joined yet, by name. */
  m: string[];
  /** Joined owners as [address, label]. */
  o: [string, string][];
  t: number;
  /** Vault name. */
  n?: string;
  /** A Safe this session already points at. */
  a?: string;
  d?: boolean;
  /** Salt nonce, so the invitee predicts the same Safe address the inviter saw. */
  s?: string;
};

function toCompact(session: Session): CompactSession {
  // Ledger/Trezor/HaLo records describe a device the *sender* holds; shipping the
  // derivation path to someone else would claim a key they do not have. A joined
  // owner therefore travels as an address, and `canSign: false` on arrival says so.
  const joined = session.signers.map((s) => [s.address, s.label] as [string, string]);
  const joinedLabels = new Set(joined.map(([, label]) => label));
  const pending = (session.plannedMembers ?? []).map((m) => m.name).filter((name) => !joinedLabels.has(name));
  return {
    m: pending,
    o: joined,
    t: session.threshold,
    ...(session.vaultName ? { n: session.vaultName } : {}),
    ...(session.safeAddress ? { a: session.safeAddress } : {}),
    ...(session.deployed ? { d: true } : {}),
    ...(session.saltNonce ? { s: session.saltNonce } : {}),
  };
}

function fromCompact(compact: CompactSession): Session {
  const signers: SignerRecord[] = compact.o.map(([address, label]) => ({
    kind: 'injected',
    address: getAddress(address),
    label,
    // An address that arrived in a link came without a key, so it cannot sign
    // here. Connecting the matching wallet upgrades the same record in place.
    canSign: false,
  }));
  const plannedMembers = compact.m.map((name) => ({ name }));
  const threshold = Math.min(Math.max(compact.t, 1), Math.max(signers.length, 1));
  const base = newSession(compact.a ? 'existing' : 'create');
  return {
    ...base,
    signers,
    threshold,
    ...(plannedMembers.length > 0 ? { plannedMembers } : {}),
    ...(compact.n ? { vaultName: compact.n } : {}),
    ...(compact.a ? { safeAddress: getAddress(compact.a) } : {}),
    ...(compact.d ? { deployed: true } : {}),
    ...(compact.s ? { saltNonce: compact.s } : {}),
  };
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  // A truncated link leaves a length that is 1 mod 4, which `atob` rejects with a
  // bare DOMException. Padding cannot fix that, so say so in this codebase's terms.
  if (b64.length % 4 === 1) throw new ShareFormatError('the payload is truncated');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Encodes the session into the fragment payload. Deterministic: the same session
 * always yields the same link, so re-sharing without changes does not churn.
 */
export async function encodeSharePayload(session: Session): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(toCompact(session)));
  const packed = await deflateRaw(json);
  const payload = new Uint8Array(packed.length + 1);
  payload[0] = VERSION;
  payload.set(packed, 1);
  return toBase64Url(payload);
}

function validateCompact(value: unknown): CompactSession {
  if (!value || typeof value !== 'object') throw new ShareFormatError('the payload is not an object');
  const raw = value as Record<string, unknown>;

  const readNames = (input: unknown, field: string): string[] => {
    const list = input ?? [];
    if (!Array.isArray(list)) throw new ShareFormatError(`${field} is not an array`);
    if (list.length > MAX_MEMBERS) throw new ShareFormatError(`${field} lists more than ${MAX_MEMBERS} entries`);
    return list.map((name, i) => {
      if (typeof name !== 'string' || !name.trim()) throw new ShareFormatError(`${field}[${i}] has no name`);
      return name.trim().slice(0, MAX_NAME);
    });
  };

  const owners = raw.o ?? [];
  if (!Array.isArray(owners)) throw new ShareFormatError('the owner list is not an array');
  if (owners.length > MAX_MEMBERS) throw new ShareFormatError(`more than ${MAX_MEMBERS} owners`);
  const o = owners.map((entry, i): [string, string] => {
    if (!Array.isArray(entry) || entry.length !== 2) throw new ShareFormatError(`owner ${i} is malformed`);
    const [address, label] = entry as [unknown, unknown];
    if (typeof address !== 'string' || !isAddress(address)) {
      throw new ShareFormatError(`owner ${i} has an invalid address`);
    }
    return [address, typeof label === 'string' ? label.slice(0, MAX_NAME) : 'Member'];
  });

  const threshold = raw.t ?? 1;
  if (typeof threshold !== 'number' || !Number.isInteger(threshold) || threshold < 1) {
    throw new ShareFormatError('the threshold is not a positive integer');
  }
  const readString = (input: unknown, field: string, max: number): string | undefined => {
    if (input === undefined) return undefined;
    if (typeof input !== 'string' || !input.trim()) throw new ShareFormatError(`${field} is not a name`);
    return input.trim().slice(0, max);
  };

  return {
    m: readNames(raw.m, 'm'),
    o,
    t: threshold,
    n: readString(raw.n, 'the vault name', MAX_NAME),
    a: raw.a === undefined ? undefined : String(raw.a),
    d: raw.d === true ? true : undefined,
    s: readString(raw.s, 'the salt nonce', 40),
  };
}

/**
 * The inverse of {@link encodeSharePayload}. The result is re-validated through
 * `decodeSession`, the same validator every stored session passes, so a link can
 * never construct a session the app could not then persist.
 */
export async function decodeSharePayload(payload: string): Promise<Session> {
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) throw new ShareFormatError('the payload is not base64url');
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(payload);
  } catch {
    throw new ShareFormatError('the payload is not valid base64url');
  }
  if (bytes.length < 2) throw new ShareFormatError('the payload is too short');
  if (bytes[0] !== VERSION) throw new ShareFormatError(`unknown payload version ${bytes[0]}`);
  let json: Uint8Array;
  try {
    json = await inflateRaw(bytes.slice(1));
  } catch {
    throw new ShareFormatError('the payload did not decompress');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(json));
  } catch {
    throw new ShareFormatError('the payload is not JSON');
  }
  return decodeSession(encodeSession(fromCompact(validateCompact(parsed))));
}

export type InviteLink = { payload: string; url: string; length: number };

/** Builds the link, refusing one longer than a chat client will keep intact. */
export async function createInviteLink(origin: string, pathname: string, session: Session): Promise<InviteLink> {
  const payload = await encodeSharePayload(session);
  return assembleInviteLink(origin, pathname, payload);
}

/**
 * The size guard on its own, so it can be exercised without first constructing a
 * vault large enough to reach it (the member cap keeps real vaults far below it).
 */
export function assembleInviteLink(origin: string, pathname: string, payload: string): InviteLink {
  const url = `${origin}${pathname}#/invite/${payload}`;
  if (url.length > MAX_SHARE_URL_LENGTH) throw new ShareTooLarge(url.length);
  return { payload, url, length: url.length };
}

/**
 * Both figures are measured against this encoder, not guessed: going from 10 to 50
 * joined owners costs 33.5 characters each, and a vault's fixed part (name, roster
 * scaffolding, the envelope) is ~124. `invite.test.ts` pins them against the real
 * encoder so they cannot drift silently.
 */
export const CHARS_PER_OWNER = 33.5;
export const FIXED_LINK_OVERHEAD = 124;

/**
 * How many joined owners a link can carry at this origin and path. Derived rather
 * than hard-coded, because the answer shifts by one owner for every ~33 characters
 * of origin+path, and this is shown in the UI.
 */
export function ownersPerLink(origin: string, pathname: string): number {
  const overhead = `${origin}${pathname}#/invite/`.length + FIXED_LINK_OVERHEAD;
  return Math.max(0, Math.floor((MAX_SHARE_URL_LENGTH - overhead) / CHARS_PER_OWNER));
}

/** Parses `#/invite/<payload>`, or null for anything else. Never throws. */
export function parseInviteLink(url: string): string | null {
  let hash: string;
  try {
    hash = new URL(url).hash;
  } catch {
    return null;
  }
  const match = /^#\/invite\/([A-Za-z0-9_-]{2,})$/.exec(hash);
  return match ? match[1] : null;
}
