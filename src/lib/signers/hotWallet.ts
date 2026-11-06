// EIP-1193 injected wallet + the in-memory demo key. Both produce a 65-byte
// r‖s‖v over the SafeTx digest; the injected path uses protocol-kit's own
// signer wiring, the demo path signs the typed data directly.

import { EthSafeSignature } from '@safe-global/protocol-kit';
import type Safe from '@safe-global/protocol-kit';
import { getAddress, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem/accounts';
import { ephemeralKeyFor } from '../ephemeral';
import { SAFE_TX_TYPES, safeTxTypedData } from '../safeTxDigest';
import { SignerUnsigned, UserRejected, WalletUnavailable } from '../signer-types';
import type { SigningContext } from '../signer-types';

export type Eip1193Provider = NonNullable<Window['ethereum']>;

/** EIP-1193 requests fail with code 4001 when the user rejects. */
function translateWalletError(err: unknown): never {
  if (err && typeof err === 'object' && 'code' in err && err.code === 4001) throw new UserRejected();
  throw err;
}

export type InjectedConnection = {
  address: `0x${string}`;
  label: string;
  provider: Eip1193Provider;
};

export async function connectInjected(label = 'Browser wallet'): Promise<InjectedConnection> {
  const eth = typeof window === 'undefined' ? undefined : window.ethereum;
  if (!eth) throw new WalletUnavailable('injected', 'no EIP-1193 provider in this browser');
  let accounts: unknown;
  try {
    accounts = await eth.request({ method: 'eth_requestAccounts' });
  } catch (e) {
    translateWalletError(e);
  }
  const first = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof first !== 'string' || !isAddress(first)) {
    throw new WalletUnavailable('injected', 'the wallet returned no account');
  }
  return { address: getAddress(first), label, provider: eth };
}

/** Wallet-side chain check: a Safe deploy from the wrong chain is a real loss. */
export async function requireSepolia(provider: Eip1193Provider): Promise<void> {
  const chainIdHex = await provider.request({ method: 'eth_chainId' });
  if (typeof chainIdHex !== 'string') throw new WalletUnavailable('injected', 'the wallet reported no chain id');
  const chainId = Number(BigInt(chainIdHex));
  if (chainId !== 11155111) {
    throw new WalletUnavailable(
      'injected',
      `wallet is on chain ${chainId}; switch it to Sepolia (11155111) and retry`,
    );
  }
}

export async function signWithInjected(
  safe: Safe,
  ctx: SigningContext,
  address: `0x${string}`,
): Promise<EthSafeSignature> {
  const tx = await safe.createTransaction({
    transactions: [{ to: ctx.data.to, value: ctx.data.value, data: ctx.data.data }],
  });
  let signed;
  try {
    signed = await safe.signTransaction(tx);
  } catch (e) {
    translateWalletError(e);
  }
  // protocol-kit keys its signature map by lowercase address, whatever casing the
  // signer was configured with.
  const sig = signed.signatures.get(address) ?? signed.signatures.get(address.toLowerCase());
  if (!sig) throw new WalletUnavailable('injected', 'the wallet produced no signature');
  return new EthSafeSignature(address, sig.data, false);
}

/** Demo key: the private key never leaves sessionStorage; the address derives from it. */
export function ephemeralAccountFor(address: `0x${string}`): PrivateKeyAccount {
  const key = ephemeralKeyFor(address);
  if (!key) {
    throw new SignerUnsigned(address, 'the demo key is not in this tab (the tab was closed or the key cleared)');
  }
  return privateKeyToAccount(key);
}

export async function signWithEphemeral(
  ctx: SigningContext,
  address: `0x${string}`,
): Promise<EthSafeSignature> {
  const account = ephemeralAccountFor(address);
  const typed = safeTxTypedData(ctx);
  const sig = await account.signTypedData({
    domain: typed.domain,
    types: SAFE_TX_TYPES,
    primaryType: 'SafeTx',
    message: typed.message,
  });
  return new EthSafeSignature(address, sig, false);
}
