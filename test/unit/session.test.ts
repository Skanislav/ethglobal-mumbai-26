import { describe, expect, it } from 'bun:test';
import {
  addSigner,
  decodeSession,
  encodeSession,
  newSession,
  normalizeSignerAvailability,
  removeSigner,
  setThreshold,
} from '../../src/lib/session';
import type { Session } from '../../src/lib/session';
import type { SignerRecord } from '../../src/lib/signer-types';

const A = '0x1111111111111111111111111111111111111111' as const;
const B = '0x2222222222222222222222222222222222222222' as const;
const C = '0x3333333333333333333333333333333333333333' as const;

function base(mode: 'create' | 'existing' = 'create'): Session {
  return newSession(mode);
}

function withSigners(...records: SignerRecord[]): Session {
  return records.reduce((acc, r) => addSigner(acc, r), base());
}

const injected = (address: `0x${string}`, label = 'Wallet'): SignerRecord => ({
  kind: 'injected',
  address,
  label,
  canSign: true,
});

const trezor = (address: `0x${string}`): SignerRecord => ({
  kind: 'trezor',
  address,
  label: 'Trezor',
  canSign: true,
  path: "44'/60'/0'/0/7",
});

describe('session codec', () => {
  it('round-trips a session including a trezor path', () => {
    const session = setThreshold(withSigners(injected(A), trezor(B)), 2);
    const decoded = decodeSession(encodeSession(session));

    expect(decoded.signers).toHaveLength(2);
    const restored = decoded.signers.find((s) => s.kind === 'trezor');
    expect(restored && 'path' in restored ? restored.path : null).toBe("44'/60'/0'/0/7");
    expect(decoded.threshold).toBe(2);
    expect(decoded.chainId).toBe(11155111);
  });

  it('round-trips a pending transaction with signatures', () => {
    const session: Session = {
      ...setThreshold(withSigners(injected(A), injected(B)), 1),
      safeAddress: C,
      deployed: true,
      pending: {
        to: A,
        value: '0',
        data: '0x',
        operation: 0,
        safeTxGas: '0',
        baseGas: '0',
        gasPrice: '0',
        gasToken: '0x0000000000000000000000000000000000000000',
        refundReceiver: '0x0000000000000000000000000000000000000000',
        nonce: 3,
        safeTxHash: `0x${'ab'.repeat(32)}`,
        signatures: { [A.toLowerCase()]: { blob: `0x${'cd'.repeat(65)}`, isContract: false } },
      },
    };
    const decoded = decodeSession(encodeSession(session));
    expect(decoded.pending?.nonce).toBe(3);
    expect(decoded.pending?.signatures[A.toLowerCase()]?.isContract).toBe(false);
  });

  it('rejects an unknown version', () => {
    const blob = encodeSession(withSigners(injected(A)));
    const parsed = JSON.parse(atob(blob.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
    parsed.version = 2;
    const bad = Buffer.from(JSON.stringify(parsed)).toString('base64url');
    expect(() => decodeSession(bad)).toThrow(/version/);
  });

  it('rejects a wrong chain id', () => {
    const parsed = JSON.parse(
      atob(encodeSession(withSigners(injected(A))).replace(/-/g, '+').replace(/_/g, '/')),
    ) as Record<string, unknown>;
    parsed.chainId = 1;
    const bad = Buffer.from(JSON.stringify(parsed)).toString('base64url');
    expect(() => decodeSession(bad)).toThrow(/chainId/);
  });

  it('rejects case-insensitively duplicate owners', () => {
    const parsed = JSON.parse(
      atob(encodeSession(withSigners(injected(A))).replace(/-/g, '+').replace(/_/g, '/')),
    ) as Record<string, unknown>;
    parsed.signers = [
      { kind: 'injected', address: A, label: 'a', canSign: true },
      { kind: 'injected', address: A.toUpperCase().replace('0X', '0x'), label: 'b', canSign: true },
    ];
    const bad = Buffer.from(JSON.stringify(parsed)).toString('base64url');
    expect(() => decodeSession(bad)).toThrow(/duplicate owner/);
  });

  it('rejects a threshold above the owner count and a zero threshold', () => {
    const session = withSigners(injected(A), injected(B));
    for (const threshold of [0, 3]) {
      const parsed = JSON.parse(
        atob(encodeSession(session).replace(/-/g, '+').replace(/_/g, '/')),
      ) as Record<string, unknown>;
      parsed.threshold = threshold;
      const bad = Buffer.from(JSON.stringify(parsed)).toString('base64url');
      expect(() => decodeSession(bad)).toThrow(/threshold/);
    }
  });

  it('rejects a malformed owner address', () => {
    const parsed = JSON.parse(
      atob(encodeSession(withSigners(injected(A))).replace(/-/g, '+').replace(/_/g, '/')),
    ) as Record<string, unknown>;
    parsed.signers = [{ kind: 'injected', address: '0xnothex', label: 'a', canSign: true }];
    const bad = Buffer.from(JSON.stringify(parsed)).toString('base64url');
    expect(() => decodeSession(bad)).toThrow(/address/);
  });

  it('rejects garbage input', () => {
    expect(() => decodeSession('not-a-session')).toThrow(/InvalidSession/);
    expect(() => decodeSession('')).toThrow(/InvalidSession/);
  });
});

describe('session mutations', () => {
  it('keeps an ephemeral owner but drops its signature claim when the tab key is gone', () => {
    const session = withSigners(injected(A), {
      kind: 'ephemeral',
      address: B,
      label: 'Demo key',
      canSign: true,
    });
    const normalized = normalizeSignerAvailability(session);
    const ephemeral = normalized.signers.find((s) => s.address === B);
    expect(ephemeral?.canSign).toBe(false);
    expect(normalized.signers).toHaveLength(2);
  });

  it('clamps the threshold when the last signer is removed', () => {
    const session = setThreshold(withSigners(injected(A), injected(B)), 2);
    const after = removeSigner(session, B);
    expect(after.signers).toHaveLength(1);
    expect(after.threshold).toBe(1);
  });

  it('clamps the threshold into 1..count', () => {
    const session = withSigners(injected(A), injected(B));
    expect(setThreshold(session, 0).threshold).toBe(1);
    expect(setThreshold(session, 9).threshold).toBe(2);
  });

  it('rejects adding the same owner twice', () => {
    // Same bytes, different input casing.
    const lower = '0xabcdef0123456789abcdef0123456789abcdef01' as `0x${string}`;
    const mixed = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01' as `0x${string}`;
    const stored = addSigner(base(), injected(lower));
    expect(() => addSigner(stored, injected(mixed))).toThrow(/DuplicateOwner/);
  });

  it('upgrades an address-only owner to a signable one in place', () => {
    const imported = addSigner(base('existing'), { kind: 'injected', address: A, label: 'Existing owner', canSign: false });
    const upgraded = addSigner(imported, injected(A, 'My wallet'));
    expect(upgraded.signers).toHaveLength(1);
    expect(upgraded.signers[0].canSign).toBe(true);
    expect(upgraded.signers[0].label).toBe('My wallet');
  });
});
