// Live-cost context: gas for the exact calldata, and ETH/USD from the Sepolia
// Chainlink feed read at click time. Neither number is ever remembered; on
// failure both report "unavailable" instead of substituting a constant.

import { decodeFunctionResult, encodeFunctionData, formatUnits, parseAbi } from 'viem';
import { SEPOLIA_ETH_USD_FEED } from './chains';
import { sepoliaPublicClient } from './client';

const FEED_ABI = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
]);

export type GasEstimate = {
  gas: bigint;
  gasPrice: bigint;
  feeWei: bigint;
};

export type EthUsd = {
  usd: number;
  fetchedAt: number;
};

export type CostContext =
  | { status: 'ready'; gas: GasEstimate; price: EthUsd | null; priceError: string | null }
  | { status: 'gas-unavailable'; reason: string };

/** `eth_estimateGas` on the exact call, then the current gas price. */
export async function estimateCallCost(call: {
  to: `0x${string}`;
  data: `0x${string}`;
  value?: string;
}): Promise<GasEstimate> {
  const [gas, gasPrice] = await Promise.all([
    // A funded-looking placeholder sender: estimation only needs the calldata to
    // be well-formed, and the payer is not connected yet at this point.
    sepoliaPublicClient.estimateGas({
      to: call.to,
      data: call.data,
      value: call.value ? BigInt(call.value) : 0n,
      account: '0x0000000000000000000000000000000000000001',
    }),
    sepoliaPublicClient.getGasPrice(),
  ]);
  return { gas, gasPrice, feeWei: gas * gasPrice };
}

async function feedCall(data: `0x${string}`): Promise<`0x${string}`> {
  const res = await sepoliaPublicClient.call({ to: SEPOLIA_ETH_USD_FEED, data });
  return res.data ?? '0x';
}

/** Chainlink on Sepolia never carries the mainnet feed; this is the testnet feed. */
export async function readEthUsd(): Promise<EthUsd> {
  const [roundData, decimalsData] = await Promise.all([
    feedCall(encodeFunctionData({ abi: FEED_ABI, functionName: 'latestRoundData' })),
    feedCall(encodeFunctionData({ abi: FEED_ABI, functionName: 'decimals' })),
  ]);
  const round = decodeFunctionResult({ abi: FEED_ABI, functionName: 'latestRoundData', data: roundData });
  const decimals = decodeFunctionResult({ abi: FEED_ABI, functionName: 'decimals', data: decimalsData });
  const answer = round[1];
  if (answer <= 0n) throw new Error('the ETH/USD feed returned a non-positive answer');
  return { usd: Number(formatUnits(answer, decimals)), fetchedAt: Date.now() };
}

/** One read of both numbers, for a step that is about to spend gas. */
export async function readCostContext(call: {
  to: `0x${string}`;
  data: `0x${string}`;
  value?: string;
}): Promise<CostContext> {
  let gas: GasEstimate;
  try {
    gas = await estimateCallCost(call);
  } catch (err) {
    return { status: 'gas-unavailable', reason: err instanceof Error ? err.message : String(err) };
  }
  try {
    return { status: 'ready', gas, price: await readEthUsd(), priceError: null };
  } catch (err) {
    return { status: 'ready', gas, price: null, priceError: err instanceof Error ? err.message : String(err) };
  }
}

/** A type-3 self-send is 21000 gas; the blob itself is charged per blob gas unit. */
const BLOB_TX_GAS = 21_000n;
const BLOB_GAS_PER_BLOB = 131_072n;

/**
 * Blob publishing cost at click time. `eth_estimateGas` cannot price a blob
 * transaction (the request carries no calldata and the base fee is charged
 * separately), so this reads the live blob base fee plus the current gas price
 * instead of quoting a remembered number.
 *
 * Execution gas and blob gas are priced by two different base fees, so the
 * estimate reports only the true total: putting the blob's 131072 units into
 * `gas` would multiply them by the execution gas price and overstate the cost.
 */
export async function estimateBlobPublishCost(): Promise<CostContext> {
  let gasPrice: bigint;
  let blobBaseFee: bigint;
  try {
    [gasPrice, blobBaseFee] = await Promise.all([
      sepoliaPublicClient.getGasPrice(),
      sepoliaPublicClient.getBlobBaseFee(),
    ]);
  } catch (err) {
    return { status: 'gas-unavailable', reason: err instanceof Error ? err.message : String(err) };
  }
  const feeWei = BLOB_TX_GAS * gasPrice + BLOB_GAS_PER_BLOB * blobBaseFee;
  const gas: GasEstimate = { gas: BLOB_TX_GAS, gasPrice, feeWei };
  try {
    return { status: 'ready', gas, price: await readEthUsd(), priceError: null };
  } catch (err) {
    return { status: 'ready', gas, price: null, priceError: err instanceof Error ? err.message : String(err) };
  }
}
