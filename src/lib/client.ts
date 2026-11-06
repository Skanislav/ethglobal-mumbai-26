// The app's read client. Reads are dispatched per call: when the anon-rpc sandbox
// is up, read-capable methods go through it; otherwise they use the plain Sepolia
// endpoint. Writes never take this path — they go out through the user's wallet.
//
// viem's full `PublicClient` is not assignable from `createPublicClient` in this
// build (its client generics pin `account: undefined`), so the app declares the
// handful of methods it calls. Every contract read is an explicit `eth_call`.

import { createPublicClient, http } from 'viem';
import type { Hex } from 'viem';
import { RPC_URL } from './chains';
import { readRouter } from './readRouter';

export type ReadClient = {
  getCode(args: { address: `0x${string}` }): Promise<Hex | undefined>;
  getChainId(): Promise<number>;
  getGasPrice(): Promise<bigint>;
  /** Derived from the latest block's `excessBlobGas`; no JSON-RPC method exists. */
  getBlobBaseFee(): Promise<bigint>;
  getBalance(args: { address: `0x${string}` }): Promise<bigint>;
  call(args: { to: `0x${string}`; data?: Hex; value?: bigint; account?: `0x${string}` }): Promise<{ data?: Hex }>;
  estimateGas(args: { to: `0x${string}`; data?: Hex; value?: bigint; account?: `0x${string}` }): Promise<bigint>;
  waitForTransactionReceipt(args: { hash: Hex; timeout?: number }): Promise<{
    status: 'success' | 'reverted';
    transactionHash: Hex;
    gasUsed: bigint;
    blockNumber: bigint;
  }>;
};

const plain = createPublicClient({ transport: http(RPC_URL) });

/** `params` for the sandbox, in the positional shape JSON-RPC expects. */
function callParams(args: { to: `0x${string}`; data?: Hex; value?: bigint; account?: `0x${string}` }): unknown[] {
  return [
    {
      from: args.account,
      to: args.to,
      data: args.data ?? '0x',
      value: args.value === undefined ? undefined : `0x${args.value.toString(16)}`,
    },
    'latest',
  ];
}

/**
 * Routes one read. The sandbox path is only taken when it is actually ready;
 * `privateReadsEnabled()` is false whenever the worker failed, and the failure
 * is rendered by the UI rather than swallowed here.
 */
async function readRouted<T>(
  method: string,
  params: unknown[],
  fallback: () => Promise<T>,
  decode: (result: unknown) => T,
): Promise<T> {
  const provider = readRouter();
  if (!provider) return fallback();
  return decode(await provider.request({ method, params }));
}

export const sepoliaPublicClient: ReadClient = {
  async getCode({ address }) {
    return readRouted(
      'eth_getCode',
      [address, 'latest'],
      () => plain.getCode({ address }),
      (result) => (typeof result === 'string' ? (result as Hex) : undefined),
    );
  },

  async getChainId() {
    return readRouted(
      'eth_chainId',
      [],
      () => plain.getChainId(),
      (result) => Number(BigInt(result as string)),
    );
  },

  async getGasPrice() {
    return readRouted(
      'eth_gasPrice',
      [],
      () => plain.getGasPrice(),
      (result) => BigInt(result as string),
    );
  },

  async getBalance({ address }) {
    return readRouted(
      'eth_getBalance',
      [address, 'latest'],
      () => plain.getBalance({ address }),
      (result) => BigInt(result as string),
    );
  },

  // Blob base fee is a function of the latest header's excessBlobGas, so there is
  // no JSON-RPC method to route and no sandbox path to take: it stays plain.
  getBlobBaseFee() {
    return plain.getBlobBaseFee();
  },

  async call(args) {
    return readRouted(
      'eth_call',
      callParams(args),
      () => plain.call({ to: args.to, data: args.data, value: args.value, account: args.account }),
      (result) => ({ data: (typeof result === 'string' ? result : '0x') as Hex }),
    );
  },

  async estimateGas(args) {
    return readRouted(
      'eth_estimateGas',
      [callParams(args)[0]],
      () => plain.estimateGas({ to: args.to, data: args.data, value: args.value, account: args.account }),
      (result) => BigInt(result as string),
    );
  },

  // A receipt is a write-side confirmation: it stays on the plain endpoint, which is
  // the endpoint the transaction was broadcast to.
  async waitForTransactionReceipt(args) {
    return plain.waitForTransactionReceipt(args);
  },
};

