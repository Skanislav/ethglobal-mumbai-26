// The six-way dispatcher. Every owner record flows through here; each branch
// returns a protocol-kit `EthSafeSignature` ready for `SafeTransaction.addSignature`.

import { EthSafeSignature } from '@safe-global/protocol-kit';
import Safe from '@safe-global/protocol-kit';
import { connectInjected, signWithEphemeral, signWithInjected } from './signers/hotWallet';
import type { Eip1193Provider } from './signers/hotWallet';
import { signWithHalo } from './signers/halo';
import { signWithLedger, signWithTrezor } from './signers/hardware';
import { signSafeTxWithPasskey } from './webauthn';
import { CONTRACT_NETWORKS } from './chains';
import { SignerUnsigned } from './signer-types';
import type { SignerRecord, SigningContext } from './signer-types';

export type { SignerRecord, SigningContext, SignerKind } from './signer-types';
export { DEFAULT_HD_PATH } from './signer-types';

export type SignDeps = {
  /** Injected EIP-1193 provider; required by the injected branch. */
  provider?: Eip1193Provider;
  /** Drives the HaLo status line ("tap the chip"). */
  onHaloStatus?: (status: string) => void;
};

export async function signRecord(
  record: SignerRecord,
  ctx: SigningContext,
  deps: SignDeps = {},
): Promise<EthSafeSignature> {
  if (!record.canSign) {
    throw new SignerUnsigned(record.address, 'this owner was imported as an address only');
  }
  const withOwner: SigningContext = { ...ctx, ownerAddress: record.address };
  switch (record.kind) {
    case 'injected': {
      // An owner recorded as `injected` is an EIP-1193 account: the wallet is asked for
      // it here rather than threaded through every caller. This is authorized
      // already, so it does not re-prompt on the common path.
      const provider = deps.provider ?? (await connectInjected(record.label)).provider;
      const safe = await Safe.init({
        provider,
        signer: record.address,
        safeAddress: ctx.safeAddress,
        contractNetworks: CONTRACT_NETWORKS,
      });
      return signWithInjected(safe, withOwner, record.address);
    }
    case 'ephemeral':
      return signWithEphemeral(withOwner, record.address);
    case 'passkey': {
      const blob = await signSafeTxWithPasskey(record.rawId, withOwner.safeTxHash);
      return new EthSafeSignature(record.address, blob, true);
    }
    case 'halo':
      return signWithHalo(withOwner, record.address, record.publicKey, deps.onHaloStatus);
    case 'ledger':
      return signWithLedger(withOwner, record.path);
    case 'trezor':
      return signWithTrezor(withOwner, record.path);
  }
}
