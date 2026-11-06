// Shared signer shape + named errors. Its own module so the device-specific
// adapters can import these types without importing the adapter registry.

import type { PasskeyCoordinates } from './webauthn';

export type SignerKind = 'injected' | 'ephemeral' | 'passkey' | 'halo' | 'ledger' | 'trezor';

type SignerBase = {
  address: `0x${string}`;
  label: string;
  /** false = owner is known but this browser cannot produce its signature. */
  canSign: boolean;
};

export type SignerRecord =
  | (SignerBase & { kind: 'injected' })
  | (SignerBase & { kind: 'ephemeral' })
  | (SignerBase & { kind: 'passkey'; rawId: `0x${string}`; coordinates: PasskeyCoordinates; origin: string })
  | (SignerBase & { kind: 'halo'; publicKey?: `0x${string}` })
  | (SignerBase & { kind: 'ledger'; path: string })
  | (SignerBase & { kind: 'trezor'; path: string });

export const DEFAULT_HD_PATH = "44'/60'/0'/0/0";

export type SafeTxData = {
  to: string;
  value: string;
  data: string;
  operation: number;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: string;
  refundReceiver: string;
  nonce: number;
};

export type SigningContext = {
  safeAddress: `0x${string}`;
  chainId: number;
  safeTxHash: `0x${string}`;
  /** Owner the produced signature belongs to; hardware adapters cannot derive it themselves. */
  ownerAddress: `0x${string}`;
  data: SafeTxData;
};

export class WalletUnavailable extends Error {
  constructor(kind: SignerKind, detail: string) {
    super(`WalletUnavailable: ${kind} — ${detail}`);
    this.name = 'WalletUnavailable';
  }
}

export class SignerUnsigned extends Error {
  constructor(address: string, detail: string) {
    super(`SignerUnsigned: ${address} — ${detail}`);
    this.name = 'SignerUnsigned';
  }
}

export class UserRejected extends Error {
  constructor() {
    super('UserRejected: the request was rejected in the wallet');
    this.name = 'UserRejected';
  }
}

export class WrongChain extends Error {
  constructor(detail: string) {
    super(`WrongChain: ${detail}`);
    this.name = 'WrongChain';
  }
}

export class TrezorError extends Error {
  constructor(detail: string) {
    super(`TrezorError: ${detail}`);
    this.name = 'TrezorError';
  }
}

export class LedgerNotConnected extends Error {
  constructor(detail = 'no Ledger found over WebHID') {
    super(`LedgerNotConnected: ${detail}`);
    this.name = 'LedgerNotConnected';
  }
}

export class HaloUnavailable extends Error {
  constructor(detail: string) {
    super(`HaloUnavailable: ${detail}`);
    this.name = 'HaloUnavailable';
  }
}
