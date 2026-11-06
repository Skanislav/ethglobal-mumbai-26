// Passkey (WebAuthn / P-256) primitives.
//
// protocol-kit 8.0.11's built-in passkey signed path is broken: it pipes the
// WebAuthn ABI blob through `adjustVInSignature`, which rewrites the last two
// hex chars of the signature. Everything here is therefore hand-rolled, and the
// encoding is DOM-free so the fork e2e can prove the exact bytes the browser ships.

import { p256 } from '@noble/curves/p256';
import { encodeAbiParameters, parseAbiParameters, toHex } from 'viem';

export type PasskeyCoordinates = { x: `0x${string}`; y: `0x${string}` };

export type EnrolledPasskey = {
  rawId: `0x${string}`;
  coordinates: PasskeyCoordinates;
  origin: string;
};

export type PasskeyAssertion = {
  authenticatorData: Uint8Array;
  /** Decoded UTF-8 client-data JSON of the assertion. */
  clientDataJSON: string;
  derSignature: Uint8Array;
};

export class PasskeyUnsupported extends Error {
  constructor() {
    super('PasskeyUnsupported: this browser has no WebAuthn support');
    this.name = 'PasskeyUnsupported';
  }
}

export class PasskeyCancelled extends Error {
  constructor() {
    super('PasskeyCancelled: the passkey prompt was dismissed');
    this.name = 'PasskeyCancelled';
  }
}

export class ClientDataMalformed extends Error {
  constructor(detail: string) {
    super(`ClientDataMalformed: ${detail}`);
    this.name = 'ClientDataMalformed';
  }
}

export class PasskeyHighS extends Error {
  constructor() {
    super('PasskeyHighS: authenticator produced a high-S signature');
    this.name = 'PasskeyHighS';
  }
}

export class PasskeyNoSignature extends Error {
  constructor() {
    super('PasskeyNoSignature: the credential response carried no signature');
    this.name = 'PasskeyNoSignature';
  }
}

// `{"type":"webauthn.get","challenge":"` — 36 bytes, then 43 bytes of base64url.
const CLIENT_DATA_PREFIX = 36;
const CHALLENGE_CHARS = 43;

/**
 * The client-data JSON minus the fixed prefix, the challenge, the closing quote
 * and comma, and the trailing `}`. The Safe singleton rebuilds exactly those
 * bytes around this remainder, so an off-by-two here yields GS024.
 * The result starts with `"origin"`.
 */
export function clientDataFieldsOf(clientDataJSON: string): string {
  const start = CLIENT_DATA_PREFIX + CHALLENGE_CHARS + 2;
  if (clientDataJSON.length <= start + 1) {
    throw new ClientDataMalformed('shorter than the fixed WebAuthn prefix');
  }
  if (!clientDataJSON.endsWith('}')) {
    throw new ClientDataMalformed('missing trailing brace');
  }
  const fields = clientDataJSON.slice(start, clientDataJSON.length - 1);
  if (!fields.startsWith('"origin"')) {
    throw new ClientDataMalformed(`expected "origin" at ${start}, got ${JSON.stringify(fields.slice(0, 12))}`);
  }
  return fields;
}

/**
 * ABI blob the SafeWebAuthnSigner proxy verifies: (authenticatorData, clientDataFields, r, s).
 * Pure: no DOM, no randomness. `r`/`s` are emitted verbatim — never re-encoded.
 */
export function encodePasskeySignature(assertion: PasskeyAssertion): `0x${string}` {
  const fields = clientDataFieldsOf(assertion.clientDataJSON);
  const sig = p256.Signature.fromDER(assertion.derSignature);
  if (sig.hasHighS()) throw new PasskeyHighS();
  return encodeAbiParameters(parseAbiParameters('bytes, string, uint256, uint256'), [
    toHex(assertion.authenticatorData),
    fields,
    sig.r,
    sig.s,
  ]);
}

function b64urlToBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hexToBytes(hex: `0x${string}`): Uint8Array<ArrayBuffer> {
  const clean = hex.slice(2);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): `0x${string}` {
  let s = '0x';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s as `0x${string}`;
}

