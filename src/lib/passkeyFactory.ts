// Safe passkey signer proxies. The owner address is the deterministic proxy the
// SafeWebAuthnSignerFactory deploys; it is known before the proxy exists, which
// is what lets an undeployed passkey sit in a Safe's owner list.

import { decodeFunctionResult, encodeFunctionData, getAddress, parseAbi } from 'viem';
import type { ReadClient } from './client';
import { DEPLOYMENTS } from './chains';
import type { PasskeyCoordinates } from './webauthn';

export const signerFactoryAbi = parseAbi([
  'function getSigner(uint256 x, uint256 y, uint176 verifiers) view returns (address)',
  'function createSigner(uint256 x, uint256 y, uint176 verifiers) returns (address)',
]);

/**
 * `verifiers` is the P-256 verifier contract address packed into a uint176 —
 * not a bitfield. Passing anything else derives a different proxy address and
 * every signature then fails with `GS024`.
 */
export const P256_VERIFIERS: bigint = BigInt(DEPLOYMENTS.p256Verifier);

export async function passkeySignerAddress(
  client: ReadClient,
  coordinates: PasskeyCoordinates,
): Promise<`0x${string}`> {
  // `readContract` cannot be typed against a bare client in this viem build
  // (its `authorizationList` parameter is required by the type but optional at
  // runtime), so the call is encoded explicitly instead of cast around.
  const { data } = await client.call({
    to: DEPLOYMENTS.passkeySignerFactory,
    data: encodeFunctionData({
      abi: signerFactoryAbi,
      functionName: 'getSigner',
      args: [BigInt(coordinates.x), BigInt(coordinates.y), P256_VERIFIERS],
    }),
  });
  return getAddress(decodeFunctionResult({ abi: signerFactoryAbi, functionName: 'getSigner', data: data ?? '0x' }));
}

export function encodeCreateSigner(coordinates: PasskeyCoordinates): `0x${string}` {
  return encodeFunctionData({
    abi: signerFactoryAbi,
    functionName: 'createSigner',
    args: [BigInt(coordinates.x), BigInt(coordinates.y), P256_VERIFIERS],
  });
}

/** True once the proxy has code; `createSigner` is idempotent but pointless before then. */
export async function passkeyProxyDeployed(client: ReadClient, address: `0x${string}`): Promise<boolean> {
  const code = await client.getCode({ address });
  return Boolean(code && code !== '0x');
}
