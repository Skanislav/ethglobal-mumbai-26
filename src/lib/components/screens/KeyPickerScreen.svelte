<script lang="ts">
  import type { SignerRecord } from '../../signer-types';
  import { humanError, shortAddress } from '../../format';
  import { haloSignerAddress, readHaloPublicKey } from '../../signers/halo';
  import HdAccountModal from '../HdAccountModal.svelte';

  type Choice = 'passkey' | 'halo' | 'injected' | 'hardware';

  let {
    onAdded,
    onCreatePasskey,
    onDeviceAddress,
    onDeviceScan,
    onTrezorPick,
    onConnectInjected,
    hasSigner = false,
    onContinue,
    plannedRule,
    sessionSigners = [],
  }: {
    /** Receives the record the chosen key produced; the parent stores and advances. */
    onAdded: (record: SignerRecord) => void;
    onCreatePasskey: (label: string) => Promise<SignerRecord>;
    onDeviceAddress: (path: string) => Promise<SignerRecord>;
    /** Scans one page of HD accounts on a Ledger; powers the account-picker modal. */
    onDeviceScan?: (page: number) => Promise<{ path: string; address: `0x${string}` }[]>;
    /** Trezor's add is a Suite round trip that may return several picked accounts. */
    onTrezorPick?: () => Promise<SignerRecord[]>;
    onConnectInjected?: () => Promise<SignerRecord>;
    /** A signable owner already exists, so the screen offers "Continue" without adding another. */
    hasSigner?: boolean;
    onContinue?: () => void;
    /** The approval rule the invite link carried, shown read-only to an invited joiner. */
    plannedRule?: { threshold: number; ownerCount: number };
    /** Current signers; the account modal marks which scanned accounts are already owners. */
    sessionSigners?: SignerRecord[];
  } = $props();

  let choice = $state<Choice | null>(null);
  let device = $state<'ledger' | 'trezor'>('ledger');
  let passkeyName = $state('');
  let modalOpen = $state(false);
  let busy = $state(false);
  let status = $state('');

  const hasWebAuthn = $derived(typeof navigator !== 'undefined' && Boolean(navigator.credentials?.create));
  // HaLo needs Web NFC or the ARX bridge; neither exists in an ordinary desktop browser.
  const hasNfc = $derived(
    typeof window !== 'undefined' &&
      (typeof (window as unknown as Record<string, unknown>).NDEFReader !== 'undefined' ||
        typeof (window as unknown as Record<string, unknown>).HaloBridge !== 'undefined'),
  );
  const hasHid = $derived(typeof navigator !== 'undefined' && Boolean((navigator as { hid?: unknown }).hid));
  const hasInjected = $derived(typeof window !== 'undefined' && Boolean(window.ethereum));

  const tiles: { id: Choice; title: string; why: string; badge?: string; reason?: string }[] = $derived([
    {
      id: 'passkey',
      title: 'Passkey',
      why: 'Face or fingerprint on this phone',
      badge: 'Easiest',
      reason: hasWebAuthn ? undefined : 'Needs WebAuthn, which this browser lacks.',
    },
    {
      id: 'halo',
      title: 'NFC keyring',
      why: 'Tap a chip on a keyring or card',
      reason: undefined,
    },
    {
      id: 'injected',
      title: 'Browser wallet',
      why: 'MetaMask, Rabby and others',
      reason: hasInjected ? undefined : 'No browser wallet detected.',
    },
    {
      id: 'hardware',
      title: 'Hardware wallet',
      why: 'Ledger or Trezor',
      reason: device === 'ledger' && !hasHid ? 'Ledger needs WebHID; Trezor works without it.' : undefined,
    },
  ]);

  const label = $derived(
    choice === 'passkey'
      ? 'Continue with passkey'
      : choice === 'halo'
        ? 'Continue with chip'
        : choice === 'injected'
          ? 'Continue with wallet'
          : choice === 'hardware'
            ? `Continue with ${device === 'ledger' ? 'Ledger' : 'Trezor'}`
            : 'Continue',
  );

  function select(id: Choice): void {
    choice = id;
    status = '';
  }

  /** Runs the chosen key's ceremony and hands the record up; every failure is inline. */
  async function proceed(): Promise<void> {
    status = '';
    if (!choice) return;
    busy = true;
    try {
      if (choice === 'passkey') {
        const name = passkeyName.trim() || 'Passkey';
        onAdded(await onCreatePasskey(name));
        passkeyName = '';
      } else if (choice === 'injected') {
        if (!onConnectInjected) throw new Error('WalletUnavailable: no connect handler');
        onAdded(await onConnectInjected());
      } else if (choice === 'hardware') {
        if (device === 'trezor') {
          // The picker lives inside Trezor Suite: one click, the user selects
          // accounts there, and the selection comes back with addresses attached.
          if (!onTrezorPick) throw new Error('WalletUnavailable: no Trezor handler');
          for (const record of await onTrezorPick()) onAdded(record);
        } else {
          // Ledger accounts are picked inside the modal, which adds them itself.
          if (!onDeviceScan) throw new Error('WalletUnavailable: no scan handler');
          modalOpen = true;
        }
      } else {
        await addChip();
      }
    } catch (err) {
      status = humanError(err);
    } finally {
      busy = false;
    }
  }

  /** NFC tap derives the address *and* keeps the public key, so the chip can sign later. */
  async function addChip(): Promise<void> {
    // HaLo needs Web NFC or the ARX bridge; neither exists in an ordinary desktop browser,
    // and a pasted address-only chip can never sign — so scanning is the only path.
    if (!hasNfc) {
      throw new Error('A HaLo chip needs Web NFC or the ARX bridge — open this on a phone with NFC.');
    }
    const publicKey = await readHaloPublicKey();
    onAdded({
      kind: 'halo',
      address: await haloSignerAddress(publicKey),
      label: 'HaLo chip',
      canSign: true,
      publicKey,
    });
  }
