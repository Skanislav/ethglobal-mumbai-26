// Ledger (WebHID) and Trezor (Suite popup). Both sign the EIP-712 *hashed* form,
// so they share `safeTxHashParts` and differ only in transport.
//
// The device SDKs are imported on demand, and that is deliberate: they must not
// evaluate on a browser that will never use them. `@ledgerhq/hw-transport-webhid`
// touches a bare `Buffer` at module scope, and `@trezor/connect-web` vendors Node
// stream code, so a static import would break boot on every machine — including
// every Firefox user, who cannot use WebHID at all.

import { EthSafeSignature } from '@safe-global/protocol-kit';
import { getAddress } from 'viem';
import type Eth from '@ledgerhq/hw-app-eth';
import type TrezorConnectDefault from '@trezor/connect-web';

type TrezorConnectApi = typeof TrezorConnectDefault;
import { LedgerNotConnected, TrezorError } from '../signer-types';
import type { SigningContext } from '../signer-types';
import { normalizeV, safeTxHashParts, safeTxTypedData, toHexSignature, trezorTypes } from '../safeTxDigest';

/** WebHID is a secure-context API; Firefox does not ship it, so the tile is gated. */
export function ledgerAvailable(): boolean {
  return typeof navigator !== 'undefined' && typeof (navigator as { hid?: unknown }).hid !== 'undefined';
}

type LedgerSigner = { eth: Eth; close: () => Promise<void> };

async function openLedger(): Promise<LedgerSigner> {
  if (!ledgerAvailable()) {
    throw new LedgerNotConnected('WebHID is unavailable in this browser (Firefox blocks it)');
  }
  // Both packages reach for Node's `Buffer` as a global; the app.html shim cannot
  // provide it, so the polyfill is installed here, immediately before first use.
  const { Buffer } = await import('buffer');
  const globals = globalThis as { Buffer?: unknown };
  if (!globals.Buffer) globals.Buffer = Buffer;

  const [{ default: TransportWebHID }, { default: EthApp }] = await Promise.all([
    import('@ledgerhq/hw-transport-webhid'),
    import('@ledgerhq/hw-app-eth'),
  ]);
  let transport;
  try {
    transport = await TransportWebHID.create();
  } catch (e) {
    throw new LedgerNotConnected(e instanceof Error ? e.message : String(e));
  }
  return { eth: new EthApp(transport), close: () => transport.close() };
}

export async function readLedgerAddress(path: string): Promise<`0x${string}`> {
  const { eth, close } = await openLedger();
  try {
    const { address } = await eth.getAddress(path, false);
    return getAddress(`0x${address}`);
  } finally {
    await close();
  }
}

export async function signWithLedger(ctx: SigningContext, path: string): Promise<EthSafeSignature> {
  const { domainSeparator, structHash } = safeTxHashParts(ctx);
  const { eth, close } = await openLedger();
  try {
    const { r, s, v } = await eth.signEIP712HashedMessage(path, domainSeparator.slice(2), structHash.slice(2));
    return new EthSafeSignature(ctx.ownerAddress, toHexSignature(r, s, v), false);
  } finally {
    await close();
  }
}

let trezorModule: Promise<TrezorConnectApi> | null = null;
let trezorReady = false;

/** Trezor's Suite popup transport: no WebHID, so it works in Firefox too. */
export async function initTrezor(): Promise<TrezorConnectApi> {
  if (!trezorModule) {
    trezorModule = import('@trezor/connect-web').then((mod) => {
      const api = (mod as unknown as { default: TrezorConnectApi }).default;
      return api;
    });
  }
  let api: TrezorConnectApi;
  try {
    api = await trezorModule;
  } catch (e) {
    trezorModule = null;
    throw new TrezorError(e instanceof Error ? e.message : String(e));
  }
  if (trezorReady) return api;
  try {
    await api.init({
      manifest: {
        appName: 'Safe Signer Onboarding',
        appUrl: typeof location === 'undefined' ? 'https://localhost' : location.origin,
        email: 'onboarding@example.org',
      },
    });
    trezorReady = true;
  } catch (e) {
    throw new TrezorError(e instanceof Error ? e.message : String(e));
  }
  return api;
}

export async function readTrezorAddress(path: string): Promise<`0x${string}`> {
  const api = await initTrezor();
  const res = await api.ethereumGetAddress({ path: `m/${path}`, showOnTrezor: true });
  if ('error' in res) throw new TrezorError(res.error.message || 'the address request was declined');
  return getAddress(res.payload.address);
}

export async function signWithTrezor(ctx: SigningContext, path: string): Promise<EthSafeSignature> {
  const { domainSeparator, structHash } = safeTxHashParts(ctx);
  const typedData = safeTxTypedData(ctx);
  const api = await initTrezor();
  const res = await api.ethereumSignTypedData({
    path: `m/${path}`,
    data: {
      types: trezorTypes(),
      primaryType: 'SafeTx',
      domain: typedData.domain,
      message: typedData.message,
    },
    domain_separator_hash: domainSeparator.slice(2),
    message_hash: structHash.slice(2),
    metamask_v4_compat: true,
  });
  if ('error' in res) throw new TrezorError(res.error.message || 'the device declined the signature');
  const hex = res.payload.signature.replace(/^0x/, '');
  if (hex.length !== 130) throw new TrezorError(`unexpected signature length ${hex.length / 2} bytes`);
  return new EthSafeSignature(
    ctx.ownerAddress,
    toHexSignature(hex.slice(0, 64), hex.slice(64, 128), normalizeV(parseInt(hex.slice(128, 130), 16))),
    false,
  );
}
