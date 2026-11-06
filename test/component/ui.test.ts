// Component tests. These run under vitest with `resolve.conditions: ['browser']`;
// plain `bun test` cannot mount Svelte components (no browser export condition).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount, tick } from 'svelte';
import ModeStep from '../../src/lib/components/ModeStep.svelte';
import SignerStep from '../../src/lib/components/SignerStep.svelte';
import ThresholdStep from '../../src/lib/components/ThresholdStep.svelte';
import SessionProbe from '../fixtures/SessionProbe.svelte';
import { privateReads, privateReadsLabel } from '../../src/lib/privateReads.svelte';
import { readRouter, setReadRouter } from '../../src/lib/readRouter';
import { session, setSession } from '../../src/lib/session.svelte';
import { decodeSession, newSession } from '../../src/lib/session';
import type { SignerRecord } from '../../src/lib/signer-types';

// The NFC driver talks to real hardware, so the tap is stubbed at the module
// boundary; everything above it (status text, owner record shape) stays real code.
const haloStub = vi.hoisted(() => ({
  available: false,
  publicKey: '0x04a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6' as `0x${string}`,
  address: '0x3333333333333333333333333333333333333333' as `0x${string}`,
}));

vi.mock('../../src/lib/signers/halo', () => ({
  haloAvailable: () => haloStub.available,
  readHaloPublicKey: async () => haloStub.publicKey,
  haloSignerAddress: async () => haloStub.address,
  haloStatusText: (status: string) => `status:${status}`,
  describeHaloFailure: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

function mountAt(component: Parameters<typeof mount>[0], props: Record<string, unknown> = {}) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const instance = mount(component, { target, props });
  return { target, destroy: () => unmount(instance) };
}

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  setSession(newSession('create'));
  privateReads.enabled = true;
  privateReads.status = 'ready';
  privateReads.reason = null;
  setReadRouter(null);
});

const NOOP_SIGNER_HANDLERS = {
  onAdd: () => {},
  onRemove: () => {},
  onCreatePasskey: async (): Promise<SignerRecord> => ({
    kind: 'injected',
    address: '0x0000000000000000000000000000000000000001',
    label: 'stub',
    canSign: true,
  }),
  onDeviceAddress: async (kind: 'ledger' | 'trezor'): Promise<SignerRecord> =>
    kind === 'ledger'
      ? { kind: 'ledger', address: '0x0000000000000000000000000000000000000001', label: 'Ledger', canSign: true, path: "44'/60'/0'/0/0" }
      : { kind: 'trezor', address: '0x0000000000000000000000000000000000000001', label: 'Trezor', canSign: true, path: "44'/60'/0'/0/0" },
  onDeviceScan: async (): Promise<{ path: string; address: `0x${string}` }[]> => [],
};

