// Pure session logic: no runes, no DOM. `bun test` runs this directly.
// This module is the only trust boundary for pasted/exported session blobs.

import { getAddress, isAddress } from 'viem';
import type { SignerRecord } from './signer-types';
import { ephemeralKeyFor } from './ephemeral';

export type SessionMode = 'create' | 'existing';

/**
 * The exact SafeTx being signed, stored field for field. Both the digest and the
 * `execTransaction` calldata are derived from these fields, so a rebuild can
 * never drift from what the owners signed — and a MultiSend batch survives a
 * reload intact.
 */
export type PendingTx = {
  to: `0x${string}`;
  value: string;
  data: `0x${string}`;
  operation: number;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: `0x${string}`;
  refundReceiver: `0x${string}`;
  nonce: number;
  safeTxHash: `0x${string}`;
  /** lowercase owner address → signature blob */
  signatures: Record<string, PendingSignature>;
};

export type PendingSignature = { blob: string; isContract: boolean };

/**
 * A roster slot for someone who has been invited but has not produced an owner
 * address yet. `address` is set only when the slot is linked to a real signer, so
 * "joined" is a fact about ownership, never about a typed name.
 */
export type PlannedMember = { name: string; address?: `0x${string}` };

/** One line of the roster the screens render. */
export type MemberRow = {
  name: string;
  joined: boolean;
  /** Present for signers, and for planned slots once linked. */
  address?: `0x${string}`;
  /** Signer kind, when this row is backed by a signer record. */
  kind?: SignerRecord['kind'];
  /** True only for a slot nobody has signed up for yet. */
  planned: boolean;
};

export type Session = {
  version: 1;
  chainId: 11155111;
  createdAt: string;
  mode: SessionMode;
  safeAddress?: `0x${string}`;
  saltNonce?: string;
  signers: SignerRecord[];
  threshold: number;
  pending?: PendingTx;
  deployed?: boolean;
  executedTxHashes: `0x${string}`[];
  /** User-facing vault name, e.g. "The Novaks". Never affects deployment. */
  vaultName?: string;
  /** Invited family members, address-less until they join with their own key. */
  plannedMembers?: PlannedMember[];
};

export class InvalidSession extends Error {
  constructor(field: string, detail?: string) {
    super(`InvalidSession: ${field}${detail ? ` (${detail})` : ''}`);
    this.name = 'InvalidSession';
  }
}

export class DuplicateOwner extends Error {
  constructor(address: string) {
    super(`DuplicateOwner: ${address}`);
    this.name = 'DuplicateOwner';
  }
}

