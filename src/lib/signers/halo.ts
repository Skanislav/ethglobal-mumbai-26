// ARX HaLo NFC chip (secp256k1). The chip signs the raw 32-byte SafeTx digest,
// so `v` stays 27/28 in the normalized `ether` signature.

import { EthSafeSignature } from '@safe-global/protocol-kit';
import { execHaloCmdWeb } from '@arx-research/libhalo/api/web';
import { haloConvertSignature, SECP256k1_ORDER } from '@arx-research/libhalo/api/common';
import { publicKeyToAddress } from 'viem/accounts';
import { HaloUnavailable } from '../signer-types';
import type { SigningContext } from '../signer-types';

export type HaloStatus = 'init' | 'again' | 'retry' | 'scanned';

type HaloPkeys = { publicKeys?: string[] };

/** NFC is only reachable from a secure context with Web NFC or a bridge. */
export function haloAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as Record<string, unknown>;
  return typeof w.NDEFReader !== 'undefined' || typeof w.HaloBridge !== 'undefined';
}

export async function readHaloPublicKey(onStatus?: (s: HaloStatus) => void): Promise<`0x${string}`> {
  const options = {
    statusCallback: (s: string) => onStatus?.(s as HaloStatus),
  };
  let res: HaloPkeys;
  try {
    res = (await execHaloCmdWeb({ name: 'get_pkeys' }, options)) as HaloPkeys;
  } catch (e) {
    throw new HaloUnavailable(describeHaloFailure(e));
  }
  const pk = res.publicKeys?.[1];
  if (!pk) throw new HaloUnavailable('the chip returned no key in slot 1');
  return (pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`;
}

export function describeHaloFailure(err: unknown): string {
  const name = err && typeof err === 'object' && 'name' in err ? String(err.name) : 'Error';
  const message = err instanceof Error ? err.message : String(err);
  switch (name) {
    case 'NFCMethodNotSupported':
      return 'this browser has no Web NFC; paste the chip address instead';
    case 'NFCPermissionRequestDenied':
      return 'NFC permission was denied; allow it in the browser prompt and retry';
    case 'HaloTagError':
      return `the chip could not complete the command (${message})`;
    default:
      return message;
  }
}

export async function haloSignerAddress(publicKey: `0x${string}`): Promise<`0x${string}`> {
  return publicKeyToAddress(publicKey);
}

export async function signWithHalo(
  ctx: SigningContext,
  address: `0x${string}`,
  publicKey: `0x${string}` | undefined,
  onStatus?: (s: HaloStatus) => void,
): Promise<EthSafeSignature> {
  if (!publicKey) throw new HaloUnavailable('the chip public key is unknown; reconnect the chip to sign');
  let res: { signature: { der: string } };
  try {
    res = (await execHaloCmdWeb(
      { name: 'sign', keyNo: 1, digest: ctx.safeTxHash.slice(2) },
      { statusCallback: (s: string) => onStatus?.(s as HaloStatus) },
    )) as { signature: { der: string } };
  } catch (e) {
    throw new HaloUnavailable(describeHaloFailure(e));
  }
  const converted = haloConvertSignature(
    ctx.safeTxHash.slice(2),
    res.signature.der,
    publicKey.slice(2),
    SECP256k1_ORDER,
  ) as { ether: string };
  return new EthSafeSignature(address, converted.ether, false);
}
