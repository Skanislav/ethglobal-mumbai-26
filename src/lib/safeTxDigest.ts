// The EIP-712 structure of a Safe 1.4.1 `SafeTx`. Declared once, literally, so
// viem can infer it; every signer path (demo key, Ledger, Trezor) and every
// digest assertion reads from this single definition. Parity with protocol-kit
// is proven at runtime in `safeTxHashParts` rather than assumed.

import { hashDomain, hashStruct, hashTypedData, isAddress } from 'viem';
import type { SigningContext } from './signer-types';

export const SAFE_TX_TYPES = {
  EIP712Domain: [
    { type: 'uint256', name: 'chainId' },
    { type: 'address', name: 'verifyingContract' },
  ],
  SafeTx: [
    { type: 'address', name: 'to' },
    { type: 'uint256', name: 'value' },
    { type: 'bytes', name: 'data' },
    { type: 'uint8', name: 'operation' },
    { type: 'uint256', name: 'safeTxGas' },
    { type: 'uint256', name: 'baseGas' },
    { type: 'uint256', name: 'gasPrice' },
    { type: 'address', name: 'gasToken' },
    { type: 'address', name: 'refundReceiver' },
    { type: 'uint256', name: 'nonce' },
  ],
} as const;

/** Wire shape Trezor's `ethereumSignTypedData` expects: mutable arrays of `{name, type}`. */
export type TrezorTypes = {
  EIP712Domain: { name: string; type: string }[];
  [domain: string]: { name: string; type: string }[];
};

export function trezorTypes(): TrezorTypes {
  return {
    EIP712Domain: SAFE_TX_TYPES.EIP712Domain.map((f) => ({ name: f.name, type: f.type })),
    SafeTx: SAFE_TX_TYPES.SafeTx.map((f) => ({ name: f.name, type: f.type })),
  };
}

export class SafeTxDigestMismatch extends Error {
  constructor(local: string, reported: string) {
    super(`SafeTxDigestMismatch: locally computed ${local}, protocol-kit reported ${reported}`);
    this.name = 'SafeTxDigestMismatch';
  }
}

function toQuantity(value: string, field: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new TypeError(`SafeTxFieldNotNumeric: ${field}=${JSON.stringify(value)}`);
  }
}

export type SafeTxTypedData = {
  domain: { chainId: bigint; verifyingContract: `0x${string}` };
  message: {
    to: `0x${string}`;
    value: bigint;
    data: `0x${string}`;
    operation: number;
    safeTxGas: bigint;
    baseGas: bigint;
    gasPrice: bigint;
    gasToken: `0x${string}`;
    refundReceiver: `0x${string}`;
    nonce: bigint;
  };
};

function typedDataFor(ctx: SigningContext): SafeTxTypedData {
  if (!isAddress(ctx.safeAddress)) throw new TypeError(`SafeTxFieldInvalid: safeAddress=${ctx.safeAddress}`);
  const { data } = ctx;
  for (const [field, value] of [
    ['to', data.to],
    ['gasToken', data.gasToken],
    ['refundReceiver', data.refundReceiver],
  ] as const) {
    if (!isAddress(value)) throw new TypeError(`SafeTxFieldInvalid: ${field}=${value}`);
  }
  return {
    domain: { chainId: BigInt(ctx.chainId), verifyingContract: ctx.safeAddress },
    message: {
      to: data.to as `0x${string}`,
      value: toQuantity(data.value, 'value'),
      data: data.data as `0x${string}`,
      operation: data.operation,
      safeTxGas: toQuantity(data.safeTxGas, 'safeTxGas'),
      baseGas: toQuantity(data.baseGas, 'baseGas'),
      gasPrice: toQuantity(data.gasPrice, 'gasPrice'),
      gasToken: data.gasToken as `0x${string}`,
      refundReceiver: data.refundReceiver as `0x${string}`,
      nonce: BigInt(data.nonce),
    },
  };
}

export function safeTxTypedData(ctx: SigningContext): SafeTxTypedData {
  return typedDataFor(ctx);
}

/**
 * Domain separator + struct hash for the SafeTx, asserted against the digest
 * protocol-kit reported. A domain mismatch here would sign a different struct
 * than the one the Safe verifies, so it fails closed.
 */
export function safeTxHashParts(ctx: SigningContext): {
  domainSeparator: `0x${string}`;
  structHash: `0x${string}`;
} {
  const typedData = typedDataFor(ctx);
  const digest = hashTypedData({
    domain: typedData.domain,
    types: SAFE_TX_TYPES,
    primaryType: 'SafeTx',
    message: typedData.message,
  });
  if (digest.toLowerCase() !== ctx.safeTxHash.toLowerCase()) {
    throw new SafeTxDigestMismatch(digest, ctx.safeTxHash);
  }
  return {
    domainSeparator: hashDomain({ domain: typedData.domain, types: SAFE_TX_TYPES }),
    structHash: hashStruct({ data: typedData.message, types: SAFE_TX_TYPES, primaryType: 'SafeTx' }),
  };
}

/** v is 27/28 on the wire; hardware wallets sometimes report the raw recovery id. */
export function normalizeV(v: number): number {
  return v < 27 ? v + 27 : v;
}

/** 65-byte `r‖s‖v` from the parts hardware wallets return. */
export function toHexSignature(r: string, s: string, v: number): `0x${string}` {
  const pad = (x: string) => x.replace(/^0x/, '').padStart(64, '0');
  return `0x${pad(r)}${pad(s)}${normalizeV(v).toString(16).padStart(2, '0')}` as `0x${string}`;
}
