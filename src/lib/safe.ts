// Safe orchestration: predict, deploy, propose, and execute. Everything reads and
// encodes through protocol-kit bound to this app's provider, except the final
// `execTransaction` encoding, which is built from the stored SafeTx fields so a
// reloaded session cannot drift from what the owners signed.

import Safe, { EthSafeSignature, buildSignatureBytes } from '@safe-global/protocol-kit';
import {
  encodeFunctionData,
  getAddress,
  isAddress,
  parseAbi,
} from 'viem';
import { CONTRACT_NETWORKS, DEPLOYMENTS, RPC_URL, SAFE_VERSION, assertSepolia } from './chains';
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

/**
 * The one wallet dance for a deploy: connect a payer, broadcast the call, wait for
 * the receipt. Both the create flow and the existing-mode DeployStep go through
 * here so the two entry points cannot drift on gas, chain check or receipt wait.
 */
export async function deployWithPayer(
  call: { to: `0x${string}`; data: `0x${string}`; value?: string },
  onSent?: (hash: `0x${string}`) => void,
): Promise<`0x${string}`> {
  const payer = await connectInjected('Deploy payer');
  const hash = await sendFromWallet(payer.provider, payer.address, call);
  onSent?.(hash);
  await waitForReceipt(hash);
  return hash;
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
