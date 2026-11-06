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

/**
 * Device SDKs disagree about the `0x` prefix — `hw-app-eth` has returned both
 * forms across versions, and Suite's response is JSON we do not control. Normalize
 * at the boundary so a doubled `0x0x` can never reach viem's checksum parser.
 */
export function deviceAddress(raw: string): `0x${string}` {
  return getAddress(`0x${raw.trim().replace(/^0x/i, '')}`);
}

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
    return deviceAddress(address);
  } finally {
    await close();
  }
}

/**
 * Walks several HD paths over one transport session. Re-opening WebHID per path
 * would re-prompt the user once per account, so discovery opens the device once.
 * `confirm: true` makes the device display the address, which is right for a single
 * explicit pick and wrong for a scan.
 */
export async function scanLedgerPaths(paths: string[], confirm = false): Promise<{ path: string; address: `0x${string}` }[]> {
  const { eth, close } = await openLedger();
  try {
    const found: { path: string; address: `0x${string}` }[] = [];
    for (const path of paths) {
      const { address } = await eth.getAddress(path, confirm);
      found.push({ path, address: deviceAddress(address) });
    }
    return found;
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

/**
 * Connect 10 routes every call through Trezor Suite, so a failure here is almost
 * never about our wiring — it is about how the page can reach Suite. Map the codes
 * Connect actually returns to something a user can act on.
 *
 * The `handshake-timeout` / `storage-access-denied` pair is the important one: with
 * Suite desktop absent, Connect opens Suite Web, whose bootstrap iframe calls
 * `document.requestStorageAccess({ BroadcastChannel: true })`. That needs transient
 * user activation inside that cross-origin iframe, which a click on our page does
 * not grant, so the channel never forms. Suite desktop talks over a loopback
 * WebSocket instead and needs no storage access at all, which is why the fix is to
 * run Suite rather than to retry.
 */
function trezorDetail(code: string | undefined, message: string): string {
  switch (code) {
    case 'Browser_LocalNetworkPermissionMissing':
      return 'your browser blocked this page from reaching Trezor Suite on the local network — allow local network access for this site, then try again';
    case 'Desktop_ConnectionMissing':
      return 'Trezor Suite is not reachable on this device — start Trezor Suite (desktop) and keep it unlocked, then try again';
    case 'Device_NotFound':
      return 'no Trezor device was found — connect it over USB and unlock it';
    case 'Device_UsedElsewhere':
      return 'the device is busy in another window or in Trezor Suite — close the other prompt and retry';
    case 'Method_Cancel':
    case 'Method_Interrupted':
      return 'the Trezor prompt was closed before it finished';
    default:
      break;
  }
  if (message === 'storage-access-denied' || message === 'handshake-timeout') {
    return 'Trezor Suite Web could not open its secure channel, because this browser denied it third-party storage access. Install and launch Trezor Suite (desktop) — Connect reaches it directly over a local connection — or allow third-party cookies for this site, then try again';
  }
  if (message === 'popup-blocked') return 'the Trezor popup was blocked — allow popups for this site';
  return message || 'the request was declined';
}

/** Trezor's Suite transport: no WebHID, so it works in Firefox too. */
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
  if ('error' in res) {
    throw new TrezorError(trezorDetail(res.error.code, res.error.message || 'the address request was declined'));
  }
  return deviceAddress(res.payload.address);
}

/** Same one-session scan for Trezor, whose `init` is the expensive part. */
export async function scanTrezorPaths(paths: string[], confirm = false): Promise<{ path: string; address: `0x${string}` }[]> {
  const api = await initTrezor();
  const found: { path: string; address: `0x${string}` }[] = [];
  for (const path of paths) {
    const res = await api.ethereumGetAddress({ path: `m/${path}`, showOnTrezor: confirm });
    if ('error' in res) {
      throw new TrezorError(trezorDetail(res.error.code, res.error.message || 'the address request was declined'));
    }
    found.push({ path, address: deviceAddress(res.payload.address) });
  }
  return found;
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
  if ('error' in res) {
    throw new TrezorError(trezorDetail(res.error.code, res.error.message || 'the device declined the signature'));
  }
  const hex = res.payload.signature.replace(/^0x/, '');
  if (hex.length !== 130) throw new TrezorError(`unexpected signature length ${hex.length / 2} bytes`);
  return new EthSafeSignature(
    ctx.ownerAddress,
    toHexSignature(hex.slice(0, 64), hex.slice(64, 128), normalizeV(parseInt(hex.slice(128, 130), 16))),
    false,
  );
}
