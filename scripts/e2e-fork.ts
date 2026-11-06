// Onchain proof on an anvil fork of Sepolia. This drives the same `src/lib/*`
// functions the browser ships — deployment calldata, the passkey encoding, the
// proposal/digest path, the signature collection, and `execTransaction`.
//
//   anvil --fork-url <sepolia> --port 8545 --gas-price 1000000000 --base-fee 1000000000
//   cast rpc anvil_setIntervalMining 1 --rpc-url http://127.0.0.1:8545
//   RPC_URL=http://127.0.0.1:8545 FORK_PAYER_KEY=0x… bun run test:fork
//
// The payer key is read from the environment at run time; it is never in source.

import { createPublicClient, createWalletClient, decodeFunctionResult, encodeFunctionData, getAddress, http } from 'viem';
import type { Hex, PublicClient, WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { CONTRACT_NETWORKS, DEPLOYMENTS, RPC_URL } from '../src/lib/chains';
import { encodeCreateSigner, P256_VERIFIERS, signerFactoryAbi } from '../src/lib/passkeyFactory';
import {
  execTransactionCall,
  ownersBatchCalls,
  proposeSafeTransaction,
  readExistingSafe,
  safeDeploymentCall,
} from '../src/lib/safe';
import type { PendingTx } from '../src/lib/session';
import { newSyntheticPasskey, synthesizePasskeySignature } from './synthetic-assertion';

const CHAIN_ID = 11155111;
// Anvil's first well-known development account. It is published in Foundry's own docs
// and has no value on any real chain; it only ever funds a disposable local fork.
const ANVIL_KEY_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const payerKey = (process.env.FORK_PAYER_KEY ?? ANVIL_KEY_0) as `0x${string}`;
if (!process.env.FORK_PAYER_KEY) {
  console.log('note: FORK_PAYER_KEY unset; using anvil account #0 (a local-fork-only key)');
}

const payer = privateKeyToAccount(payerKey);
const transport = http(RPC_URL);
const pub = createPublicClient({ transport }) as PublicClient;
const wallet = createWalletClient({ account: payer, chain: sepolia, transport }) as WalletClient;

async function broadcast(call: { to: `0x${string}`; data: `0x${string}`; value?: string }) {
  // viem 2.x types require `account`, `chain` and `kzg` explicitly once the client is
  // typed through a cast; all three are the values this client was built with.
  const hash = await wallet.sendTransaction({
    account: payer,
    chain: sepolia,
    to: call.to,
    data: call.data,
    value: call.value ? BigInt(call.value) : 0n,
    gas: 6_000_000n,
    kzg: undefined,
  });
  return pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
}

/** Positive paths assert success; the negative check needs the revert to surface. */
async function broadcastOk(call: { to: `0x${string}`; data: `0x${string}`; value?: string }) {
  const receipt = await broadcast(call);
  if (receipt.status !== 'success') fail(`transaction ${receipt.transactionHash} reverted`);
  return receipt;
}

async function passkeyOwnerAddress(x: `0x${string}`, y: `0x${string}`): Promise<`0x${string}`> {
  const { data } = await pub.call({
    to: DEPLOYMENTS.passkeySignerFactory,
    data: encodeFunctionData({
      abi: signerFactoryAbi,
      functionName: 'getSigner',
      args: [BigInt(x), BigInt(y), P256_VERIFIERS],
    }),
  });
  return getAddress(decodeFunctionResult({ abi: signerFactoryAbi, functionName: 'getSigner', data: data ?? '0x' }));
}

/** The hot-wallet half of every signature set: a 65-byte r‖s‖v over the SafeTx digest. */
async function hotSignature(safeAddress: `0x${string}`, pending: PendingTx): Promise<Hex> {
  return payer.signTypedData({
    domain: { chainId: BigInt(CHAIN_ID), verifyingContract: safeAddress },
    types: {
      SafeTx: [
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
        { name: 'operation', type: 'uint8' },
        { name: 'safeTxGas', type: 'uint256' },
        { name: 'baseGas', type: 'uint256' },
        { name: 'gasPrice', type: 'uint256' },
        { name: 'gasToken', type: 'address' },
        { name: 'refundReceiver', type: 'address' },
        { name: 'nonce', type: 'uint256' },
      ],
    },
    primaryType: 'SafeTx',
    message: {
      to: pending.to,
      value: BigInt(pending.value),
      data: pending.data,
      operation: pending.operation,
      safeTxGas: BigInt(pending.safeTxGas),
      baseGas: BigInt(pending.baseGas),
      gasPrice: BigInt(pending.gasPrice),
      gasToken: pending.gasToken,
      refundReceiver: pending.refundReceiver,
      nonce: BigInt(pending.nonce),
    },
  });
}

async function main() {
  const chainId = await pub.getChainId();
  if (chainId !== CHAIN_ID) fail(`expected chain ${CHAIN_ID}, got ${chainId}`);

  // ---------------------------------------------------------------- 2-of-2 Safe
  const passkey = newSyntheticPasskey();
  const passkeyOwner = await passkeyOwnerAddress(passkey.x, passkey.y);
  console.log('passkey owner', passkeyOwner);

  const owners = [payer.address, passkeyOwner];
  const deployment = await safeDeploymentCall({ owners, threshold: 2, saltNonce: String(Date.now()) });
  const deployReceipt = await broadcastOk(deployment);
  console.log('deployed', deployment.predictedAddress, 'gas', deployReceipt.gasUsed);

  const afterDeploy = await readExistingSafe(deployment.predictedAddress);
  if (afterDeploy.threshold !== 2) fail(`threshold ${afterDeploy.threshold} != 2`);
  if (afterDeploy.owners.length !== 2) fail(`owners ${afterDeploy.owners.length} != 2`);

  // The passkey proxy deploys permissionlessly; the Safe already lists it.
  const proxyReceipt = await broadcastOk({
    to: DEPLOYMENTS.passkeySignerFactory,
    data: encodeCreateSigner({ x: passkey.x, y: passkey.y }),
  });
  const proxyCode = await pub.getCode({ address: passkeyOwner });
  console.log('passkey proxy code', (proxyCode ?? '0x').length / 2 - 1, 'gas', proxyReceipt.gasUsed);
  if (!proxyCode || proxyCode === '0x') fail('passkey proxy was not deployed');

  // Proposal through the shipped path, then both owners sign it.
  const testCall = { to: payer.address, value: '0', data: '0x' };
  const pending = await proposeSafeTransaction(deployment.predictedAddress, [testCall]);
  console.log('safeTxHash', pending.safeTxHash, 'nonce', pending.nonce);

  const hotSig = await hotSignature(deployment.predictedAddress, pending);
  const passkeySig = synthesizePasskeySignature(passkey, pending.safeTxHash);

  const execCall = execTransactionCall(
    deployment.predictedAddress,
    {
      ...pending,
      signatures: {
        [payer.address.toLowerCase()]: { blob: hotSig, isContract: false },
        [passkeyOwner.toLowerCase()]: { blob: passkeySig, isContract: true },
      },
    },
    2,
  );
  const execReceipt = await broadcastOk({ to: execCall.to, data: execCall.data });
  console.log('exec status', execReceipt.status, 'gas', execReceipt.gasUsed);

  const nonceAfter = (await readExistingSafe(deployment.predictedAddress)).nonce;
  console.log('nonce', nonceAfter);
  if (nonceAfter !== 1) fail(`nonce ${nonceAfter} != 1`);

  // ------------------------------------------- existing-Safe owner-install batch
  // A 1-of-1 Safe whose sole owner is the payer; then add the passkey as a second
  // owner and raise the threshold to 2 in ONE MultiSend batch (operation 1).
  const soloDeployment = await safeDeploymentCall({
    owners: [payer.address],
    threshold: 1,
    saltNonce: String(Date.now() + 1),
  });
  await broadcastOk(soloDeployment);
  console.log('solo safe', soloDeployment.predictedAddress);

  const batchCalls = ownersBatchCalls(soloDeployment.predictedAddress, [{ x: passkey.x, y: passkey.y }], 2, [passkeyOwner]);
  if (batchCalls.length !== 2) fail(`expected 2 calls in the install batch, got ${batchCalls.length}`);
  const batchPending = await proposeSafeTransaction(soloDeployment.predictedAddress, batchCalls);
  if (batchPending.operation !== 1) fail(`install batch operation ${batchPending.operation} != 1 (MultiSend)`);
  console.log('install batch operation', batchPending.operation, 'to', batchPending.to);

  // The batch is proposed for a new passkey proxy: deploy it first so the batch can
  // call createSigner against an existing factory (it is idempotent).
  const batchHotSig = await hotSignature(soloDeployment.predictedAddress, batchPending);
  const batchExec = execTransactionCall(
    soloDeployment.predictedAddress,
    {
      ...batchPending,
      signatures: { [payer.address.toLowerCase()]: { blob: batchHotSig, isContract: false } },
    },
    1,
  );
  const batchReceipt = await broadcastOk({ to: batchExec.to, data: batchExec.data });
  console.log('install batch status', batchReceipt.status, 'gas', batchReceipt.gasUsed);

  const installed = await readExistingSafe(soloDeployment.predictedAddress);
  if (installed.threshold !== 2) fail(`installed threshold ${installed.threshold} != 2`);
  if (installed.owners.length !== 2) fail(`installed owners ${installed.owners.length} != 2`);
  if (!installed.owners.some((o) => o.toLowerCase() === passkeyOwner.toLowerCase())) {
    fail('the passkey proxy address is not in the owner set');
  }
  console.log('owners after batch', installed.owners.length, 'threshold', installed.threshold);

  // The newly installed passkey alone cannot move funds (2-of-2 now), but its
  // signature verifies: prove it by executing with both owners.
  const proofPending = await proposeSafeTransaction(soloDeployment.predictedAddress, [testCall]);
  const proofHot = await hotSignature(soloDeployment.predictedAddress, proofPending);
  const proofPasskey = synthesizePasskeySignature(passkey, proofPending.safeTxHash);
  const proofExec = execTransactionCall(
    soloDeployment.predictedAddress,
    {
      ...proofPending,
      signatures: {
        [payer.address.toLowerCase()]: { blob: proofHot, isContract: false },
        [passkeyOwner.toLowerCase()]: { blob: proofPasskey, isContract: true },
      },
    },
    2,
  );
  const proofReceipt = await broadcastOk({ to: proofExec.to, data: proofExec.data });
  console.log('post-install exec status', proofReceipt.status);

  // ------------------------------------------------------------------- negatives
  const singlePending = await proposeSafeTransaction(deployment.predictedAddress, [testCall]);
  const singleSig = synthesizePasskeySignature(passkey, singlePending.safeTxHash);
  const singleCall = execTransactionCall(
    deployment.predictedAddress,
    { ...singlePending, signatures: { [passkeyOwner.toLowerCase()]: { blob: singleSig, isContract: true } } },
    1,
  );
  // Simulated rather than broadcast: the revert reason is what the assertion needs.
  try {
    await pub.call({ to: singleCall.to, data: singleCall.data, account: payer });
    fail('single-signature execution unexpectedly succeeded');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = message.match(/GS0\d\d/)?.[0];
    if (!code) fail(`unexpected failure mode: ${message}`);
    console.log('negative check reverted as expected:', code);
  }

  // A 1-of-1 request built against a 2-of-2 must be refused client-side, not sent.
  let refused = false;
  try {
    execTransactionCall(deployment.predictedAddress, singlePending, 2);
  } catch {
    refused = true;
  }
  if (!refused) fail('execTransactionCall accepted fewer signatures than the threshold');
  console.log('threshold guard refused a 1-of-2 signature set');

  console.log('OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
