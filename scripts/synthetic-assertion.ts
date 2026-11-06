// Synthesizes a WebAuthn assertion for a P-256 key so the passkey signature path
// can be exercised without a browser. The encoding it produces is the encoding
// the app ships: `encodePasskeySignature` is imported, never reimplemented.

import { p256 } from '@noble/curves/p256';
import { concat, fromHex, sha256, toBytes, toHex } from 'viem';
import type { Hex } from 'viem';
import { encodePasskeySignature } from '../src/lib/webauthn';

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** viem's sha256 returns hex; the WebAuthn structures need raw bytes. */
function sha256Bytes(input: Uint8Array): Uint8Array {
  return toBytes(sha256(input) as Hex);
}

export type SyntheticPasskey = {
  privateKey: Uint8Array;
  x: `0x${string}`;
  y: `0x${string}`;
  origin: string;
};

export function newSyntheticPasskey(origin = 'http://localhost:5173'): SyntheticPasskey {
  const privateKey = p256.utils.randomSecretKey();
  const uncompressed = p256.getPublicKey(privateKey, false);
  return {
    privateKey,
    x: toHex(uncompressed.slice(1, 33)),
    y: toHex(uncompressed.slice(33, 65)),
    origin,
  };
}

/**
 * The exact assertion a real authenticator would return: client-data JSON whose
 * challenge is the base64url SafeTx hash, and authenticator data carrying the
 * rpIdHash plus the UP|UV flags the Safe singleton requires.
 */
export function synthesizeAssertion(
  passkey: SyntheticPasskey,
  safeTxHash: `0x${string}`,
): { clientDataJSON: string; authenticatorData: Uint8Array; derSignature: Uint8Array } {
  const challenge = base64url(fromHex(safeTxHash, 'bytes'));
  const clientDataJSON = JSON.stringify({
    type: 'webauthn.get',
    challenge,
    origin: passkey.origin,
    crossOrigin: false,
  });
  const hostname = new URL(passkey.origin).hostname;
  const authenticatorData = concat([
    sha256Bytes(new TextEncoder().encode(hostname)),
    new Uint8Array([0x05]), // UP | UV
    new Uint8Array([0, 0, 0, 1]), // signature counter
  ]);
  const digest = sha256Bytes(
    concat([authenticatorData, sha256Bytes(new TextEncoder().encode(clientDataJSON))]),
  );
  const signature = p256.sign(digest, passkey.privateKey, { lowS: true });
  return { clientDataJSON, authenticatorData, derSignature: signature.toDERRawBytes() };
}

/** The shipped encoding, applied to the synthesized assertion. */
export function synthesizePasskeySignature(passkey: SyntheticPasskey, safeTxHash: `0x${string}`): `0x${string}` {
  return encodePasskeySignature(synthesizeAssertion(passkey, safeTxHash));
}