export function newSession(mode: SessionMode): Session {
  return {
    version: 1,
    chainId: 11155111,
    createdAt: new Date().toISOString(),
    mode,
    signers: [],
    threshold: 1,
    executedTxHashes: [],
  };
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Adds an owner. Importing a Safe records its owners as address-only; connecting
 * the wallet that owns one of those addresses upgrades the same record in place
 * instead of failing as a duplicate.
 */
export function addSigner(session: Session, record: SignerRecord): Session {
  const existingIndex = session.signers.findIndex((s) => sameAddress(s.address, record.address));
  if (existingIndex === -1) {
    return { ...session, signers: [...session.signers, record] };
  }
  const existing = session.signers[existingIndex];
  if (!existing.canSign && record.canSign) {
    const signers = [...session.signers];
    signers[existingIndex] = { ...record, address: existing.address };
    return { ...session, signers };
  }
  throw new DuplicateOwner(record.address);
}

export function removeSigner(session: Session, address: `0x${string}`): Session {
  const signers = session.signers.filter((s) => !sameAddress(s.address, address));
  const threshold = Math.min(session.threshold, Math.max(signers.length, 1));
  return { ...session, signers, threshold };
}

export class EmptyLabel extends Error {
  constructor() {
    super('EmptyLabel: an owner label cannot be blank');
    this.name = 'EmptyLabel';
  }
}

export class UnknownOwner extends Error {
  constructor(address: string) {
    super(`UnknownOwner: ${address} is not in this session's signer set`);
    this.name = 'UnknownOwner';
  }
}

/** Labels are user-facing names only; they never affect ownership or signing. */
export function renameSigner(session: Session, address: `0x${string}`, label: string): Session {
  const trimmed = label.trim();
  if (!trimmed) throw new EmptyLabel();
  const index = session.signers.findIndex((s) => sameAddress(s.address, address));
  if (index === -1) throw new UnknownOwner(address);
  const signers = [...session.signers];
  signers[index] = { ...signers[index], label: trimmed.slice(0, 64) };
  return { ...session, signers };
}

export class InvalidVaultName extends Error {
  constructor(detail: string) {
    super(`InvalidVaultName: ${detail}`);
    this.name = 'InvalidVaultName';
  }
}

const VAULT_NAME_MAX = 40;

/** The vault name is display text only: it is trimmed, bounded, and never signed. */
export function setVaultName(session: Session, name: string): Session {
  const trimmed = name.trim();
  if (trimmed.length > VAULT_NAME_MAX) {
    throw new InvalidVaultName(`over ${VAULT_NAME_MAX} chars`);
  }
  return { ...session, vaultName: trimmed || undefined };
}

/** Invites someone by name. Two slots may share a name: names are labels, not keys. */
export function addPlannedMember(session: Session, name: string): Session {
  const trimmed = name.trim().slice(0, 64);
  if (!trimmed) throw new EmptyLabel();
  return { ...session, plannedMembers: [...(session.plannedMembers ?? []), { name: trimmed }] };
}

export function removePlannedMember(session: Session, name: string): Session {
  const plannedMembers = (session.plannedMembers ?? []).filter((m) => m.name !== name);
  return { ...session, plannedMembers: plannedMembers.length > 0 ? plannedMembers : undefined };
}

/** Links an invited slot to the owner address that joined with it. */
export function linkPlannedMember(
  session: Session,
  name: string,
  address: `0x${string}`,
): Session {
  const plannedMembers = session.plannedMembers ?? [];
  if (!plannedMembers.some((m) => m.name === name)) throw new UnknownOwner(name);
  return {
    ...session,
    plannedMembers: plannedMembers.map((m) => (m.name === name ? { ...m, address: getAddress(address) } : m)),
  };
}

/**
 * The roster the screens render: one row per owner (joined), then one per invited
 * slot that no owner has filled yet. "Joined" is a fact about ownership — the
 * address must be an owner in this session — never about a typed name.
 */
export function memberJoinState(session: Session): MemberRow[] {
  const planned = session.plannedMembers ?? [];
  const rows: MemberRow[] = session.signers.map((signer) => {
    const slot = planned.find((m) => m.address && sameAddress(m.address, signer.address));
    return {
      name: slot?.name ?? signer.label,
      joined: true,
      address: signer.address,
      kind: signer.kind,
      planned: false,
    };
  });
  const owners = new Set(session.signers.map((s) => (s.address as string).toLowerCase()));
  for (const slot of planned) {
    if (slot.address && owners.has(slot.address.toLowerCase())) continue;
    rows.push({ name: slot.name, joined: false, address: slot.address, planned: true });
  }
  return rows;
}

export function setThreshold(session: Session, n: number): Session {
  const max = Math.max(session.signers.length, 1);
  const threshold = Math.min(Math.max(Math.trunc(Number.isFinite(n) ? n : 1), 1), max);
  return { ...session, threshold };
}

/** base64url(JSON). Never writes key material — `canSign` is derived state only. */
export function encodeSession(session: Session): string {
  const bytes = new TextEncoder().encode(JSON.stringify(session));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const SIGNER_KIND: Record<string, true> = {
  injected: true,
  ephemeral: true,
  passkey: true,
  halo: true,
  ledger: true,
  trezor: true,
};

function validateSigner(value: unknown, index: number): SignerRecord {
  if (!value || typeof value !== 'object') throw new InvalidSession(`signers[${index}]`);
  const r = value as Record<string, unknown>;
  if (typeof r.address !== 'string' || !isAddress(r.address)) {
    throw new InvalidSession(`signers[${index}].address`, String(r.address));
  }
  if (typeof r.kind !== 'string' || SIGNER_KIND[r.kind] !== true) {
    throw new InvalidSession(`signers[${index}].kind`, String(r.kind));
  }
  if (typeof r.label !== 'string') throw new InvalidSession(`signers[${index}].label`);
  if (typeof r.canSign !== 'boolean') throw new InvalidSession(`signers[${index}].canSign`);
  // Casing is normalized so downstream comparisons and Safe owner matching never
  // depend on how the blob was produced.
  const base = { address: getAddress(r.address), label: r.label, canSign: r.canSign };
  switch (r.kind) {
    case 'passkey': {
      if (typeof r.rawId !== 'string' || !r.rawId.startsWith('0x')) {
        throw new InvalidSession(`signers[${index}].rawId`);
      }
      if (typeof r.origin !== 'string') throw new InvalidSession(`signers[${index}].origin`);
      const coordinates = r.coordinates;
      if (!coordinates || typeof coordinates !== 'object') {
        throw new InvalidSession(`signers[${index}].coordinates`);
      }
      const c = coordinates as Record<string, unknown>;
      if (typeof c.x !== 'string' || typeof c.y !== 'string') {
        throw new InvalidSession(`signers[${index}].coordinates`);
      }
      return {
        ...base,
        kind: 'passkey',
        rawId: r.rawId as `0x${string}`,
        coordinates: { x: c.x as `0x${string}`, y: c.y as `0x${string}` },
        origin: r.origin,
      };
    }
    case 'ledger':
    case 'trezor':
      if (typeof r.path !== 'string') throw new InvalidSession(`signers[${index}].path`);
      return { ...base, kind: r.kind, path: r.path };
    case 'halo':
      if (r.publicKey !== undefined && typeof r.publicKey !== 'string') {
        throw new InvalidSession(`signers[${index}].publicKey`);
      }
      return { ...base, kind: 'halo', publicKey: r.publicKey as `0x${string}` | undefined };
    default:
      return { ...base, kind: r.kind as 'injected' | 'ephemeral' };
  }
}

function validatePlannedMembers(value: unknown): PlannedMember[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new InvalidSession('plannedMembers');
  if (value.length === 0) return undefined;
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new InvalidSession(`plannedMembers[${index}]`);
    const m = entry as Record<string, unknown>;
    if (typeof m.name !== 'string' || !m.name.trim()) {
      throw new InvalidSession(`plannedMembers[${index}].name`, String(m.name));
    }
    const address =
      m.address === undefined ? undefined : requireAddress(m.address, `plannedMembers[${index}].address`);
    return { name: m.name, address };
  });
}

