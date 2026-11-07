// ARX HaLo NFC chip (secp256k1). The chip signs the raw 32-byte SafeTx digest,
// so `v` stays 27/28 in the normalized `ether` signature.

import { EthSafeSignature } from '@safe-global/protocol-kit';
import { execHaloCmdWeb } from '@arx-research/libhalo/api/web';
import { haloConvertSignature, SECP256k1_ORDER } from '@arx-research/libhalo/api/common';
import { publicKeyToAddress } from 'viem/accounts';
import { HaloUnavailable } from '../signer-types';
import type { SigningContext } from '../signer-types';

export type HaloStatus = 'init' | 'again' | 'retry' | 'scanned';

/**
 * The chip driver reports four states while a tap is in flight. `retry` and `again`
 * mean the tag moved or was read only partially, which is the common case on a phone
 * — saying "hold the chip still" is more useful than echoing the raw word.
 */
export function haloStatusText(status: HaloStatus): string {
  switch (status) {
    case 'init':
      return 'Hold the chip against the back of your phone…';
    case 'again':
      return 'Lost the chip — hold it against the phone again.';
    case 'retry':
      return 'Read interrupted — keep the chip still and hold it to the phone.';
    case 'scanned':
      return 'Chip read.';
    default:
      return String(status);
  }
}

type HaloPkeys = { publicKeys?: string[] };

/**
 * NFC is only reachable from a secure context with Web NFC or a bridge.
 * Sync truth source for the tile gating; `haloProbe()` gives the async,
 * cause-labeled answer — it constructs `NDEFReader` exactly the way
 * libhalo's `detectMethod()` decides between transports, so a browser whose
 * constructor exists but throws (desktop Chrome exposing a stub, insecure
 * contexts) is reported precisely instead of as "device has no NFC".
 */
export function haloAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as Record<string, unknown>;
  if (typeof w.HaloBridge !== 'undefined') return true;
  try {
    new (w.NDEFReader as new () => unknown)();
    return true;
  } catch {
    return false;
  }
}

export type HaloProbe = { ok: true; method: 'webnfc' | 'bridge' } | { ok: false; reason: string };

export async function haloProbe(): Promise<HaloProbe> {
  if (typeof window === 'undefined') return { ok: false, reason: 'not in a browser' };
  if (!window.isSecureContext) {
    return { ok: false, reason: 'NFC needs a secure context — open this page over HTTPS' };
  }
  if (typeof (window as unknown as Record<string, unknown>).HaloBridge !== 'undefined') {
    return { ok: true, method: 'bridge' };
  }
  const w = window as unknown as Record<string, unknown>;
  if (typeof w.NDEFReader === 'undefined') {
    return { ok: false, reason: 'this browser has no Web NFC API (Android Chrome is the one that does)' };
  }
  try {
    new (w.NDEFReader as new () => unknown)();
  } catch (err) {
    return {
      ok: false,
      reason: `the Web NFC constructor threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let permission = '';
  try {
    const q = await navigator.permissions?.query({ name: 'nfc' as PermissionName });
    permission = q?.state ?? '';
  } catch {
    // The query name is not in every browser's registry; absence is not a failure.
  }
  if (permission === 'denied') {
    return { ok: false, reason: 'Web NFC permission is denied for this page — allow it in the browser settings' };
  }
  return { ok: true, method: 'webnfc' };
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
