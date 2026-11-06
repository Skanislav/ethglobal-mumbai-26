// Safe orchestration: predict, deploy, propose, and execute. Everything reads and
// encodes through protocol-kit bound to this app's provider, except the final
// `execTransaction` encoding, which is built from the stored SafeTx fields so a
// reloaded session cannot drift from what the owners signed.

import Safe, { EthSafeSignature, buildSignatureBytes } from '@safe-global/protocol-kit';
import {
  blobsToCommitments,
  blobsToProofs,
  commitmentsToVersionedHashes,
  encodeFunctionData,
  getAddress,
  isAddress,
  parseAbi,
  toBlobSidecars,
} from 'viem';
import type { Hex } from 'viem';
import { CONTRACT_NETWORKS, DEPLOYMENTS, RPC_URL, SAFE_VERSION, assertSepolia } from './chains';
import { getKzg } from './kzg';
import { encodeCreateSigner } from './passkeyFactory';
import type { PendingSignature, PendingTx } from './session';
import type { PasskeyCoordinates } from './webauthn';
import { connectInjected, requireSepolia } from './signers/hotWallet';

export const safeAbi = parseAbi([
  'function addOwnerWithThreshold(address owner, uint256 _threshold)',
  'function changeThreshold(uint256 _threshold)',
  'function getThreshold() view returns (uint256)',
  'function getOwners() view returns (address[])',
  'function nonce() view returns (uint256)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes signatures) returns (bool success)',
]);

export class NotAnOwner extends Error {
  constructor(address: string) {
    super(`NotAnOwner: ${address} is not an owner of this Safe`);
    this.name = 'NotAnOwner';
  }
}

export class InsufficientSignatures extends Error {
  constructor(have: number, need: number) {
    super(`InsufficientSignatures: have ${have}, need ${need}`);
    this.name = 'InsufficientSignatures';
  }
}

export class SafeAlreadyDeployed extends Error {
  constructor(address: string) {
    super(`SafeAlreadyDeployed: ${address} already has code; derive a new saltNonce`);
    this.name = 'SafeAlreadyDeployed';
  }
}

export type WalletProvider = NonNullable<Window['ethereum']>;

import { sepoliaPublicClient } from './client';
export { sepoliaPublicClient };
export type { ReadClient } from './client';

async function hasCode(address: `0x${string}`): Promise<boolean> {
  const code = await sepoliaPublicClient.getCode({ address });
  return Boolean(code && code !== '0x');
}

/** Owner set + threshold + salt fully determine a Safe's address. */
export type SafeBlueprint = {
  owners: `0x${string}`[];
  threshold: number;
  saltNonce: string;
};

function predictedConfig(blueprint: SafeBlueprint) {
  return {
    provider: RPC_URL,
    predictedSafe: {
      safeAccountConfig: {
        owners: blueprint.owners.map((o) => getAddress(o)),
        threshold: blueprint.threshold,
        fallbackHandler: DEPLOYMENTS.fallbackHandler,
      },
      safeDeploymentConfig: { saltNonce: blueprint.saltNonce, safeVersion: SAFE_VERSION },
    },
    contractNetworks: CONTRACT_NETWORKS,
  } as const;
}

export async function predictSafeAddress(blueprint: SafeBlueprint): Promise<`0x${string}`> {
  const safe = await Safe.init(predictedConfig(blueprint));
  return getAddress(await safe.getAddress());
}

export type DeploymentCall = {
  to: `0x${string}`;
  value: string;
  data: `0x${string}`;
  predictedAddress: `0x${string}`;
};

export async function safeDeploymentCall(blueprint: SafeBlueprint): Promise<DeploymentCall> {
  const safe = await Safe.init(predictedConfig(blueprint));
  const predictedAddress = getAddress(await safe.getAddress());
  if (await hasCode(predictedAddress)) throw new SafeAlreadyDeployed(predictedAddress);
  const tx = await safe.createSafeDeploymentTransaction();
  return {
    to: getAddress(tx.to),
    value: tx.value,
    data: tx.data as `0x${string}`,
    predictedAddress,
  };
}

/** Broadcasts one call from the payer's wallet, after a Sepolia chain check. */
export async function sendFromWallet(
  provider: WalletProvider,
  from: `0x${string}`,
  call: { to: `0x${string}`; data: `0x${string}`; value?: string },
): Promise<`0x${string}`> {
  const chainIdHex = await provider.request({ method: 'eth_chainId' });
  if (typeof chainIdHex !== 'string') throw new Error('the wallet reported no chain id');
  assertSepolia(chainIdHex);
  const value = call.value && call.value !== '0' ? `0x${BigInt(call.value).toString(16)}` : undefined;
  const hash = await provider.request({
    method: 'eth_sendTransaction',
    params: [{ from, to: call.to, data: call.data, value }],
  });
  if (typeof hash !== 'string') throw new Error('the wallet returned no transaction hash');
  return hash as `0x${string}`;
}

