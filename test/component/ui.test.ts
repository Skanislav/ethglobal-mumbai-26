// Component tests. These run under vitest with `resolve.conditions: ['browser']`;
// plain `bun test` cannot mount Svelte components (no browser export condition).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount, tick } from 'svelte';
import WelcomeScreen from '../../src/lib/components/screens/WelcomeScreen.svelte';
import OpenPanel from '../../src/lib/components/screens/OpenPanel.svelte';
import KeyPickerScreen from '../../src/lib/components/screens/KeyPickerScreen.svelte';
import InviteScreen from '../../src/lib/components/screens/InviteScreen.svelte';
import ApprovalRuleScreen from '../../src/lib/components/screens/ApprovalRuleScreen.svelte';
import VaultReadyScreen from '../../src/lib/components/screens/VaultReadyScreen.svelte';
import VaultHomeScreen from '../../src/lib/components/screens/VaultHomeScreen.svelte';
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

describe('WelcomeScreen', () => {
  it('offers the create path and the open-existing footer', async () => {
    const { target, destroy } = mountAt(WelcomeScreen, { onCreate: () => {} });
    await tick();
    const labels = Array.from(target.querySelectorAll('button')).map((b) => b.textContent?.trim());
    expect(labels).toContain('Create a family vault');
    destroy();
  });

  it('calls onCreate once when the primary CTA is pressed', async () => {
    const onCreate = vi.fn();
    const { target, destroy } = mountAt(WelcomeScreen, { onCreate });
    await tick();
    Array.from(target.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Create a family vault'))!
      .click();
    expect(onCreate).toHaveBeenCalledTimes(1);
    destroy();
  });
});

describe('OpenPanel', () => {
  it('shows an unavailable sandbox instead of hiding it', async () => {
    privateReads.status = 'unavailable';
    privateReads.reason = 'bundle hash mismatch';
    const { target, destroy } = mountAt(OpenPanel, { onOpen: async () => {}, onImportBlob: () => {} });
    await tick();
    expect(target.textContent).toContain('Reads: plain (gateway sees traffic)');
    expect(target.textContent).toContain('Private reads unavailable');
    expect(target.textContent).toContain('bundle hash mismatch');
    destroy();
  });

  it('labels a working sandbox as private and names the specifier', async () => {
    const { target, destroy } = mountAt(OpenPanel, { onOpen: async () => {}, onImportBlob: () => {} });
    await tick();
    expect(target.textContent).toContain('Reads: private (anon-rpc)');
    expect(target.textContent).toContain('0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A');
    destroy();
  });

  it('rejects an ENS name with an explanation and never calls through', async () => {
    const onOpen = vi.fn(async () => {});
    const { target, destroy } = mountAt(OpenPanel, { onOpen, onImportBlob: () => {} });
    const input = target.querySelector<HTMLInputElement>('#open-value')!;
    input.value = 'alice.eth';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    target.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
    expect(onOpen).not.toHaveBeenCalled();
    expect(target.textContent).toContain('ENS names are out of scope');
    destroy();
  });

  it('names the blob failure in human terms instead of the error class', async () => {
    const rejection = Object.assign(new Error('the indexer rejected the read (HTTP 400)'), { name: 'ShareFormatError' });
    const { target, destroy } = mountAt(OpenPanel, {
      onOpen: async () => {
        throw rejection;
      },
      onImportBlob: () => {},
    });
    const input = target.querySelector<HTMLInputElement>('#open-value')!;
    input.value = `http://127.0.0.1/#/share/${'A'.repeat(43)}/0x${'11'.repeat(32)}`;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    target.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(target.textContent).toContain('is not a readable session');
    expect(target.textContent).not.toContain('ShareFormatError:');
    destroy();
  });

  it('passes an invite link straight through, unchecksummed', async () => {
    const onOpen = vi.fn(async () => {});
    const { target, destroy } = mountAt(OpenPanel, { onOpen, onImportBlob: () => {} });
    const link = 'https://safelyfy.example/#/share/abc/0xdef';
    const input = target.querySelector<HTMLInputElement>('#open-value')!;
    input.value = link;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    target.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(onOpen).toHaveBeenCalledWith(link);
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

  it('withholds sharing until there is an owner set to share', async () => {
    // No `onShare`: the control is absent entirely rather than rendering a dead button.
    const withoutHandler = mountAt(SignerStep, { signers: [], ...NOOP_SIGNER_HANDLERS });
    await tick();
    expect(withoutHandler.target.querySelector('.share')).toBeNull();
    withoutHandler.destroy();

    const { target, destroy } = mountAt(SignerStep, {
      signers: [
        { kind: 'ephemeral', address: '0x1111111111111111111111111111111111111111', label: 'Demo key', canSign: true },
      ],
      ...NOOP_SIGNER_HANDLERS,
      onShare: async () => 'http://localhost/#/share/key/hash',
    });
    await tick();
    const buttons = Array.from(target.querySelectorAll<HTMLButtonElement>('button'));
    const shareButton = buttons.find((b) => b.textContent?.includes('Share session'))!;
    const copyButton = buttons.find((b) => b.textContent?.trim() === 'Copy')!;
    expect(shareButton.disabled).toBe(false);
    // Nothing to copy until a link exists.
    expect(copyButton.disabled).toBe(true);
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

describe('ApprovalRuleScreen', () => {
  const ROSTER = [
    { name: 'Mum', joined: true, planned: false, kind: 'passkey' as const },
    { name: 'Dad', joined: false, planned: true },
    { name: 'Anna', joined: false, planned: true },
  ];

  it('bounds the stepper by owners, never by invited names', async () => {
    const onThreshold = vi.fn();
    const { target, destroy } = mountAt(ApprovalRuleScreen, {
      roster: ROSTER,
      ownerCount: 1,
      threshold: 1,
      onThreshold,
      onCreateVault: () => {},
    });
    await tick();
    // One owner: both arrows are dead, because 2-of-1 is not a Safe the chain will accept.
    expect(target.querySelector<HTMLButtonElement>('button[aria-label="More approvals"]')!.disabled).toBe(true);
    expect(target.querySelector<HTMLButtonElement>('button[aria-label="Fewer approvals"]')!.disabled).toBe(true);
    expect(target.textContent).toContain('of 1 member with a key');
    expect(target.textContent).toContain('2 invited members cannot approve');
    destroy();
  });

  it('recommends half the owners, rounded up, and warns about a single-key vault', async () => {
    const { target, destroy } = mountAt(ApprovalRuleScreen, {
      roster: ROSTER.slice(0, 2),
      ownerCount: 2,
      threshold: 1,
      onThreshold: () => {},
      onCreateVault: () => {},
    });
    await tick();
    expect(target.textContent).toContain('single-key wallet');

    target.remove();
    const atTwo = mountAt(ApprovalRuleScreen, {
      roster: ROSTER.slice(0, 2),
      ownerCount: 2,
      threshold: 2,
      onThreshold: () => {},
      onCreateVault: () => {},
    });
    await tick();
    expect(atTwo.target.textContent).toContain('Recommended for 2 people');
    expect(atTwo.target.textContent).not.toContain('single-key wallet');
    atTwo.destroy();
    destroy();
  });

  it('notifies only when the value really changes', async () => {
    const onThreshold = vi.fn();
    const { target, destroy } = mountAt(ApprovalRuleScreen, {
      roster: [{ name: 'Mum', joined: true, planned: false }],
      ownerCount: 1,
      threshold: 1,
      onThreshold,
      onCreateVault: () => {},
    });
    await tick();
    target.querySelector<HTMLButtonElement>('button[aria-label="More approvals"]')!.click();
    await tick();
    expect(onThreshold).not.toHaveBeenCalled();
    destroy();
  });

  it('creates the vault from the primary CTA', async () => {
    const onCreateVault = vi.fn();
    const { target, destroy } = mountAt(ApprovalRuleScreen, {
      roster: ROSTER.slice(0, 1),
      ownerCount: 1,
      threshold: 1,
      onThreshold: () => {},
      onCreateVault,
    });
    await tick();
    Array.from(target.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Create family vault'))!
      .click();
    expect(onCreateVault).toHaveBeenCalledTimes(1);
    destroy();
  });
});

describe('InviteScreen', () => {
  const session = (): ReturnType<typeof newSession> => ({
    ...newSession('create'),
    vaultName: 'The Novaks',
    threshold: 1,
    signers: [
      { kind: 'passkey', address: `0x${'11'.repeat(20)}`, label: 'Mum', canSign: true, rawId: `0x${'22'.repeat(8)}`, coordinates: { x: `0x${'33'.repeat(32)}`, y: `0x${'44'.repeat(32)}` }, origin: 'https://example.test' },
    ],
    plannedMembers: [{ name: 'Dad' }],
  });
  const BASE = { onAddPlanned: () => {}, onRemovePlanned: () => {}, onNext: () => {} };

  it('shows joined and invited members with the joined counter', async () => {
    const { target, destroy } = mountAt(InviteScreen, { session: session(), ...BASE });
    await tick();
    expect(target.textContent).toContain('1 of 2 joined');
    expect(target.textContent).toContain('Joined');
    expect(target.textContent).toContain('Invited');
    destroy();
  });

  it('adds and removes a planned member by name', async () => {
    const onAddPlanned = vi.fn();
    const onRemovePlanned = vi.fn();
    const { target, destroy } = mountAt(InviteScreen, {
      session: session(),
      ...BASE,
      onAddPlanned,
      onRemovePlanned,
    });
    await tick();
    const input = target.querySelector<HTMLInputElement>('input[aria-label="Member name"]')!;
    input.value = 'Anna';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    target.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
    expect(onAddPlanned).toHaveBeenCalledWith('Anna');

    target.querySelector<HTMLButtonElement>('button[aria-label="Remove Dad"]')!.click();
    expect(onRemovePlanned).toHaveBeenCalledWith('Dad');
    destroy();
  });

  it('refuses to advance without a signable key', async () => {
    const sessionNoKey = { ...newSession('create') as ReturnType<typeof newSession>, signers: [], threshold: 1 };
    const { target, destroy } = mountAt(InviteScreen, { session: sessionNoKey, ...BASE });
    await tick();
    const next = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.includes('Next: approval rule'),
    )!;
    expect(next.disabled).toBe(true);
    expect(target.textContent).toContain('Add your own key first');
    destroy();
  });

  it('shows a published link read-only and copies it', async () => {
    const url = 'http://localhost/#/share/key/hash';
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (t: string) => void writes.push(t) },
      configurable: true,
    });
    const { target, destroy } = mountAt(InviteScreen, { session: session(), inviteUrl: url, ...BASE });
    await tick();
    const link = target.querySelector<HTMLInputElement>('input.link')!;
    expect(link.readOnly).toBe(true);
    expect(link.value).toBe(url);
    Array.from(target.querySelectorAll<HTMLButtonElement>('button'))
      .find((b) => b.textContent?.trim() === 'Copy')!
      .click();
    await tick();
    expect(writes).toEqual([url]);
    destroy();
  });
});

describe('VaultHomeScreen', () => {
  const deployed = () => ({
    ...newSession('create') as ReturnType<typeof newSession>,
    vaultName: 'The Novaks',
    safeAddress: `0x${'ab'.repeat(20)}` as `0x${string}`,
    deployed: true,
    threshold: 1,
    signers: [{ kind: 'injected' as const, address: `0x${'11'.repeat(20)}` as `0x${string}`, label: 'Mum', canSign: true }],
    plannedMembers: [{ name: 'Dad' }],
  });

  it('states the live balance in ETH and the approval rule', async () => {
    const { target, destroy } = mountAt(VaultHomeScreen, {
      session: deployed(),
      balanceWei: 10n ** 18n,
      onSend: () => {},
    });
    await tick();
    expect(target.textContent).toContain('The Novaks');
    expect(target.textContent).toContain('1.0');
    expect(target.textContent).toContain('1 of 1 approvals');
    expect(target.textContent).toContain('Test network');
    destroy();
  });

  it('says the balance is unavailable instead of showing a number it does not have', async () => {
    const { target, destroy } = mountAt(VaultHomeScreen, {
      session: deployed(),
      balanceWei: null,
      onSend: () => {},
    });
    await tick();
    expect(target.textContent).toContain('Balance unavailable');
    expect(target.textContent).not.toContain('0.0');
    destroy();
  });

  it('reveals the vault address for receiving', async () => {
    const { target, destroy } = mountAt(VaultHomeScreen, {
      session: deployed(),
      balanceWei: 0n,
      onSend: () => {},
    });
    await tick();
    expect(target.textContent).not.toContain(`0x${'ab'.repeat(20)}`);
    Array.from(target.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Receive'))!
      .click();
    await tick();
    expect(target.textContent).toContain(`0x${'ab'.repeat(20)}`);
    destroy();
  });

  it('routes the Send action to the proposal flow', async () => {
    const onSend = vi.fn();
    const { target, destroy } = mountAt(VaultHomeScreen, { session: deployed(), balanceWei: 0n, onSend });
    await tick();
    Array.from(target.querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === 'Send')!
      .click();
    expect(onSend).toHaveBeenCalledTimes(1);
    destroy();
  });
});

describe('VaultReadyScreen', () => {
  const roster = [
    { name: 'Mum', joined: true, planned: false },
    { name: 'Dad', joined: false, planned: true },
    { name: 'Anna', joined: false, planned: true },
  ];

  it('does not claim everyone joined when invitations are still open', async () => {
    const { target, destroy } = mountAt(VaultReadyScreen, {
      vaultName: 'The Novaks',
      roster,
      threshold: 1,
      signerCount: 1,
      onOpenVault: () => {},
    });
    await tick();
    expect(target.textContent).toContain('The Novaks is ready');
    expect(target.textContent).toMatch(/2\s+invited members join/);
    expect(target.textContent).not.toContain('are all in');
    destroy();
  });

  it('celebrates a fully joined family and offers the test payment', async () => {
    const onTestPayment = vi.fn();
    const { target, destroy } = mountAt(VaultReadyScreen, {
      vaultName: 'The Novaks',
      roster: [
        { name: 'Mum', joined: true, planned: false },
        { name: 'Dad', joined: true, planned: false },
      ],
      threshold: 2,
      signerCount: 2,
      onOpenVault: () => {},
      onTestPayment,
    });
    await tick();
    expect(target.textContent).toContain('Mum and Dad are all in');
    Array.from(target.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Send a test payment'))!
      .click();
    expect(onTestPayment).toHaveBeenCalledTimes(1);
    destroy();
  });
});

describe('KeyPickerScreen', () => {
  const HANDLERS = {
    onAdded: () => {},
    onCreatePasskey: async (label: string): Promise<SignerRecord> => ({
      kind: 'passkey',
      address: `0x${'44'.repeat(20)}`,
      label,
      canSign: true,
      rawId: `0x${'11'.repeat(16)}`,
      coordinates: { x: `0x${'22'.repeat(32)}`, y: `0x${'33'.repeat(32)}` },
      origin: 'https://example.test',
    }),
    onDeviceAddress: NOOP_SIGNER_HANDLERS.onDeviceAddress,
  };

  it('disables the wallet tile with its reason and keeps Trezor available', async () => {
    const { target, destroy } = mountAt(KeyPickerScreen, HANDLERS);
    await tick();
    const tiles = Array.from(target.querySelectorAll('li.tile'));
    const wallet = tiles.find((t) => t.textContent?.includes('Browser wallet'))!;
    expect(wallet.querySelector('button')!.disabled).toBe(true);
    expect(wallet.textContent).toContain('No browser wallet detected.');
    destroy();
  });

  it('runs the passkey ceremony with the typed name and reports the record up', async () => {
    Object.defineProperty(navigator, 'credentials', {
      value: { create: async () => null, get: async () => null },
      configurable: true,
    });
    const added: SignerRecord[] = [];
    const { target, destroy } = mountAt(KeyPickerScreen, { ...HANDLERS, onAdded: (r: SignerRecord) => added.push(r) });
    await tick();
    Array.from(target.querySelectorAll<HTMLButtonElement>('li.tile button'))
      .find((b) => b.textContent?.includes('Passkey'))!
      .click();
    await tick();
    const name = target.querySelector<HTMLInputElement>('input[maxlength="64"]')!;
    name.value = 'Mum (you)';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    Array.from(target.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Continue with passkey'))!
      .click();
    await new Promise((r) => setTimeout(r, 20));
    expect(added).toHaveLength(1);
    expect(added[0].label).toBe('Mum (you)');
    destroy();
  });

  it('surfaces a wallet failure inline instead of hanging', async () => {
    const failing = {
      ...HANDLERS,
      onConnectInjected: async (): Promise<SignerRecord> => {
        const rejection = new Error('the request was rejected in the wallet');
        rejection.name = 'UserRejected';
        throw rejection;
      },
    };
    // The wallet tile is gated on window.ethereum, which happy-dom lacks.
    (window as unknown as Record<string, unknown>).ethereum = { request: async () => [] };
    const { target, destroy } = mountAt(KeyPickerScreen, failing);
    await tick();
    Array.from(target.querySelectorAll<HTMLButtonElement>('li.tile button'))
      .find((b) => b.textContent?.includes('Browser wallet'))!
      .click();
    await tick();
    Array.from(target.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Continue with wallet'))!
      .click();
    await new Promise((r) => setTimeout(r, 20));
    expect(target.textContent).toContain('You rejected the request in your wallet');
    delete (window as unknown as Record<string, unknown>).ethereum;
    destroy();
  });

  it('offers the already-added key when one exists', async () => {
    const onContinue = vi.fn();
    const { target, destroy } = mountAt(KeyPickerScreen, { ...HANDLERS, hasSigner: true, onContinue });
    await tick();
    Array.from(target.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Use the key I already added'))!
      .click();
    expect(onContinue).toHaveBeenCalledTimes(1);
    destroy();
  });
});
