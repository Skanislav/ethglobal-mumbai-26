// Regression test for protocol-kit 8.0.11's broken passkey path: its
// `adjustVInSignature` rewrites the last two hex chars of the ABI blob to `1f`.
// The blob this app builds must round-trip r and s exactly, including s tails
// that are not `1f`, and must stay inside the `WebAuthn.castSignature` size bound.

import { describe, expect, it } from 'bun:test';
import { p256 } from '@noble/curves/p256';
import { decodeAbiParameters, parseAbiParameters } from 'viem';
import { clientDataFieldsOf, encodePasskeySignature } from '../../src/lib/webauthn';
import type { PasskeyAssertion } from '../../src/lib/webauthn';

const PARAMS = parseAbiParameters('bytes, string, uint256, uint256');

/** A deterministic assertion built the way a real authenticator builds one. */
function assertionFor(privateKey: Uint8Array, seed: number) {
  const safeTxHash = `0x${seed.toString(16).padStart(2, '0').repeat(32)}`;
  const challenge = Buffer.from(safeTxHash.slice(2), 'hex').toString('base64url');
  const clientDataJSON = JSON.stringify({
    type: 'webauthn.get',
    challenge,
    origin: 'https://example.test',
    crossOrigin: false,
  });
  const authenticatorData = new Uint8Array(37);
  authenticatorData[32] = 0x05; // UP | UV
  const signature = p256.sign(new Uint8Array(32).fill(seed), privateKey, { lowS: true });
  const assertion: PasskeyAssertion = {
    authenticatorData,
    clientDataJSON,
    derSignature: signature.toDERRawBytes(),
  };
  return { assertion, signature, blob: encodePasskeySignature(assertion) };
}

describe('passkey signature blob', () => {
  it('round-trips r and s byte-for-byte', () => {
    const key = new Uint8Array(32);
    key[31] = 1;
    const { signature, blob } = assertionFor(key, 2);
    const [authData, fields, r, s] = decodeAbiParameters(PARAMS, blob);

    expect(r).toBe(signature.r);
    expect(s).toBe(signature.s);
    expect(authData).toBe(`0x${'00'.repeat(32)}05${'00'.repeat(4)}`);
    expect(fields).toBe('"origin":"https://example.test","crossOrigin":false');
  });

  it('keeps an s tail that is not 1f intact', () => {
    const key = new Uint8Array(32);
    key[31] = 7;
    const { signature, blob } = assertionFor(key, 9);
    const sHex = signature.s.toString(16).padStart(64, '0');
    // Premise of the regression: this s does not end in 1f, so a clobbered blob
    // would be detectable.
    expect(sHex.endsWith('1f')).toBe(false);
    const words = blob.slice(2).match(/.{64}/g) ?? [];
    expect(words[3]).toBe(sHex);
  });

  it('stays inside the castSignature size bound', () => {
    const key = new Uint8Array(32);
    key[31] = 3;
    const { blob } = assertionFor(key, 5);
    const [authData, fields] = decodeAbiParameters(PARAMS, blob);
    const align32 = (n: number) => Math.ceil(n / 32) * 32;
    const size = (blob.length - 2) / 2;
    const bound = 193 + align32((authData.length - 2) / 2) + align32(new TextEncoder().encode(fields).length);
    expect(size).toBeLessThan(bound);
  });

  it('matches the client-data slice the Safe singleton rebuilds', () => {
    const safeTxHash = `0x${'ab'.repeat(32)}` as const;
    const challenge = Buffer.from(safeTxHash.slice(2), 'hex').toString('base64url');
    const json = JSON.stringify({ type: 'webauthn.get', challenge, origin: 'https://x.test', crossOrigin: false });
    // WebAuthn.sol rebuilds: fixed 36-byte prefix + 43-char challenge + 2 bytes + fields + `}`.
    const rebuilt = `${json.slice(0, 36)}${challenge}${json.slice(79, 81)}${clientDataFieldsOf(json)}}`;
    expect(rebuilt).toBe(json);
  });
});