export function waitForReceipt(hash: `0x${string}`) {
  return sepoliaPublicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
}

export type ExistingSafeRead = {
  owners: `0x${string}`[];
  threshold: number;
  nonce: number;
  version: string;
};

export async function readExistingSafe(safeAddress: `0x${string}`): Promise<ExistingSafeRead> {
  if (!isAddress(safeAddress)) throw new Error(`InvalidAddress: ${safeAddress}`);
  if (!(await hasCode(safeAddress))) {
    throw new Error(`NoSafeAtAddress: ${safeAddress} has no code on Sepolia`);
  }
  const safe = await Safe.init({ provider: RPC_URL, safeAddress, contractNetworks: CONTRACT_NETWORKS });
  const [owners, threshold, nonce, version] = await Promise.all([
    safe.getOwners(),
    safe.getThreshold(),
    safe.getNonce(),
    safe.getContractVersion(),
  ]);
  return { owners: owners.map((o) => getAddress(o)), threshold, nonce, version };
}

export type SafeCall = { to: string; value: string; data: string };

/**
 * The "install signers" batch for an existing Safe. protocol-kit wraps multiple
 * calls in MultiSend, and the order is load-bearing: every `createSigner` runs
 * before the `addOwnerWithThreshold` that references its address.
 */
export function ownersBatchCalls(
  safeAddress: `0x${string}`,
  passkeys: PasskeyCoordinates[],
  threshold: number,
  addedOwners: `0x${string}`[] = [],
): SafeCall[] {
  const calls: SafeCall[] = passkeys.map((coordinates) => ({
    to: DEPLOYMENTS.passkeySignerFactory,
    value: '0',
    data: encodeCreateSigner(coordinates),
  }));
  for (const owner of addedOwners) {
    calls.push({
      to: safeAddress,
      value: '0',
      data: encodeFunctionData({
        abi: safeAbi,
        functionName: 'addOwnerWithThreshold',
        args: [getAddress(owner), BigInt(threshold)],
      }),
    });
  }
  if (calls.length === 0) {
    calls.push({
      to: safeAddress,
      value: '0',
      data: encodeFunctionData({ abi: safeAbi, functionName: 'changeThreshold', args: [BigInt(threshold)] }),
    });
  }
  return calls;
}

/**
 * Proposes a Safe transaction (one call, or a MultiSend batch) and returns the
 * exact fields plus digest that the owners will sign.
 */
export async function proposeSafeTransaction(
  safeAddress: `0x${string}`,
  calls: SafeCall[],
): Promise<PendingTx> {
  const safe = await Safe.init({
    provider: RPC_URL,
    signer: safeAddress,
    safeAddress,
    contractNetworks: CONTRACT_NETWORKS,
  });
  const safeTx = await safe.createTransaction({ transactions: calls });
  const safeTxHash = (await safe.getTransactionHash(safeTx)) as `0x${string}`;
  return {
    to: getAddress(safeTx.data.to),
    value: String(safeTx.data.value),
    data: safeTx.data.data as `0x${string}`,
    operation: Number(safeTx.data.operation),
    safeTxGas: String(safeTx.data.safeTxGas),
    baseGas: String(safeTx.data.baseGas),
    gasPrice: String(safeTx.data.gasPrice),
    gasToken: getAddress(safeTx.data.gasToken),
    refundReceiver: getAddress(safeTx.data.refundReceiver),
    nonce: Number(safeTx.data.nonce),
    safeTxHash,
    signatures: {},
  };
}

/**
 * `execTransaction` calldata built from the stored fields and the collected
 * signatures. Safe sorts signatures by signer address inside
 * `buildSignatureBytes`, so collection order never matters.
 */