/** Asks the authenticator for an assertion over the 32-byte Safe tx hash. */
export async function getPasskeyAssertion(
  credRawId: `0x${string}`,
  safeTxHash: `0x${string}`,
): Promise<PasskeyAssertion> {
  if (typeof navigator === 'undefined' || !navigator.credentials?.get) throw new PasskeyUnsupported();
  let cred: Credential | null;
  try {
    cred = await navigator.credentials.get({
      publicKey: {
        challenge: hexToBytes(safeTxHash),
        rpId: location.hostname,
        allowCredentials: [{ type: 'public-key', id: hexToBytes(credRawId) }],
        userVerification: 'required',
      },
    });
  } catch (e) {
    if ((e as Error)?.name === 'NotAllowedError') throw new PasskeyCancelled();
    throw e;
  }
  const response = (cred as PublicKeyCredential | null)?.response as AuthenticatorAssertionResponse | undefined;
  if (!response?.signature) throw new PasskeyCancelled();
  return {
    authenticatorData: new Uint8Array(response.authenticatorData),
    clientDataJSON: new TextDecoder().decode(response.clientDataJSON),
    derSignature: new Uint8Array(response.signature),
  };
}

export async function signSafeTxWithPasskey(
  credRawId: `0x${string}`,
  safeTxHash: `0x${string}`,
): Promise<`0x${string}`> {
  return encodePasskeySignature(await getPasskeyAssertion(credRawId, safeTxHash));
}

async function coordinatesFromSpki(spki: ArrayBuffer): Promise<PasskeyCoordinates> {
  const key = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  const jwk = (await crypto.subtle.exportKey('jwk', key)) as JsonWebKey;
  if (!jwk.x || !jwk.y) throw new ClientDataMalformed('credential public key is not P-256');
  return { x: bytesToHex(b64urlToBytes(jwk.x)), y: bytesToHex(b64urlToBytes(jwk.y)) };
}

/** Registers a new resident P-256 credential and returns the owner coordinates. */
export async function createPasskey(displayName: string): Promise<EnrolledPasskey> {
  if (typeof navigator === 'undefined' || !navigator.credentials?.create) throw new PasskeyUnsupported();
  const userId = crypto.getRandomValues(new Uint8Array(16));
  let cred: Credential | null;
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { id: location.hostname, name: 'Safe Signer Onboarding' },
        user: { id: userId, name: displayName, displayName },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        timeout: 120_000,
      },
    });
  } catch (e) {
    if ((e as Error)?.name === 'NotAllowedError') throw new PasskeyCancelled();
    throw e;
  }
  const pk = cred as PublicKeyCredential | null;
  const attestation = pk?.response as AuthenticatorAttestationResponse | undefined;
  if (!pk || !attestation?.getPublicKey) throw new ClientDataMalformed('attestation carried no public key');
  return {
    rawId: bytesToHex(new Uint8Array(pk.rawId)),
    coordinates: await coordinatesFromSpki(attestation.getPublicKey()),
    origin: location.origin,
  };
}

/**
 * Recovers the P-256 coordinates of an already-registered credential. The
 * second `create()` for the same resident credential is a no-op assertion in
 * every mainstream authenticator, and its attestation still carries the key.
 */
export async function getPasskeyCoordinates(rawId: `0x${string}`): Promise<PasskeyCoordinates> {
  const id = hexToBytes(rawId);
  const spki = await getSpkiForCredential(id);
  return coordinatesFromSpki(spki);
}

async function getSpkiForCredential(id: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  if (!navigator.credentials?.create) throw new PasskeyUnsupported();
  // A create() with the same user.id re-attests the existing resident credential.
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { id: location.hostname, name: 'Safe Signer Onboarding' },
      user: { id, name: 'existing', displayName: 'existing' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;
  const attestation = cred?.response as AuthenticatorAttestationResponse | undefined;
  if (!attestation?.getPublicKey) throw new ClientDataMalformed('attestation carried no public key');
  return attestation.getPublicKey();
}