</script>

<h1>Add your key</h1>
<p class="lede">Choose how you'll approve payments. Add as many keys as you like — passkey, chip, wallet, hardware.</p>

{#if plannedRule}
  <span class="sf-chip">Planned rule: {plannedRule.threshold}-of-{plannedRule.ownerCount} approvals</span>
{/if}

{#if sessionSigners.length > 0}
  <ul class="added">
    {#each sessionSigners as signer (signer.address)}
      <li>
        <span class="added-name">{signer.label}</span>
        <code class="addr">{shortAddress(signer.address)}</code>
        <span class="sf-chip sf-chip--ok">Added</span>
      </li>
    {/each}
  </ul>
{/if}

<ul class="tiles">
  {#each tiles as tile (tile.id)}
    <li class={['tile', { on: choice === tile.id, off: Boolean(tile.reason) && tile.id !== 'hardware' }]}>
      <button class="pick" onclick={() => select(tile.id)} disabled={Boolean(tile.reason) && tile.id !== 'hardware'}>
        <span class="glyph" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8">
            {#if tile.id === 'passkey'}
              <path d="M12 3a4 4 0 0 0-4 4v3" stroke-linecap="round" />
              <rect x="8" y="10" width="8" height="11" rx="3" />
              <circle cx="12" cy="15" r="1.2" fill="currentColor" stroke="none" />
            {:else if tile.id === 'halo'}
              <rect x="7" y="3" width="10" height="18" rx="2.5" />
              <path d="M10.5 7.5h3M10.5 12h3M10.5 16.5h3" stroke-linecap="round" />
            {:else if tile.id === 'injected'}
              <rect x="3" y="6" width="18" height="12" rx="2.5" />
              <path d="M3 10h18" />
              <circle cx="7" cy="14.5" r="1" fill="currentColor" stroke="none" />
            {:else}
              <rect x="3" y="5" width="18" height="14" rx="2.5" />
              <path d="M7.5 9.5h9M7.5 14.5h5" stroke-linecap="round" />
            {/if}
          </svg>
        </span>
        <span class="text">
          <span class="title">
            {tile.title}
            {#if tile.badge}<span class="sf-chip badge">{tile.badge}</span>{/if}
          </span>
          <span class="why">{tile.why}</span>
          {#if tile.reason}<span class="reason">{tile.reason}</span>{/if}
        </span>
        <span class={['radio', { on: choice === tile.id }]} aria-hidden="true"></span>
      </button>
    </li>
  {/each}
</ul>

{#if choice === 'passkey'}
  <label class="field">
    <span>Name this key</span>
    <input type="text" maxlength="64" placeholder="Mum (you)" bind:value={passkeyName} />
  </label>
{:else if choice === 'hardware'}
  <div class="field">
    <span>Which device?</span>
    <div class="row">
      <button
        class={['sf-btn', 'sf-btn--quiet', { 'pick-on': device === 'ledger' }]}
        onclick={() => (device = 'ledger')}
      >
        Ledger
      </button>
      <button
        class={['sf-btn', 'sf-btn--quiet', { 'pick-on': device === 'trezor' }]}
        onclick={() => (device = 'trezor')}
      >
        Trezor
      </button>
    </div>
    <p class="hint-left">Continue opens the account picker — you can add several accounts in a row.</p>
  </div>
{/if}

{#if status}
  <p class="error">{status}</p>
{/if}

<p class="hint">
  {#if choice === 'halo' && !hasNfc}
    A HaLo chip needs Web NFC — open this on a phone with NFC.
  {:else if choice === 'halo' && hasNfc}
    Tap the chip now — your phone will ask for permission.
  {:else}
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <rect x="4" y="10" width="16" height="10" rx="2.5" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" stroke-linecap="round" />
    </svg>
    Your key never leaves your device
  {/if}
</p>

<div class="cta">
  <button class="sf-btn" onclick={proceed} disabled={!choice || busy}>
    {busy ? 'Waiting for your key…' : label}
  </button>
  {#if hasSigner && onContinue}
    <button class="sf-btn sf-btn--ghost" onclick={onContinue}>Next: invite your family</button>
  {/if}
</div>

{#if modalOpen && onDeviceScan}
  <HdAccountModal
    owners={sessionSigners}
    onScan={onDeviceScan}
    onAdd={onDeviceAddress}
    {onAdded}
    onClose={() => (modalOpen = false)}
  />
{/if}

<style>
  h1 {
    margin: 0;
    font-size: 1.5rem;
    letter-spacing: -0.02em;
  }

  .lede {
    margin: 0;
    color: var(--sf-muted);
    font-size: 0.9375rem;
  }

  .tiles {
    display: grid;
    gap: 0.6rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .tile {
    border: 1px solid var(--sf-line);
    border-radius: var(--sf-radius-md);
    background: var(--sf-surface);
  }

  .tile.on {
    border-color: var(--sf-primary);
    box-shadow: 0 0 0 1px var(--sf-primary);
  }

  .tile.off {
    opacity: 0.55;
  }

  /* An unavailable tile must not look selected, and must not hide why it is out. */
  .tile.off .pick {
    cursor: not-allowed;
  }

  .pick {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.8rem 0.9rem;
    border: none;
    background: none;
    text-align: left;
    cursor: pointer;
    color: inherit;
  }

  .glyph {
    display: grid;
    place-items: center;
    width: 2.1rem;
    height: 2.1rem;
    border-radius: 50%;
    background: var(--sf-primary-soft);
    color: var(--sf-primary);
    flex: none;
  }

  .text {
    display: grid;
    gap: 0.15rem;
    flex: 1;
  }

  .title {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-weight: 600;
    font-size: 0.95rem;
  }

  .badge {
    background: var(--sf-success-bg);
    color: var(--sf-success);
  }

  .why {
    color: var(--sf-muted);
    font-size: 0.8125rem;
  }

  .reason {
    color: var(--sf-warn-ink);
    font-size: 0.75rem;
  }

  .radio {
    width: 1.1rem;
    height: 1.1rem;
    border-radius: 50%;
    border: 1.5px solid var(--sf-line);
    flex: none;
  }

  .radio.on {
    border-color: var(--sf-primary);
    box-shadow: inset 0 0 0 4px var(--sf-primary);
  }

  .field {
    display: grid;
    gap: 0.3rem;
    font-size: 0.8125rem;
    color: var(--sf-ink-soft);
  }

  .field input {
    padding: 0.6rem 0.7rem;
    border: 1px solid var(--sf-line);
    border-radius: var(--sf-radius-md);
    font: inherit;
    font-size: 0.9375rem;
    color: var(--sf-ink);
    background: var(--sf-surface);
  }

  .row {
    display: flex;
    gap: 0.5rem;
  }

  .added {
    display: grid;
    gap: 0.35rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .added li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.45rem 0.65rem;
    border: 1px solid var(--sf-line);
    border-radius: var(--sf-radius-md);
    background: var(--sf-surface);
  }

  .added-name {
    font-weight: 600;
    font-size: 0.875rem;
  }

  .addr {
    margin-left: auto;
    font-size: 0.75rem;
    color: var(--sf-muted);
  }

  .hint-left {
    margin: 0;
    color: var(--sf-muted);
    font-size: 0.75rem;
  }

  .pick-on {
    border-color: var(--sf-primary);
    color: var(--sf-primary);
  }

  .error {
    margin: 0;
    padding: 0.6rem 0.75rem;
    border-radius: var(--sf-radius-md);
    background: var(--sf-warn-bg);
    color: var(--sf-warn-ink);
    font-size: 0.8125rem;
  }

  .hint {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    margin: auto 0 0;
    text-align: center;
    color: var(--sf-muted);
    font-size: 0.75rem;
  }

  .cta {
    margin-top: auto;
  }
</style>