describe('ModeStep', () => {
  it('offers both the create and existing paths', () => {
    const { target, destroy } = mountAt(ModeStep, { onChoose: () => {}, onExisting: async () => {} });
    const labels = Array.from(target.querySelectorAll('button')).map((b) => b.textContent?.trim());
    expect(labels).toContain('Create a new Safe');
    expect(labels).toContain('Open existing Safe');
    destroy();
  });

  it('shows an unavailable sandbox instead of hiding it', async () => {
    privateReads.status = 'unavailable';
    privateReads.reason = 'bundle hash mismatch';
    const { target, destroy } = mountAt(ModeStep, { onChoose: () => {}, onExisting: async () => {} });
    await tick();
    expect(target.textContent).toContain('Reads: plain (gateway sees traffic)');
    expect(target.textContent).toContain('Private reads unavailable');
    expect(target.textContent).toContain('bundle hash mismatch');
    destroy();
  });

  it('labels a working sandbox as private and names the specifier', async () => {
    const { target, destroy } = mountAt(ModeStep, { onChoose: () => {}, onExisting: async () => {} });
    await tick();
    expect(target.textContent).toContain('Reads: private (anon-rpc)');
    expect(target.textContent).toContain('0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A');
    destroy();
  });

  it('rejects an ENS name with an explanation and never calls through', async () => {
    const onExisting = vi.fn(async () => {});
    const { target, destroy } = mountAt(ModeStep, { onChoose: () => {}, onExisting });
    const input = target.querySelector<HTMLInputElement>('#existing-safe')!;
    input.value = 'alice.eth';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    Array.from(target.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Open existing Safe'))!
      .click();
    await tick();
    expect(onExisting).not.toHaveBeenCalled();
    expect(target.textContent).toContain('ENS names are out of scope');
    destroy();
  });
});

describe('SignerStep', () => {
  it('disables the injected tile with the reason when no wallet exists', async () => {
    const { target, destroy } = mountAt(SignerStep, { signers: [], ...NOOP_SIGNER_HANDLERS });
    await tick();
    const injected = Array.from(target.querySelectorAll('li.tile')).find((t) =>
      t.textContent?.includes('Browser wallet'),
    )!;
    expect(injected.querySelector('button')!.disabled).toBe(true);
    expect(injected.textContent).toContain('No wallet detected in this browser.');
    destroy();
  });

  it('leaves the Trezor tile enabled with no availability gate', async () => {
    const { target, destroy } = mountAt(SignerStep, { signers: [], ...NOOP_SIGNER_HANDLERS });
    await tick();
    const trezor = Array.from(target.querySelectorAll('li.tile')).find((t) => t.textContent?.includes('Trezor'))!;
    expect(trezor.querySelector('button')!.disabled).toBe(false);
    expect(trezor.querySelector('.reason')).toBeNull();
    // No account list until the user actually scans the device.
    expect(trezor.textContent).not.toContain('Account 0');
    destroy();
  });

  it('lists discovered device accounts instead of guessing one path', async () => {
    const accounts = [
      { path: "44'/60'/0'/0/0", account: 0, address: '0x1111111111111111111111111111111111111111' },
      { path: "44'/60'/1'/0/0", account: 1, address: '0x2222222222222222222222222222222222222222' },
    ];
    // Balances are a normal read, so they go through the routing seam; the second
    // account's read fails, which must show as "balance unknown", not disappear.
    setReadRouter({
      request: async ({ params }) => {
        const address = Array.isArray(params) ? String(params[0]) : '';
        if (address.toLowerCase() === accounts[1].address) throw new Error('gateway down');
        return '0x0';
      },
    });
    const onDeviceAddress = vi.fn(async (kind: 'ledger' | 'trezor', path: string): Promise<SignerRecord> => ({
      kind,
      address: '0x1111111111111111111111111111111111111111',
      label: 'Trezor',
      canSign: true,
      path,
    }));
    const { promise, resolve } = Promise.withResolvers<void>();
    // The scan resolves only after balances are read, so this is the signal to await.
    const onDeviceScan = vi.fn(() => {
      resolve();
      return Promise.resolve(accounts);
    });
    const { target, destroy } = mountAt(SignerStep, {
      signers: [],
      ...NOOP_SIGNER_HANDLERS,
      onDeviceScan,
      onDeviceAddress,
    });
    await tick();
    const trezor = Array.from(target.querySelectorAll('li.tile')).find((t) => t.textContent?.includes('Trezor'))!;
    (trezor.querySelector('button') as HTMLButtonElement).click();
    await promise;
    await vi.waitFor(() => expect(trezor.textContent).toContain('Account 1'));
    expect(onDeviceScan).toHaveBeenCalledWith('trezor');
    expect(trezor.textContent).toContain("m/44'/60'/1'/0/0");
    expect(trezor.textContent).toContain('no Sepolia ETH');
    expect(trezor.textContent).toContain('balance unknown');
    destroy();
  });

  it('marks a demo-key owner set TESTNET ONLY', async () => {
    const { target, destroy } = mountAt(SignerStep, {
      signers: [
        { kind: 'ephemeral', address: '0x1111111111111111111111111111111111111111', label: 'Demo key', canSign: true },
      ],
      ...NOOP_SIGNER_HANDLERS,
    });
    await tick();
    expect(target.textContent).toContain('TESTNET ONLY');
    destroy();
  });

  it('registers a tapped chip as a signable owner with its public key', async () => {
    haloStub.available = true;
    const onAdd = vi.fn();
    const { target, destroy } = mountAt(SignerStep, { signers: [], ...NOOP_SIGNER_HANDLERS, onAdd });
    await tick();
    const halo = Array.from(target.querySelectorAll('li.tile')).find((t) => t.textContent?.includes('HaLo'))!;
    const scanButton = Array.from(halo.querySelectorAll('button')).find((b) => b.textContent?.includes('Scan chip'))!;
    expect(scanButton.disabled).toBe(false);
    scanButton.click();
    await vi.waitFor(() => expect(onAdd).toHaveBeenCalled());
    // The tap yields the key, so the owner can actually sign; a pasted address cannot.
    expect(onAdd).toHaveBeenCalledWith({
      kind: 'halo',
      address: haloStub.address,
      label: 'HaLo chip',
      canSign: true,
      publicKey: haloStub.publicKey,
    });
    haloStub.available = false;
    destroy();
  });

  it('marks the chip tile unavailable and names a compatible device when Web NFC is missing', async () => {
    const { target, destroy } = mountAt(SignerStep, { signers: [], ...NOOP_SIGNER_HANDLERS });
    await tick();
    const halo = Array.from(target.querySelectorAll('li.tile')).find((t) => t.textContent?.includes('HaLo'))!;
    // Desktop browsers ship no Web NFC: the option stays visible but reads as unavailable.
    expect(halo.classList.contains('unavailable')).toBe(true);
    expect(halo.querySelector('button')!.disabled).toBe(true);
    expect(halo.textContent).toContain('Web NFC is not available in this browser');
    expect(halo.textContent).toContain('Chrome on Android');
    expect(halo.textContent).toContain('cannot sign here');
    destroy();
  });

  it('shows an address-only owner as unable to sign here', async () => {
    const { target, destroy } = mountAt(SignerStep, {
      signers: [
        { kind: 'halo', address: '0x2222222222222222222222222222222222222222', label: 'HaLo chip', canSign: false },
      ],
      ...NOOP_SIGNER_HANDLERS,
    });
    await tick();
    expect(target.textContent).toContain('cannot sign here');
    destroy();
  });
});

describe('ThresholdStep', () => {
  it('clamps an out-of-range threshold down to the owner count', async () => {
    const onThreshold = vi.fn();
    const { target, destroy } = mountAt(ThresholdStep, { count: 3, threshold: 2, onThreshold });
    await tick();
    const input = target.querySelector<HTMLInputElement>('#threshold')!;
    input.value = '9';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(onThreshold).toHaveBeenCalledWith(3);
    destroy();
  });

  it('clamps a zero threshold up to one', async () => {
    const onThreshold = vi.fn();
    const { target, destroy } = mountAt(ThresholdStep, { count: 3, threshold: 2, onThreshold });
    await tick();
    const input = target.querySelector<HTMLInputElement>('#threshold')!;
    input.value = '0';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(onThreshold).toHaveBeenCalledWith(1);
    destroy();
  });

  it('states the consequence in plain words and warns about a single-key setup', async () => {
    const { target, destroy } = mountAt(ThresholdStep, { count: 3, threshold: 1, onThreshold: () => {} });
    await tick();
    expect(target.textContent).toContain('Any one of these 3 can move the funds alone.');
    expect(target.textContent).toContain('single-key wallet');
    destroy();
  });
});

describe('shared module state', () => {
  it('is observed by every mounted component at once', async () => {
    const a = mountAt(SessionProbe);
    const b = mountAt(SessionProbe);
    await tick();
    expect(a.target.textContent).toContain('count=0');

    setSession({
      ...newSession('create'),
      signers: [
        { kind: 'injected', address: '0x1111111111111111111111111111111111111111', label: 'A', canSign: true },
        { kind: 'injected', address: '0x2222222222222222222222222222222222222222', label: 'B', canSign: true },
      ],
      threshold: 2,
    });
    await tick();

    for (const { target } of [a, b]) expect(target.textContent).toContain('count=2 threshold=2');
    expect(session.current.signers).toHaveLength(2);
    a.destroy();
    b.destroy();
  });

  it('persists each mutation so a reload sees the same session', async () => {
    const owner = '0x1111111111111111111111111111111111111111' as const;
    setSession({
      ...newSession('create'),
      signers: [{ kind: 'injected', address: owner, label: 'A', canSign: true }],
      threshold: 1,
    });
    const stored = localStorage.getItem('sso.session.v1');
    expect(stored).not.toBeNull();
    // The stored value is the same encoding as an exported session file, so the
    // decoder that guards pasted input guards stored input too.
    const restored = decodeSession(stored!);
    expect(restored.threshold).toBe(1);
    expect(restored.signers.map((s) => s.address)).toEqual([owner]);
  });
});

describe('read routing', () => {
  it('routes through the sandbox only when one was installed', () => {
    setReadRouter(null);
    expect(readRouter()).toBeNull();
    const fake = { request: async () => '0x1' };
    setReadRouter(fake);
    expect(readRouter()).toBe(fake);
    setReadRouter(null);
  });

  it('labels a disabled toggle as plain, never private', () => {
    privateReads.status = 'ready';
    privateReads.enabled = false;
    expect(privateReadsLabel()).toContain('plain');
  });
});

describe('passkey naming', () => {
  beforeEach(() => {
    // The tile gates on WebAuthn availability; happy-dom has no credentials API.
    Object.defineProperty(navigator, 'credentials', {
      value: { create: async () => null, get: async () => null },
      configurable: true,
    });
  });

  it('passes the typed name to credential creation and defaults it when blank', async () => {
    const names: string[] = [];
    const onCreatePasskey = async (label: string): Promise<SignerRecord> => {
      names.push(label);
      return {
        kind: 'passkey',
        address: `0x${'44'.repeat(20)}`,
        label,
        canSign: true,
        rawId: `0x${'11'.repeat(16)}`,
        coordinates: { x: `0x${'22'.repeat(32)}`, y: `0x${'33'.repeat(32)}` },
        origin: 'https://example.test',
      };
    };
    const added: SignerRecord[] = [];
    const { target, destroy } = mountAt(SignerStep, {
      signers: [],
      onAdd: (r: SignerRecord) => added.push(r),
      onRemove: () => {},
      onRename: () => {},
      onCreatePasskey,
      onDeviceAddress: NOOP_SIGNER_HANDLERS.onDeviceAddress,
    });
    await tick();

    const input = target.querySelector<HTMLInputElement>('input[aria-label="Passkey name"]');
    expect(input).not.toBeNull();
    // The placeholder shows what will be used if the field is left empty.
    expect(input!.placeholder).toBe('Passkey');

    input!.value = 'Phone passkey';
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    Array.from(target.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Create passkey'))!
      .click();
    await new Promise((r) => setTimeout(r, 20));

    expect(names).toEqual(['Phone passkey']);
    expect(added[0]?.label).toBe('Phone passkey');
    destroy();
  });

  it('numbers a second passkey so owners stay distinguishable', async () => {
    const onCreatePasskey = async (label: string): Promise<SignerRecord> => ({
      kind: 'passkey',
      address: `0x${'55'.repeat(20)}`,
      label,
      canSign: true,
      rawId: `0x${'11'.repeat(16)}`,
      coordinates: { x: `0x${'22'.repeat(32)}`, y: `0x${'33'.repeat(32)}` },
      origin: 'https://example.test',
    });
    const { target, destroy } = mountAt(SignerStep, {
      signers: [
        {
          kind: 'passkey',
          address: `0x${'44'.repeat(20)}`,
          label: 'Passkey',
          canSign: true,
          rawId: `0x${'11'.repeat(16)}`,
          coordinates: { x: `0x${'22'.repeat(32)}`, y: `0x${'33'.repeat(32)}` },
          origin: 'https://example.test',
        },
      ],
      onAdd: () => {},
      onRemove: () => {},
      onRename: () => {},
      onCreatePasskey,
      onDeviceAddress: NOOP_SIGNER_HANDLERS.onDeviceAddress,
    });
    await tick();
    const input = target.querySelector<HTMLInputElement>('input[aria-label="Passkey name"]')!;
    expect(input.placeholder).toBe('Passkey 2');
    destroy();
  });

  it('sends a rename for an existing owner', async () => {
    const renamed: Array<[string, string]> = [];
    const { target, destroy } = mountAt(SignerStep, {
      signers: [
        { kind: 'injected', address: '0x1111111111111111111111111111111111111111', label: 'Wallet', canSign: true },
      ],
      onAdd: () => {},
      onRemove: () => {},
      onRename: (address: string, label: string) => renamed.push([address, label]),
      ...NOOP_SIGNER_HANDLERS,
    });
    await tick();
    const input = target.querySelector<HTMLInputElement>('input[aria-label^="Name for"]')!;
    expect(input.value).toBe('Wallet');
    input.value = 'Alice';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(renamed).toEqual([['0x1111111111111111111111111111111111111111', 'Alice']]);
    destroy();
  });
});

describe('private-read status reporting', () => {
  it('says plainly when the sandbox is still starting, and never claims private', async () => {
    privateReads.enabled = true;
    privateReads.status = 'pending';
    privateReads.reason = null;
    const { target, destroy } = mountAt(SignerStep, {
      signers: [],
      onAdd: () => {},
      onRemove: () => {},
      onRename: () => {},
      ...NOOP_SIGNER_HANDLERS,
    });
    await tick();
    expect(target.textContent).toContain('plain gateway');
    expect(target.textContent).toContain('still starting');
    destroy();
  });

  it('reports the reason private reads are unavailable', async () => {
    privateReads.enabled = true;
    privateReads.status = 'unavailable';
    privateReads.reason = 'sepolia.drpc.org returned HTTP 400 — chain is not available on free plan';
    const { target, destroy } = mountAt(SignerStep, {
      signers: [],
      onAdd: () => {},
      onRemove: () => {},
      onRename: () => {},
      ...NOOP_SIGNER_HANDLERS,
    });
    await tick();
    expect(target.textContent).toContain('plain gateway');
    expect(target.textContent).toContain('chain is not available on free plan');
    destroy();
  });
});
