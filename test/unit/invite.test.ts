import { describe, expect, it } from 'bun:test';
import {
  MAX_SHARE_URL_LENGTH,
  ShareFormatError,
  ShareTooLarge,
  assembleInviteLink,
  createInviteLink,
  ownersPerLink,
  decodeSharePayload,
  encodeSharePayload,
  parseInviteLink,
} from '../../src/lib/invite';
import { addPlannedMember, addSigner, newSession, setThreshold, setVaultName } from '../../src/lib/session';
import type { Session } from '../../src/lib/session';

const A = '0x1111111111111111111111111111111111111111' as const;
const B = '0x2222222222222222222222222222222222222222' as const;

function vault(): Session {
  let s = setVaultName(newSession('create'), 'The Novaks');
  s = addPlannedMember(addPlannedMember(s, 'Sam'), 'Jo');
  s = addSigner(s, { kind: 'injected', address: A, label: 'Alex', canSign: false });
  return setThreshold(s, 1);
}

async function roundTrip(session: Session): Promise<Session> {
  return decodeSharePayload(await encodeSharePayload(session));
}

describe('invite link codec', () => {
  it('round-trips the vault a reader needs to continue', async () => {
    const decoded = await roundTrip(vault());
    expect(decoded.vaultName).toBe('The Novaks');
    // Sam and Jo were invited but never joined, so they stay pending names.
    expect(decoded.plannedMembers?.map((m) => m.name)).toEqual(['Sam', 'Jo']);
    expect(decoded.signers).toHaveLength(1);
    expect(decoded.signers[0].address.toLowerCase()).toBe(A.toLowerCase());
    expect(decoded.signers[0].label).toBe('Alex');
  });

  it('never claims an address that arrived by link can sign', async () => {
    // The key stayed with the sender; a decoded owner must not present as signable.
    const decoded = await roundTrip(vault());
    expect(decoded.signers.every((s) => s.canSign === false)).toBe(true);
  });

  it('is deterministic, so re-sharing an unchanged vault does not churn', async () => {
    const session = vault();
    expect(await encodeSharePayload(session)).toBe(await encodeSharePayload(session));
  });

  it('produces a link short enough for a chat client', async () => {
    const session = vault();
    const link = await createInviteLink('https://safelyfy.example', '/', session);
    expect(link.url.length).toBeLessThanOrEqual(MAX_SHARE_URL_LENGTH);
    // The payload is the whole session, and DEFLATE has to earn its place.
    expect(link.payload.length).toBeLessThan(JSON.stringify(session).length);
    expect(parseInviteLink(link.url)).toBe(link.payload);
  });

  it('carries the vault forward when a member joins and re-shares', async () => {
    const first = await roundTrip(vault());
    const joined = setThreshold(addSigner(first, { kind: 'injected', address: B, label: 'Sam', canSign: true }), 2);
    const second = await roundTrip(joined);
    expect(second.signers).toHaveLength(2);
    expect(second.threshold).toBe(2);
    // Sam joined, so the pending invite for Sam is gone — not listed twice.
    expect(second.plannedMembers?.map((m) => m.name)).toEqual(['Jo']);
  });

  it('keeps a deployed vault pointing at the same Safe', async () => {
    const deployed: Session = {
      ...vault(),
      signers: [{ kind: 'injected', address: A, label: 'Alex', canSign: false }],
      safeAddress: B,
      deployed: true,
      saltNonce: '12345',
    };
    const decoded = await roundTrip(deployed);
    expect(decoded.safeAddress).toBe(B);
    expect(decoded.deployed).toBe(true);
    expect(decoded.saltNonce).toBe('12345');
    expect(decoded.mode).toBe('existing');
  });

  it('refuses a payload that is truncated or not ours', async () => {
    const payload = await encodeSharePayload(vault());
    // A chat client cutting the tail off is the realistic failure.
    await expect(decodeSharePayload(payload.slice(0, payload.length - 10))).rejects.toBeInstanceOf(ShareFormatError);
    await expect(decodeSharePayload('not*base64url')).rejects.toBeInstanceOf(ShareFormatError);
    await expect(decodeSharePayload('A')).rejects.toBeInstanceOf(ShareFormatError);

    // Right shape, wrong version byte.
    const bytes = Uint8Array.from(atob(payload.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    bytes[0] = 9;
    const bin = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
    const bad = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await expect(decodeSharePayload(bad)).rejects.toBeInstanceOf(ShareFormatError);
  });

  it('rejects an injected payload with a bad address or an absurd member list', async () => {
    const craft = async (compact: unknown): Promise<string> => {
      const json = new TextEncoder().encode(JSON.stringify(compact));
      const { deflateRaw } = await import('../../src/lib/deflate');
      const packed = await deflateRaw(json);
      const out = new Uint8Array(packed.length + 1);
      out[0] = 1;
      out.set(packed, 1);
      const bin = Array.from(out, (b) => String.fromCharCode(b)).join('');
      return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    };

    await expect(decodeSharePayload(await craft({ m: [], o: [['0xzz', 'x']], t: 1 }))).rejects.toBeInstanceOf(
      ShareFormatError,
    );
    const many = Array.from({ length: 140 }, (_, i) => `M${i}`);
    await expect(decodeSharePayload(await craft({ m: many, o: [], t: 1 }))).rejects.toBeInstanceOf(ShareFormatError);
    await expect(decodeSharePayload(await craft({ m: [], o: [], t: 0 }))).rejects.toBeInstanceOf(ShareFormatError);
  });

  it('pins how many joined owners actually fit a 2048-character link', async () => {
    // Random addresses: real ones are high-entropy, so this is the honest cost.
    const rnd = (i: number): `0x${string}` => {
      const b = new Uint8Array(20);
      crypto.getRandomValues(b);
      b[0] = i & 0xff;
      b[1] = (i >> 8) & 0xff;
      return `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}` as `0x${string}`;
    };
    const build = (owners: number): Session => {
      let s = setVaultName(newSession('create'), 'The Novaks');
      for (let i = 0; i < owners; i += 1) {
        s = addSigner(s, { kind: 'injected', address: rnd(i), label: `Member ${i}`, canSign: false });
      }
      return setThreshold(s, 1);
    };

    // Measured: ~33.5 characters per joined owner, so the 2048 budget ends near 57.
    // A realistic family vault is an order of magnitude smaller.
    const origin = 'https://safelyfy.example';
    const small = await createInviteLink(origin, '/', vault());
    expect(small.length).toBeLessThan(400);

    if (small.length > MAX_SHARE_URL_LENGTH) return;
    const at50 = await createInviteLink(origin, '/', build(50));
    expect(at50.length).toBeLessThanOrEqual(MAX_SHARE_URL_LENGTH);
    await expect(createInviteLink(origin, '/', build(60))).rejects.toBeInstanceOf(ShareTooLarge);

    // The number the UI shows must match what the encoder actually allows, within
    // the few characters DEFLATE's block boundaries move between runs (measured
    // 57-57 across runs, 58 refused every time) — otherwise the hint would lie.
    const predicted = ownersPerLink(origin, '/');
    expect(predicted).toBeGreaterThanOrEqual(54);
    expect(predicted).toBeLessThanOrEqual(58);

    // 58 owners must be refused, not merely near the line: capacity below 2048 is
    // the whole point of the guard, and a compressor change could quietly erode it.
    await expect(createInviteLink(origin, '/', build(58))).rejects.toBeInstanceOf(ShareTooLarge);
  });

  it('throws rather than returning a link too long to forward intact', async () => {
    const payload = await encodeSharePayload(vault());
    // A long path is enough to cross the budget with an unchanged payload.
    const longPath = `/${'p'.repeat(MAX_SHARE_URL_LENGTH)}`;
    expect(() => assembleInviteLink('https://x.example', longPath, payload)).toThrow(ShareTooLarge);
    expect(assembleInviteLink('https://x.example', '/', payload).length).toBeLessThan(MAX_SHARE_URL_LENGTH);
  });

  it('parses only the invite fragment shape', () => {
    const payload = 'AbCd-_12';
    expect(parseInviteLink(`https://x.example/#/invite/${payload}`)).toBe(payload);
    expect(parseInviteLink('https://x.example/')).toBeNull();
    expect(parseInviteLink('https://x.example/#/share/abc')).toBeNull();
    expect(parseInviteLink('not a url')).toBeNull();
    expect(parseInviteLink('https://x.example/#/invite/')).toBeNull();
  });
});