export function execTransactionCall(
  safeAddress: `0x${string}`,
  pending: PendingTx,
  threshold: number,
): { to: `0x${string}`; data: `0x${string}`; nonce: number } {
  const signatures = Object.entries(pending.signatures).map(
    ([owner, sig]: [string, PendingSignature]) =>
      new EthSafeSignature(getAddress(owner), sig.blob, sig.isContract),
  );
  if (signatures.length < threshold) throw new InsufficientSignatures(signatures.length, threshold);
  return {
    to: safeAddress,
    nonce: pending.nonce,
    data: encodeFunctionData({
      abi: safeAbi,
      functionName: 'execTransaction',
      args: [
        getAddress(pending.to),
        BigInt(pending.value),
        pending.data,
        pending.operation,
        BigInt(pending.safeTxGas),
        BigInt(pending.baseGas),
        BigInt(pending.gasPrice),
        getAddress(pending.gasToken),
        getAddress(pending.refundReceiver),
        buildSignatureBytes(signatures) as `0x${string}`,
      ],
    }),
  };
}

/** Refuses to sign for an owner the Safe does not list — a `GS026` avoided before it costs gas. */
export async function assertIsOwner(safeAddress: `0x${string}`, owner: `0x${string}`): Promise<void> {
  const { owners } = await readExistingSafe(safeAddress);
  if (!owners.some((o) => o.toLowerCase() === owner.toLowerCase())) throw new NotAnOwner(owner);
}

export class BlobPublishRejected extends Error {
  constructor(detail: string) {
    super(`BlobPublishRejected: ${detail}`);
    this.name = 'BlobPublishRejected';
  }
}

export type SharePublish = { txHash: Hex; versionedHash: `0x${string}` };

/**
 * Publishes one blob as a type-3 transaction from the user's wallet. The wallet
 * only signs and broadcasts — every derived quantity (commitment, proof,
 * versioned hash, sidecars) is computed here, because a wallet that derived its
 * own from `blobs` would publish a blob the link's hash does not name.
 *
 * The request is hand-built rather than routed through `createWalletClient`:
 * viem's JSON-RPC-account path drops `blobVersionedHashes`, `sidecars`, and `kzg`
 * from `eth_sendTransaction` (verified against viem 2.57.16), which would send a
 * blob transaction with no hashes at all.
 */
export async function publishShareBlob(blobHex: `0x${string}`): Promise<SharePublish> {
  const conn = await connectInjected('Share session via blob');
  await requireSepolia(conn.provider);

  const kzg = await getKzg();
  const blobs = [blobHex] as const;
  const commitments = blobsToCommitments({ blobs, kzg });
  const proofs = blobsToProofs({ blobs, commitments, kzg });
  const sidecars = toBlobSidecars({ blobs, commitments, proofs });
  const versionedHashes = commitmentsToVersionedHashes({ commitments });
  const maxFeePerBlobGas = (await sepoliaPublicClient.getBlobBaseFee()) * 2n;

  const request = {
    from: conn.address,
    // Blob transactions carry no calldata here: it is a self-send of zero value
    // whose only content is the blob.
    to: conn.address,
    value: '0x0',
    type: '0x3',
    maxFeePerBlobGas: `0x${maxFeePerBlobGas.toString(16)}`,
    blobs,
  };
  const send = (params: unknown) => conn.provider.request({ method: 'eth_sendTransaction', params: [params] });

  // No fallback that drops `blobVersionedHashes` and `sidecars`. A wallet that
  // rejects them cannot publish this blob, and retrying with `blobs` alone lets a
  // wallet send the payload as calldata: the user pays, gets a success receipt,
  // and the link names a blob that was never published. Failing here is the only
  // honest outcome.
  let hash: unknown;
  try {
    hash = await send({ ...request, blobVersionedHashes: versionedHashes, sidecars });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new BlobPublishRejected(
      `the wallet refused the blob request (${detail}). It must support EIP-4844 type-3 transactions; a wallet that does not cannot publish a session`,
    );
  }
  if (typeof hash !== 'string') throw new BlobPublishRejected('the wallet returned no transaction hash');

  const txHash = hash as Hex;
  const receipt = await waitForReceipt(txHash);
  if (receipt.status !== 'success') throw new BlobPublishRejected('the blob transaction reverted');
  // The receipt is the only proof the blob was actually carried. A wallet that
  // silently downgraded the request still reports a success receipt, so checking
  // the hash alone would hand back a link to a blob nobody has.
  if (receipt.type !== 'eip4844') {
    throw new BlobPublishRejected(
      `the wallet sent a ${receipt.type} transaction instead of a blob transaction, so nothing was published`,
    );
  }
  if (receipt.blobGasUsed !== undefined && receipt.blobGasUsed !== 131_072n) {
    throw new BlobPublishRejected(`the transaction carried ${receipt.blobGasUsed} blob gas, expected 131072`);
  }
  return { txHash, versionedHash: versionedHashes[0] };
}
