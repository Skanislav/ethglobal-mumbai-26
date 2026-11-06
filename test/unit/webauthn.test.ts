import { describe, expect, it } from 'bun:test';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { concat, decodeAbiParameters, parseAbiParameters, toHex } from 'viem';
import {
  ClientDataMalformed,
  PasskeyHighS,
  clientDataFieldsOf,
  encodePasskeySignature,
} from '../../src/lib/webauthn';
import { synthesizeAssertion, newSyntheticPasskey } from '../../scripts/synthetic-assertion';

/** Canonical client data for challenge `AA…A` (43 base64url chars of 32 zero bytes). */
function clientData(challenge: string, origin = 'http://localhost:5173'): string {
  return JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false });
}

const CHALLENGE = 'A'.repeat(43);

describe('clientDataFieldsOf', () => {
  it('strips the fixed prefix, the challenge and the closing brace', () => {
    const fields = clientDataFieldsOf(clientData(CHALLENGE));
    expect(fields).toBe(`"origin":"http://localhost:5173","crossOrigin":false`);
    expect(fields.startsWith('"origin"')).toBe(true);
  });

  it('keeps an origin that itself contains a comma', () => {
    const fields = clientDataFieldsOf(clientData(CHALLENGE, 'https://a.example,with,commas'));
    expect(fields).toBe(`"origin":"https://a.example,with,commas","crossOrigin":false`);
  });

  it('rejects JSON that is not WebAuthn get-client data', () => {
    expect(() => clientDataFieldsOf('{"type":"webauthn.create"}')).toThrow(ClientDataMalformed);
    expect(() => clientDataFieldsOf(JSON.stringify({ type: 'webauthn.get', challenge: 'x'.repeat(43) }))).toThrow(
      ClientDataMalformed,
    );
  });
});

describe('encodePasskeySignature', () => {
  it('emits r and s unchanged from the DER signature', () => {
    const passkey = newSyntheticPasskey();
    const safeTxHash = `0x${'11'.repeat(32)}` as const;
    const assertion = synthesizeAssertion(passkey, safeTxHash);
    const blob = encodePasskeySignature(assertion);

    const [authData, fields, r, s] = decodeAbiParameters(
      parseAbiParameters('bytes, string, uint256, uint256'),
      blob,
    );
    const decoded = p256.Signature.fromDER(assertion.derSignature);
    // The protocol-kit bug clobbered the tail to 1f; asserting the true value is the regression.
    expect(r).toBe(decoded.r);
    expect(s).toBe(decoded.s);
    // The s word sits in the static section; the dynamic client-data tail follows it, so
    // the regression assertion is on that exact word, not on the blob's last bytes.
    const words = (blob.slice(2).match(/.{64}/g) ?? []);
    expect(words[3]).toBe(decoded.s.toString(16).padStart(64, '0'));
    expect(blob.slice(-2)).not.toBe('1f');
    expect(toHex(assertion.authenticatorData)).toBe(authData);
    expect(fields.startsWith('"origin"')).toBe(true);
  });

  it('produces the documented vector for private key 0x…01 and digest 0x0202…02', () => {
    const privateKey = new Uint8Array(32);
    privateKey[31] = 1;
    const digest = new Uint8Array(32).fill(2);
    const signature = p256.sign(digest, privateKey, { lowS: true });
    expect(signature.r.toString(16)).toBe('39755fa579ae615fc7696bfc781b065d1c18f3ee6b2dc822344a67b1f2f78bf6');
    expect(signature.s.toString(16)).toBe('1e04b228ce1071956fd671f6832ebe8738841334bba69bc34322d6d781588f3d');
    expect(Buffer.from(signature.toDERRawBytes()).toString('hex').startsWith('3044022039755fa5')).toBe(true);
    expect(p256.verify(signature.toDERRawBytes(), digest, p256.getPublicKey(privateKey, false))).toBe(true);
  });

  it('stays under the castSignature bound the Safe singleton enforces', () => {
    const passkey = newSyntheticPasskey();
    const assertion = synthesizeAssertion(passkey, `0x${'22'.repeat(32)}`);
    const blob = encodePasskeySignature(assertion);
    const align32 = (n: number) => Math.ceil(n / 32) * 32;
    const bound =
      193 +
      align32(assertion.authenticatorData.length) +
      align32(new TextEncoder().encode(clientDataFieldsOf(assertion.clientDataJSON)).length);
    expect((blob.length - 2) / 2).toBeLessThan(bound);
  });

  it('refuses a high-S signature instead of silently normalizing it', () => {
    const privateKey = new Uint8Array(32);
    privateKey[31] = 1;
    const digest = new Uint8Array(32).fill(2);
    const low = p256.sign(digest, privateKey, { lowS: true });
    const order = p256.CURVE.n;
    const highS = new p256.Signature(low.r, order - low.s);
    expect(highS.hasHighS()).toBe(true);

    const assertion = synthesizeAssertion(newSyntheticPasskey(), `0x${'33'.repeat(32)}`);
    const forged = { ...assertion, derSignature: highS.toDERRawBytes() };
    expect(() => encodePasskeySignature(forged)).toThrow(PasskeyHighS);
  });

  it('signs a digest that a real authenticator would produce (SHA-256 over authData‖clientDataHash)', () => {
    const passkey = newSyntheticPasskey();
    const safeTxHash = `0x${'44'.repeat(32)}` as const;
    const assertion = synthesizeAssertion(passkey, safeTxHash);
    const digest = sha256(
      concat([assertion.authenticatorData, sha256(assertion.clientDataJSON)]),
    );
    expect(p256.verify(assertion.derSignature, digest, p256.getPublicKey(passkey.privateKey, false))).toBe(true);
    expect(assertion.authenticatorData[32] & 0x04).toBe(0x04);
    const rebuiltChallenge = clientDataFieldsOf(assertion.clientDataJSON);
    expect(rebuiltChallenge).not.toContain(safeTxHash);
  });
});