function requireQuantity(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new InvalidSession(field, String(value));
  return value;
}

function requireAddress(value: unknown, field: string): `0x${string}` {
  if (typeof value !== 'string' || !isAddress(value)) throw new InvalidSession(field, String(value));
  return getAddress(value);
}

function validatePending(value: unknown): PendingTx | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') throw new InvalidSession('pending');
  const p = value as Record<string, unknown>;
  if (typeof p.operation !== 'number' || ![0, 1].includes(p.operation)) {
    throw new InvalidSession('pending.operation', String(p.operation));
  }
  if (typeof p.nonce !== 'number' || !Number.isInteger(p.nonce) || p.nonce < 0) {
    throw new InvalidSession('pending.nonce', String(p.nonce));
  }
  if (typeof p.safeTxHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(p.safeTxHash)) {
    throw new InvalidSession('pending.safeTxHash');
  }
  const rawSignatures = (p.signatures ?? {}) as Record<string, unknown>;
  const signatures: Record<string, PendingSignature> = {};
  for (const [owner, entry] of Object.entries(rawSignatures)) {
    if (!isAddress(owner)) throw new InvalidSession('pending.signatures', owner);
    if (!entry || typeof entry !== 'object') throw new InvalidSession('pending.signatures', owner);
    const sig = entry as Record<string, unknown>;
    if (typeof sig.blob !== 'string' || !sig.blob.startsWith('0x')) {
      throw new InvalidSession('pending.signatures', owner);
    }
    if (typeof sig.isContract !== 'boolean') throw new InvalidSession('pending.signatures', owner);
    signatures[owner.toLowerCase()] = { blob: sig.blob, isContract: sig.isContract };
  }
  return {
    to: requireAddress(p.to, 'pending.to'),
    value: requireQuantity(p.value, 'pending.value'),
    data: (typeof p.data === 'string' && p.data.startsWith('0x') ? p.data : '0x') as `0x${string}`,
    operation: p.operation,
    safeTxGas: requireQuantity(p.safeTxGas, 'pending.safeTxGas'),
    baseGas: requireQuantity(p.baseGas, 'pending.baseGas'),
    gasPrice: requireQuantity(p.gasPrice, 'pending.gasPrice'),
    gasToken: requireAddress(p.gasToken, 'pending.gasToken'),
    refundReceiver: requireAddress(p.refundReceiver, 'pending.refundReceiver'),
    nonce: p.nonce,
    safeTxHash: p.safeTxHash as `0x${string}`,
    signatures,
  };
}

