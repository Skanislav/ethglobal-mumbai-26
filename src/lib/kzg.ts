// EIP-4844 KZG, the one piece viem cannot supply itself: viem ships no
// implementation, only `setupKzg` to wrap one. c-kzg's canonical setup is
// filesystem-based (Node-only), so the pure-JS BLS/KZG from micro-eth-signer
// backs the browser path, with the small (~380 KB) trusted setup loaded lazily
// so it costs nothing until a user actually shares.

import { bytesToHex, hexToBytes } from 'viem';
import type { Kzg } from 'viem';

type KzgImpl = {
  blobToKzgCommitment(blob: string): string;
  computeBlobProof(blob: string, commitment: string): string;
};

let pending: Promise<Kzg> | null = null;

/** Memoized: the trusted setup is parsed once per page, not once per share. */
export function getKzg(): Promise<Kzg> {
  pending ??= (async () => {
    const [{ KZG }, { trustedSetup }, { setupKzg }] = await Promise.all([
      import('micro-eth-signer/kzg.js'),
      import('@paulmillr/trusted-setups/small-kzg.js'),
      import('viem'),
    ]);
    // micro-eth-signer speaks hex strings; viem's interface speaks bytes. Convert
    // explicitly at the boundary rather than relying on either side coercing.
    const impl = new KZG(trustedSetup) as unknown as KzgImpl;
    return setupKzg(
      {
        loadTrustedSetup() {},
        blobToKzgCommitment: (blob) => hexToBytes(impl.blobToKzgCommitment(bytesToHex(blob)) as `0x${string}`),
        computeBlobKzgProof: (blob, commitment) =>
          hexToBytes(impl.computeBlobProof(bytesToHex(blob), bytesToHex(commitment)) as `0x${string}`),
      },
      '',
    );
  })();
  return pending;
}
