<script lang="ts">
  import StatusLine from './StatusLine.svelte';
  import { getAddress } from 'viem';
  import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
  import { forgetAllEphemeralKeys, storeEphemeralKey } from '../ephemeral';
  import { connectInjected } from '../signers/hotWallet';
  import { shortAddress } from '../format';
  import { DEFAULT_HD_PATH } from '../signer-types';
  import type { SignerRecord } from '../signer-types';
  import { privateReads, privateReadsEnabled } from '../privateReads.svelte';

  let {
    signers = [],
    onAdd,
    onRemove,
    onCreatePasskey,
    onDeviceAddress,
    onRename,
  }: {
    signers?: SignerRecord[];
    onAdd: (record: SignerRecord) => void;
    onRemove: (address: `0x${string}`) => void;
    onRename: (address: `0x${string}`, label: string) => void;
    onCreatePasskey: (label: string) => Promise<SignerRecord>;
    onDeviceAddress: (kind: 'ledger' | 'trezor', path: string) => Promise<SignerRecord>;
  } = $props();

  let busy = $state<string | null>(null);
  let failure = $state<{ kind: string; message: string } | null>(null);
  let haloAddress = $state('');
  let passkeyName = $state('');
  let ledgerPath = $state(DEFAULT_HD_PATH);
  let trezorPath = $state(DEFAULT_HD_PATH);

  /** A friendly default so the field is optional, but two passkeys stay distinguishable. */
  function defaultPasskeyName(): string {
    const used = signers.filter((s) => s.kind === 'passkey').length;
    return used === 0 ? 'Passkey' : `Passkey ${used + 1}`;
  }

  const hasInjected = $derived(typeof window !== 'undefined' && Boolean(window.ethereum));
  const hasWebAuthn = $derived(typeof navigator !== 'undefined' && Boolean(navigator.credentials?.create));
  // HaLo needs Web NFC or the ARX bridge; neither exists in an ordinary desktop browser.
  const hasNfc = $derived(
    typeof window !== 'undefined' &&
      (typeof (window as unknown as Record<string, unknown>).NDEFReader !== 'undefined' ||
        typeof (window as unknown as Record<string, unknown>).HaloBridge !== 'undefined'),
  );
  const hasHid = $derived(typeof navigator !== 'undefined' && Boolean((navigator as { hid?: unknown }).hid));

  async function addDemo(): Promise<void> {
    busy = 'ephemeral';
    failure = null;
    try {
      const key = generatePrivateKey();
      const account = privateKeyToAccount(key);
      storeEphemeralKey(account.address, key);
      onAdd({ kind: 'ephemeral', address: account.address, label: 'Demo key', canSign: true });
    } catch (err) {
      failure = { kind: 'Demo key', message: err instanceof Error ? err.message : String(err) };
    } finally {
      busy = null;
    }
  }

  async function addInjected(): Promise<void> {
    busy = 'injected';
    failure = null;
    try {
      const conn = await connectInjected();
      onAdd({ kind: 'injected', address: conn.address, label: conn.label, canSign: true });
    } catch (err) {
      failure = { kind: 'Browser wallet', message: err instanceof Error ? err.message : String(err) };
    } finally {
      busy = null;
    }
  }

  function forgetKeys(): void {
    forgetAllEphemeralKeys();
    // The owners stay, but they are no longer signable in this browser until re-added.
    for (const signer of signers) {
      if (signer.kind === 'ephemeral') onRemove(signer.address);
    }
  }

  async function addPasskey(): Promise<void> {
    busy = 'passkey';
    failure = null;
    try {
      // A passkey lives in the OS keychain, so the name is how its owner is
      // recognised later — it is passed to the credential and kept as the label.
      const label = passkeyName.trim() || defaultPasskeyName();
      onAdd(await onCreatePasskey(label));
      passkeyName = '';
    } catch (err) {
      failure = { kind: 'Passkey', message: err instanceof Error ? err.message : String(err) };
    } finally {
      busy = null;
    }
  }

  async function addLedger(): Promise<void> {
    busy = 'ledger';
    failure = null;
    try {
      onAdd(await onDeviceAddress('ledger', ledgerPath));
    } catch (err) {
      failure = { kind: 'Ledger', message: err instanceof Error ? err.message : String(err) };
    } finally {
      busy = null;
    }
  }

  async function addTrezor(): Promise<void> {
    busy = 'trezor';
    failure = null;
    try {
      onAdd(await onDeviceAddress('trezor', trezorPath));
    } catch (err) {
      failure = { kind: 'Trezor', message: err instanceof Error ? err.message : String(err) };
    } finally {
      busy = null;
    }
  }

  function addHaloAddress(): void {
    failure = null;
    const value = haloAddress.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
      failure = { kind: 'HaLo', message: 'Paste the 42-character hex address from your chip.' };
      return;
    }
    try {
      onAdd({ kind: 'halo', address: getAddress(value), label: 'HaLo chip (address only)', canSign: false });
      haloAddress = '';
    } catch (err) {
      failure = { kind: 'HaLo', message: err instanceof Error ? err.message : String(err) };
    }
  }
