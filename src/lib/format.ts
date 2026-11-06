// Presentation helpers shared by the step components. Pure functions, no runes.

import { getAddress, isAddress } from 'viem';

export function shortAddress(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function etherscanTx(hash: string): string {
  return `https://sepolia.etherscan.io/tx/${hash}`;
}

export function etherscanAddress(address: string): string {
  return `https://sepolia.etherscan.io/address/${address}`;
}

/** Returns a human rejection reason, or null when the value is a valid address. */
export function addressRejection(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'Enter an address.';
  if (trimmed.endsWith('.eth')) return 'ENS names are out of scope: this app is Sepolia-only, paste the hex address.';
  if (!/^0x[0-9a-fA-F]*$/.test(trimmed)) return 'Only hex characters after 0x are allowed.';
  if (trimmed.length !== 42) return `An address is 42 characters; this one has ${trimmed.length}.`;
  if (!isAddress(trimmed)) return 'This is not a valid checksummed address.';
  return null;
}

export function checksum(value: string): `0x${string}` {
  return getAddress(value.trim());
}

/**
 * Wei → ETH, never exponent notation. Sepolia fees are genuinely sub-gwei, so a
 * fixed 6-decimal cut would print `0`; keep 6 decimals above 1 ETH and 4
 * significant fractional digits below it, which is what a user can act on.
 */
export function formatEth(wei: bigint): string {
  if (wei === 0n) return '0';
  const whole = wei / 10n ** 18n;
  const fraction = (wei % 10n ** 18n).toString().padStart(18, '0');
  const trimmed = fraction.replace(/0+$/, '');
  if (whole > 0n) return `${whole}.${trimmed.slice(0, 6).replace(/0+$/, '') || '0'}`;
  const leadingZeros = fraction.length - fraction.replace(/^0+/, '').length;
  return `0.${fraction.slice(0, leadingZeros + 4)}`;
}

/** Maps the named errors this app throws to an actionable sentence. */
export function humanError(err: unknown): string {
  const name = err && typeof err === 'object' && 'name' in err ? String(err.name) : 'Error';
  const message = err instanceof Error ? err.message : String(err);
  switch (name) {
    case 'UserRejected':
      return 'You rejected the request in your wallet. Nothing was sent.';
    case 'PasskeyCancelled':
      return 'The passkey prompt was dismissed. Nothing was signed.';
    case 'PasskeyUnsupported':
      return 'This browser has no WebAuthn support, so a passkey cannot be used here.';
    case 'PasskeyHighS':
      return 'Your authenticator produced a non-canonical signature. Try again; if it repeats, use another device.';
    case 'LedgerNotConnected':
      return `Ledger: ${message.replace(/^LedgerNotConnected: /, '')}`;
    case 'TrezorError':
      return `Trezor: ${message.replace(/^TrezorError: /, '')}. If the popup was blocked, allow popups for this site.`;
    case 'HaloUnavailable':
      return `Chip: ${message.replace(/^HaloUnavailable: /, '')}`;
    case 'WalletUnavailable':
      return message.replace(/^WalletUnavailable: /, 'Wallet: ');
    case 'SignerUnsigned':
      return message.replace(/^SignerUnsigned: /, 'Cannot sign: ');
    case 'InsufficientSignatures':
      return message.replace(/^InsufficientSignatures: /, 'Not enough signatures yet — ');
    case 'NotAnOwner':
      return message.replace(/^NotAnOwner: /, 'This signer is not an owner of this Safe: ');
    case 'WrongNetwork':
      return `Wrong network: ${message.replace(/^WrongNetwork: /, '')}. Switch the wallet to Sepolia.`;
    case 'SafeAlreadyDeployed':
      return 'That Safe address already has code. Start a new session to derive a fresh salt.';
    case 'InvalidSession':
      return `That session link is not readable: ${message.replace(/^InvalidSession: /, '')}.`;
    case 'WrongShareKey':
      return 'This link’s key does not open that blob. Ask the sender for the full link — the part after the second slash is the key.';
    case 'ShareFormatError':
      return `That blob is not a readable session: ${message.replace(/^ShareFormatError: /, '')}.`;
    case 'BlobNotIndexed':
      return 'The blob is not indexed yet. It is onchain, so reopen the link in a minute.';
    case 'BlobPublishRejected':
      return `The blob was not published: ${message.replace(/^BlobPublishRejected: /, '')}.`;
    case 'DuplicateOwner':
      return 'That address is already in the signer set.';
    case 'DeploymentNotOnChain':
    case 'DeploymentMissing':
      return `A pinned contract is missing on Sepolia (${message}). Do not proceed.`;
    case 'PrivateReadFailed': {
      // The upstream body is the actionable part: "chain is not available on free
      // plan" tells the user to switch endpoints; a bare "HTTP 400" does not.
      const upstream = (err as { upstream?: string }).upstream;
      const host = (() => {
        const endpoint = (err as { endpoint?: string }).endpoint;
        if (!endpoint) return 'the private-read endpoint';
        try {
          return new URL(endpoint).host;
        } catch {
          return endpoint;
        }
      })();
      return `Private reads are failing: ${host} refused the call${upstream ? ` — “${upstream}”` : ''}. Turn off private reads to keep working, or set VITE_PRIVATE_READ_ENDPOINT to a Sepolia endpoint.`;
    }
    case 'RpcError':
      return `RPC error: ${message}`;
    default:
      if (message.includes('GS024')) return 'The Safe rejected a signature (GS024). Re-sign with the owner that failed.';
      if (message.includes('GS026')) return 'One of the collected signatures is from an address that is not an owner (GS026).';
      if (message.includes('GS013')) return 'The Safe transaction failed onchain (GS013). Check the target call.';
      return message;
  }
}

/** USD for a cost that is usually fractions of a cent on Sepolia. */
export function formatUsd(feeWei: bigint, usdPerEth: number): string {
  const value = Number(formatEth(feeWei)) * usdPerEth;
  if (!Number.isFinite(value)) return 'unavailable';
  if (value === 0) return '$0';
  if (value < 0.01) return '<$0.01';
  return `$${value.toFixed(2)}`;
}
