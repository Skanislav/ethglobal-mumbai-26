// Chain + deployment configuration. Every address here is resolved from the
// official deployment registries at module load; a missing entry throws instead
// of letting `undefined` flow into a transaction.

import {
  getCompatibilityFallbackHandlerDeployments,
  getMultiSendCallOnlyDeployments,
  getProxyFactoryDeployments,
  getSafeL2SingletonDeployments,
} from '@safe-global/safe-deployments';
import {
  getDaimoP256VerifierDeployment,
  getSafeWebAuthnSignerFactoryDeployment,
} from '@safe-global/safe-modules-deployments';

export const SEPOLIA = { chainId: 11155111, name: 'Sepolia' } as const;
export const SAFE_VERSION = '1.4.1';

const CHAIN_KEY = '11155111';

// `import.meta.env` is inlined by vite in the browser bundle; the `process.env`
// branch is what lets `scripts/e2e-fork.ts` point the same code at a local fork.
const processEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;

export const RPC_URL: string =
  (import.meta.env?.VITE_RPC_URL as string | undefined) ??
  processEnv?.VITE_RPC_URL ??
  processEnv?.RPC_URL ??
  'https://ethereum-sepolia-rpc.publicnode.com';

/**
 * Destination used by the private-read sandbox (inside the anon-rpc worker).
 *
 * NOT `sepolia.drpc.org`: that host answers HTTP 400 `code 35` — "chain is not
 * available on free plan" — for Sepolia, so every sandboxed read failed. Tenderly's
 * public Sepolia gateway serves `eth_call` with `access-control-allow-origin: *` and
 * no key, which is what a keyless static bundle needs. Override with
 * `VITE_PRIVATE_READ_ENDPOINT` if it ever rate-limits.
 */
export const PRIVATE_READ_ENDPOINT: string =
  (import.meta.env?.VITE_PRIVATE_READ_ENDPOINT as string | undefined) ??
  'https://sepolia.gateway.tenderly.co';

/** anon-rpc network specifier live on Sepolia (IWorkerSpecifier, chainId 11155111). */
export const ANON_RPC_SPECIFIER: `0x${string}` = '0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A';

export class DeploymentMissing extends Error {
  constructor(key: string, cause?: unknown) {
    super(`DeploymentMissing: ${key}`);
    this.name = 'DeploymentMissing';
    this.cause = cause;
  }
}

type DeploymentRecord = { networkAddresses: Record<string, string | string[]> };

function resolve(key: string, lookup: () => DeploymentRecord | undefined): `0x${string}` {
  let deployment: DeploymentRecord | undefined;
  try {
    deployment = lookup() as DeploymentRecord | undefined;
  } catch (e) {
    throw new DeploymentMissing(key, e);
  }
  const entry = deployment?.networkAddresses?.[CHAIN_KEY];
  const address = Array.isArray(entry) ? entry[0] : entry;
  if (!address) throw new DeploymentMissing(key);
  return address as `0x${string}`;
}

export const DEPLOYMENTS = {
  safeSingleton: resolve('safeSingleton', () =>
    getSafeL2SingletonDeployments({ version: SAFE_VERSION, network: CHAIN_KEY }),
  ),
  proxyFactory: resolve('proxyFactory', () =>
    getProxyFactoryDeployments({ version: SAFE_VERSION, network: CHAIN_KEY }),
  ),
  multiSendCallOnly: resolve('multiSendCallOnly', () =>
    getMultiSendCallOnlyDeployments({ version: SAFE_VERSION, network: CHAIN_KEY }),
  ),
  fallbackHandler: resolve('fallbackHandler', () =>
    getCompatibilityFallbackHandlerDeployments({ version: SAFE_VERSION, network: CHAIN_KEY }),
  ),
  passkeySignerFactory: resolve('passkeySignerFactory', () =>
    getSafeWebAuthnSignerFactoryDeployment({ version: '0.2.1', released: true, network: CHAIN_KEY }),
  ),
  p256Verifier: resolve('p256Verifier', () =>
    getDaimoP256VerifierDeployment({ version: '0.2.1', released: true, network: CHAIN_KEY }),
  ),
} as const;

export type DeploymentKey = keyof typeof DEPLOYMENTS;

export class DeploymentNotOnChain extends Error {
  constructor(key: string, address: string) {
    super(`DeploymentNotOnChain: ${key} @ ${address}`);
    this.name = 'DeploymentNotOnChain';
  }
}

type CodeReader = { getCode(args: { address: `0x${string}` }): Promise<`0x${string}` | undefined> };

/** Fails unless every pinned deployment actually has code on this chain. */
export async function verifyDeployments(client: CodeReader): Promise<void> {
  for (const key of Object.keys(DEPLOYMENTS) as DeploymentKey[]) {
    const address = DEPLOYMENTS[key];
    const code = await client.getCode({ address });
    if (!code || code === '0x') throw new DeploymentNotOnChain(key, address);
  }
}

export const CONTRACT_NETWORKS = {
  [CHAIN_KEY]: {
    safeSingletonAddress: DEPLOYMENTS.safeSingleton,
    safeProxyFactoryAddress: DEPLOYMENTS.proxyFactory,
    multiSendCallOnlyAddress: DEPLOYMENTS.multiSendCallOnly,
    fallbackHandlerAddress: DEPLOYMENTS.fallbackHandler,
  },
} as const;

export class WrongNetwork extends Error {
  constructor(actual: number | bigint) {
    super(`WrongNetwork: expected ${SEPOLIA.chainId}, got ${actual}`);
    this.name = 'WrongNetwork';
  }
}

/** Throws unless the wallet reports Sepolia. Accepts hex string or number. */
export function assertSepolia(chainId: string | number | bigint): void {
  const n = typeof chainId === 'string' ? Number(BigInt(chainId)) : Number(chainId);
  if (n !== SEPOLIA.chainId) throw new WrongNetwork(n);
}

export const SEPOLIA_ETH_USD_FEED: `0x${string}` = '0x694AA1769357215DE4FAC081bf1f309aDC325306';