</script>

<section class="step">
  <h2>Signers</h2>
  <p class="lede">
    Every owner below becomes part of the Safe's owner list. Only addresses are shared — no key
    material ever leaves the device that holds it.
  </p>

  <ul class="tiles">
    <li class="tile">
      <h3>Browser wallet</h3>
      <p class="why">An EIP-1193 wallet such as MetaMask or Rabby.</p>
      <button onclick={addInjected} disabled={!hasInjected || busy === 'injected'}>
        {busy === 'injected' ? 'Connecting…' : 'Connect wallet'}
      </button>
      {#if !hasInjected}<span class="reason">No wallet detected in this browser.</span>{/if}
    </li>

    <li class="tile">
      <h3>Demo key</h3>
      <p class="why">A throwaway key generated in this browser, for testing on Sepolia.</p>
      <button onclick={addDemo} disabled={busy === 'ephemeral'}>
        {busy === 'ephemeral' ? 'Generating…' : 'Generate demo key'}
      </button>
      <span class="reason">Kept on this device so a reload keeps the session; never exported.</span>
    </li>

    <li class="tile">
      <h3>Passkey</h3>
      <p class="why">A P-256 credential in your platform authenticator.</p>
      <input
        type="text"
        class="name"
        placeholder={defaultPasskeyName()}
        maxlength="64"
        bind:value={passkeyName}
        aria-label="Passkey name"
      />
      <button onclick={addPasskey} disabled={!hasWebAuthn || busy === 'passkey'}>
        {busy === 'passkey' ? 'Waiting for your authenticator…' : 'Create passkey'}
      </button>
      {#if !hasWebAuthn}<span class="reason">This browser has no WebAuthn support.</span>{/if}
    </li>

    <li class="tile">
      <h3>HaLo NFC chip</h3>
      <p class="why">An ARX chip's secp256k1 key, tapped over NFC.</p>
      <div class="row">
        <input type="text" placeholder="0x… chip address" bind:value={haloAddress} />
        <button onclick={addHaloAddress}>Use address</button>
      </div>
      <span class="reason">
        {#if hasNfc}
          Address-only entry; tap the chip later when signing.
        {:else}
          No NFC in this browser — paste the chip address to include it as an owner.
        {/if}
      </span>
    </li>

    <li class="tile">
      <h3>Ledger</h3>
      <p class="why">USB HID connection to the Ethereum app.</p>
      <input type="text" class="path" bind:value={ledgerPath} aria-label="Ledger derivation path" />
      <button onclick={addLedger} disabled={!hasHid || busy === 'ledger'}>
        {busy === 'ledger' ? 'Waiting for the device…' : 'Connect Ledger'}
      </button>
      {#if !hasHid}<span class="reason">WebHID is unavailable in this browser (Firefox blocks it).</span>{/if}
    </li>

    <li class="tile">
      <h3>Trezor</h3>
      <p class="why">Signs through the Trezor Suite popup — works without WebHID.</p>
      <input type="text" class="path" bind:value={trezorPath} aria-label="Trezor derivation path" />
      <button onclick={addTrezor} disabled={busy === 'trezor'}>
        {busy === 'trezor' ? 'Waiting for the popup…' : 'Connect Trezor'}
      </button>
    </li>
  </ul>

  {#if failure}
    <StatusLine status="error" message={`${failure.kind}: ${failure.message}`} />
  {/if}

  <div class="owners">
    <h3>Owner set ({signers.length})</h3>
    {#if signers.length === 0}
      <p class="hint">No signers yet. Add at least one.</p>
    {:else}
      <ul>
        {#each signers as signer (signer.address)}
          <li>
            <span class="kind">{signer.kind}</span>
            <input
              type="text"
              class="label-input"
              value={signer.label}
              maxlength="64"
              aria-label="Name for {shortAddress(signer.address)}"
              onchange={(event) => onRename(signer.address, event.currentTarget.value)}
            />
            <code>{shortAddress(signer.address)}</code>
            {#if !signer.canSign}<span class="unsigned">cannot sign here</span>{/if}
            <button class="remove" onclick={() => onRemove(signer.address)}>Remove</button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if signers.some((s) => s.kind === 'ephemeral')}
      <p class="badge">
        TESTNET ONLY — a demo key is in this owner set. Its key is stored on this device
        (localStorage) so a reload keeps the session; it is never exported.
        <button class="link" onclick={forgetKeys}>Forget demo keys</button>
      </p>
    {/if}
    <p class="hint">
      Reads in this session: {privateReadsEnabled() ? 'private (anon-rpc sandbox)' : 'plain gateway'}.
      {#if privateReads.enabled && privateReads.status === 'pending'}
        (private sandbox still starting)
      {:else if privateReads.enabled && privateReads.status === 'unavailable' && privateReads.reason}
        — private reads unavailable: {privateReads.reason}
      {/if}
    </p>
  </div>
</section>

<style>
  .step {
    display: grid;
    gap: 1.25rem;
  }
  .lede {
    margin: 0;
    max-width: 48ch;
  }
  .tiles {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
    gap: 0.75rem;
  }
  .tile {
    display: grid;
    gap: 0.4rem;
    align-content: start;
    padding: 0.75rem;
    border: 1px solid #dcdcdc;
    border-radius: 8px;
  }
  .tile h3 {
    margin: 0;
    font-size: 0.9375rem;
  }
  .why {
    margin: 0;
    font-size: 0.8125rem;
    color: #555;
  }
  .reason {
    font-size: 0.75rem;
    color: #8a6d00;
  }
  .row {
    display: flex;
    gap: 0.4rem;
  }
  .path {
    font-family: ui-monospace, monospace;
    font-size: 0.8125rem;
  }
  .name {
    font: inherit;
    font-size: 0.875rem;
    padding: 0.3rem 0.45rem;
    border: 1px solid #c9c9c9;
    border-radius: 6px;
  }
  .owners ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.35rem;
  }
  .owners li {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    font-size: 0.875rem;
  }
  .kind {
    font-size: 0.75rem;
    text-transform: uppercase;
    color: #555;
    min-width: 4.5rem;
  }
  .label-input {
    font: inherit;
    font-size: 0.875rem;
    padding: 0.15rem 0.35rem;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    min-width: 7rem;
  }
  .label-input:hover,
  .label-input:focus {
    border-color: #c9c9c9;
    background: #fff;
  }
  .link {
    border: none;
    background: none;
    padding: 0;
    margin-left: 0.4rem;
    color: #1a5fb4;
    text-decoration: underline;
    cursor: pointer;
    font-size: inherit;
  }
  .unsigned {
    color: #a11a1a;
    font-size: 0.75rem;
  }
  .remove {
    margin-left: auto;
  }
  .badge .link {
    color: #5a4a10;
    margin-left: 0.4rem;
  }
  .badge {
    display: inline-block;
    padding: 0.25rem 0.5rem;
    background: #fff4d6;
    border: 1px solid #e0c070;
    border-radius: 6px;
    font-size: 0.75rem;
    font-weight: 600;
  }
  .hint {
    margin: 0;
    font-size: 0.8125rem;
    color: #666;
  }
</style>
