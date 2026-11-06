// Account discovery for hardware wallets. A Trezor or Ledger holds many accounts
// under one seed, and the tile used to guess `44'/60'/0'/0/0` with a free-text path
// field — so anyone whose account lived anywhere else could not add it at all.
//
// This module turns "which account?" into a list: walk the standard accounts, show
// each address with its Sepolia balance and whether it is already an owner, and let
// the user pick. It is deliberately rune-free so the fork script and unit tests can
// import it without a browser.

import { sepoliaPublicClient } from '../client';
import type { SignerRecord } from '../signer-types';

/** How many `44'/60'/i'/0/0` accounts to walk. Five covers every default wallet. */
export const DISCOVERY_ACCOUNTS = 5;

export type DiscoveredAccount = {
  path: string;
  account: number;
  address: `0x${string}`;
  /** Wei on Sepolia, or null when the read failed — the row still appears. */
  balance: bigint | null;
  /** True when this address is already in the owner set. */
  alreadyOwner: boolean;
};

/** `m/44'/60'/account'/change/index`, without the leading `m/` the SDKs differ on. */
export function hdPath(account: number, change = 0, index = 0): string {
  return `44'/60'/${account}'/${change}/${index}`;
}

/** The paths discovery walks, in the order a hardware wallet lists them. */
export function discoveryPaths(count = DISCOVERY_ACCOUNTS): string[] {
  return Array.from({ length: count }, (_, account) => hdPath(account));
}

/**
 * Decorates raw device results with the two facts that make a list pickable:
 * whether the account holds Sepolia ETH, and whether it is already an owner.
 *
 * A balance read failure is reported as `null` rather than thrown: discovery is a
 * convenience, and refusing to show an account because a gateway hiccuped would be
 * worse than showing it with an unknown balance.
 */
export async function describeAccounts(
  raw: { path: string; address: `0x${string}` }[],
  owners: SignerRecord[],
): Promise<DiscoveredAccount[]> {
  const owned = new Set(owners.map((signer) => signer.address.toLowerCase()));
  return Promise.all(
    raw.map(async ({ path, address }, account) => {
      const balance = await sepoliaPublicClient
        .getBalance({ address })
        .catch(() => null);
      return { path, account, address, balance, alreadyOwner: owned.has(address.toLowerCase()) };
    }),
  );
}