export function decodeSession(blob: string): Session {
  const trimmed = blob.trim();
  if (!trimmed) throw new InvalidSession('empty');
  let parsed: unknown;
  try {
    const b64 = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new InvalidSession('encoding', 'not base64url-encoded JSON');
  }
  if (!parsed || typeof parsed !== 'object') throw new InvalidSession('root');
  const raw = parsed as Record<string, unknown>;

  if (raw.version !== 1) throw new InvalidSession('version', String(raw.version));
  if (raw.chainId !== 11155111) throw new InvalidSession('chainId', String(raw.chainId));
  if (raw.mode !== 'create' && raw.mode !== 'existing') throw new InvalidSession('mode', String(raw.mode));
  if (typeof raw.createdAt !== 'string') throw new InvalidSession('createdAt');
  if (!Array.isArray(raw.signers)) throw new InvalidSession('signers');

  const signers = raw.signers.map((s, i) => validateSigner(s, i));
  const seen = new Set<string>();
  for (const s of signers) {
    const key = s.address.toLowerCase();
    if (seen.has(key)) throw new InvalidSession('signers', `duplicate owner ${s.address}`);
    seen.add(key);
  }

  if (typeof raw.threshold !== 'number' || !Number.isInteger(raw.threshold)) {
    throw new InvalidSession('threshold', String(raw.threshold));
  }
  // An empty roster is a legal pre-signer state, so the bound is `max(1, owners)`.
  const maxThreshold = Math.max(signers.length, 1);
  if (raw.threshold < 1 || raw.threshold > maxThreshold) {
    throw new InvalidSession('threshold', `${raw.threshold} outside 1..${maxThreshold}`);
  }
  if (raw.safeAddress !== undefined) requireAddress(raw.safeAddress, 'safeAddress');
  if (raw.saltNonce !== undefined && typeof raw.saltNonce !== 'string') {
    throw new InvalidSession('saltNonce');
  }
  if (raw.deployed !== undefined && typeof raw.deployed !== 'boolean') {
    throw new InvalidSession('deployed');
  }
  const executedTxHashes = raw.executedTxHashes ?? [];
  if (!Array.isArray(executedTxHashes) || executedTxHashes.some((h) => typeof h !== 'string')) {
    throw new InvalidSession('executedTxHashes');
  }
  if (raw.vaultName !== undefined) {
    const name = raw.vaultName;
    if (typeof name !== 'string') throw new InvalidSession('vaultName', String(name));
    if (name.length > VAULT_NAME_MAX) throw new InvalidSession('vaultName', `over ${VAULT_NAME_MAX} chars`);
  }
  const plannedMembers = validatePlannedMembers(raw.plannedMembers);

  return {
    version: 1,
    chainId: 11155111,
    createdAt: raw.createdAt,
    mode: raw.mode,
    signers,
    threshold: raw.threshold,
    safeAddress: raw.safeAddress ? getAddress(raw.safeAddress as string) : undefined,
    saltNonce: raw.saltNonce as string | undefined,
    pending: validatePending(raw.pending),
    deployed: raw.deployed as boolean | undefined,
    executedTxHashes: executedTxHashes as `0x${string}`[],
    vaultName: raw.vaultName as string | undefined,
    plannedMembers,
  };
}

/** On load, an ephemeral owner without its tab key cannot sign: keep the address, drop the claim. */
export function normalizeSignerAvailability(session: Session): Session {
  const signers = session.signers.map((s) =>
    s.kind === 'ephemeral' && !ephemeralKeyFor(s.address) ? { ...s, canSign: false } : s,
  );
  const changed = signers.some((s, i) => s.canSign !== session.signers[i].canSign);
  return changed ? { ...session, signers } : session;
}
