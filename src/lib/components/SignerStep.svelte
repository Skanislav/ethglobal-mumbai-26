<script lang="ts">
  import StatusLine from './StatusLine.svelte';
  import AccountPicker from './AccountPicker.svelte';
  import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
  import { forgetAllEphemeralKeys, storeEphemeralKey } from '../ephemeral';
  import { connectInjected } from '../signers/hotWallet';
  import { describeHaloFailure, haloAvailable, haloSignerAddress, haloStatusText, readHaloPublicKey } from '../signers/halo';
  import { shortAddress } from '../format';
  import type { SignerRecord } from '../signer-types';
  import { describeAccounts, discoveryPaths } from '../signers/discovery';
  import type { DiscoveredAccount } from '../signers/discovery';
  import { formatEth } from '../format';

  let {
    signers = [],
    onAdd,
    onRemove,
    onCreatePasskey,
    onDeviceAddress,
    onDeviceScan,
    onRename,
    onShare,
  }: {
    signers?: SignerRecord[];
    onAdd: (record: SignerRecord) => void;
    onRemove: (address: `0x${string}`) => void;
    onRename: (address: `0x${string}`, label: string) => void;
    onCreatePasskey: (label: string) => Promise<SignerRecord>;
    onDeviceAddress: (kind: 'ledger' | 'trezor', path: string) => Promise<SignerRecord>;
    onDeviceScan: (kind: 'ledger' | 'trezor') => Promise<{ path: string; address: `0x${string}` }[]>;
    onShare?: () => Promise<string>;
  } = $props();

  let busy = $state<string | null>(null);
  let failure = $state<{ kind: string; message: string } | null>(null);
  let haloStatus = $state<string | null>(null);
  let passkeyName = $state('');
  // Discovered accounts per device, kept after the scan so the list stays visible
  // while the user decides. `null` = never scanned in this session.
  let ledgerAccounts = $state<DiscoveredAccount[] | null>(null);
  let trezorAccounts = $state<DiscoveredAccount[] | null>(null);
  let shareUrl = $state('');

  /** A friendly default so the field is optional, but two passkeys stay distinguishable. */
  function defaultPasskeyName(): string {
    const used = signers.filter((s) => s.kind === 'passkey').length;
    return used === 0 ? 'Passkey' : `Passkey ${used + 1}`;
  }

  const hasInjected = $derived(typeof window !== 'undefined' && Boolean(window.ethereum));
  const hasWebAuthn = $derived(typeof navigator !== 'undefined' && Boolean(navigator.credentials?.create));
  // HaLo needs Web NFC or the ARX bridge; neither exists in an ordinary desktop browser.
  const hasNfc = $derived(haloAvailable());
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

  /**
   * Reads the accounts on the device, then balances and owner flags. The device is
   * opened once per scan (the transports hold a session), so this is one prompt
   * rather than one per account.
   */
  async function scan(kind: 'ledger' | 'trezor'): Promise<void> {
    busy = kind;
    failure = null;
    try {
      const raw = await onDeviceScan(kind);
      const described = await describeAccounts(raw, signers);
      if (kind === 'ledger') ledgerAccounts = described;
      else trezorAccounts = described;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failure = { kind: kind === 'ledger' ? 'Ledger' : 'Trezor', message };
      if (kind === 'ledger') ledgerAccounts = null;
      else trezorAccounts = null;
    } finally {
      busy = null;
    }
  }

  /**
   * Adds the account at `path` — from the scanned list or a hand-typed path, which
   * differ only in where the path came from. The path is stored on the record so
   * signing later reopens the same account instead of guessing.
   */
  async function addDevice(kind: 'ledger' | 'trezor', path: string): Promise<void> {
    busy = kind;
    failure = null;
    try {
      onAdd(await onDeviceAddress(kind, path));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failure = { kind: kind === 'ledger' ? 'Ledger' : 'Trezor', message };
    } finally {
      busy = null;
    }
  }

  /**
   * Reads the chip over NFC. The tap returns the chip's public key, which is what
   * makes the owner *signable* later — an address pasted by hand cannot sign, because
   * the signature needs the key to recover `v`.
   */
  async function scanHalo(): Promise<void> {
    busy = 'halo';
    failure = null;
    haloStatus = 'Hold the chip against the back of your phone…';
    try {
      const publicKey = await readHaloPublicKey((status) => (haloStatus = haloStatusText(status)));
      const address = await haloSignerAddress(publicKey);
      onAdd({ kind: 'halo', address, label: 'HaLo chip', canSign: true, publicKey });
      haloStatus = null;
    } catch (err) {
      failure = { kind: 'HaLo', message: describeHaloFailure(err) };
      haloStatus = null;
    } finally {
      busy = null;
    }
  }

  async function share(): Promise<void> {
    if (!onShare) return;
    busy = 'share';
    failure = null;
    shareUrl = '';
    try {
      shareUrl = await onShare();
    } catch (err) {
      failure = { kind: 'Share', message: err instanceof Error ? err.message : String(err) };
    } finally {
      busy = null;
    }
  }

  async function copyShareLink(): Promise<void> {
    if (!shareUrl) return;
    await copyText(shareUrl);
  }

  async function copyText(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      failure = null;
    } catch {
      // The link stays visible: selecting and copying by hand still works.
      failure = { kind: 'Share', message: 'Copy blocked — select the link and copy it manually.' };
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

    <li class={{ tile: true, unavailable: !hasNfc }}>
      <h3>HaLo NFC chip</h3>
      <p class="why">An ARX chip's secp256k1 key, read by tapping the chip to your phone.</p>
      <button onclick={scanHalo} disabled={!hasNfc || busy === 'halo'}>
        {busy === 'halo' ? 'Waiting for the tap…' : 'Scan chip'}
      </button>
      {#if !hasNfc}
        <span class="reason unavailable-reason">
          Web NFC is not available in this browser. Use a compatible device: Chrome on Android,
          served over HTTPS — then tap the chip to this screen.
        </span>
      {/if}
      {#if haloStatus}
        <StatusLine status="busy" message={haloStatus} />
      {/if}
    </li>

    <li class="tile">
      <h3>Ledger</h3>
      <p class="why">USB HID connection to the Ethereum app. Lists the accounts on the device.</p>
      <button onclick={() => scan('ledger')} disabled={!hasHid || busy === 'ledger'}>
        {busy === 'ledger' ? 'Reading the device…' : ledgerAccounts ? 'Scan Ledger again' : 'Find accounts on Ledger'}
      </button>
      {#if !hasHid}<span class="reason">WebHID is unavailable in this browser (Firefox blocks it).</span>{/if}
      {#if ledgerAccounts}
        <AccountPicker
          kind="ledger"
          accounts={ledgerAccounts}
          busy={busy === 'ledger'}
          onPick={(account) => addDevice('ledger', account.path)}
          onRescan={() => scan('ledger')}
          onManual={(path) => addDevice('ledger', path)}
        />
      {/if}
    </li>

    <li class="tile">
      <h3>Trezor</h3>
      <p class="why">Signs through the Trezor Suite popup — works without WebHID.</p>
      <button onclick={() => scan('trezor')} disabled={busy === 'trezor'}>
        {busy === 'trezor' ? 'Waiting for the device…' : trezorAccounts ? 'Scan Trezor again' : 'Find accounts on Trezor'}
      </button>
      {#if trezorAccounts}
        <AccountPicker
          kind="trezor"
          accounts={trezorAccounts}
          busy={busy === 'trezor'}
          onPick={(account) => addDevice('trezor', account.path)}
          onRescan={() => scan('trezor')}
          onManual={(path) => addDevice('trezor', path)}
        />
      {/if}
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

    {#if onShare}
      <div class="share">
        <h3>Share this session</h3>
        <p class="hint">
          Encodes the session into the link itself. Nothing is published and no fee is paid: the
          link's fragment never leaves the browser, and anyone holding it can read the session and
          carry on locally.
        </p>
        <div class="row">
          <button onclick={share} disabled={busy === 'share' || signers.length === 0}>
            {busy === 'share' ? 'Building the link…' : 'Share session as a link'}
          </button>
          <button onclick={copyShareLink} disabled={!shareUrl}>Copy</button>
        </div>
        {#if shareUrl}
          <input
            type="text"
            class="share-link"
            readonly
            value={shareUrl}
            aria-label="Shareable session link"
            onfocus={(event) => event.currentTarget.select()}
          />
        {/if}

      </div>
    {/if}
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
  /* A capability this browser lacks: the tile stays visible so the option is
     discoverable, but reads as unavailable rather than as a button that fails. */
  .tile.unavailable {
    background: #f6f6f6;
    border-color: #e2e2e2;
  }
  .tile.unavailable h3,
  .tile.unavailable .why {
    opacity: 0.55;
  }
  .unavailable-reason {
    color: #7a4b00;
    font-weight: 500;
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
  .share {
    display: grid;
    gap: 0.5rem;
    padding: 0.75rem;
    border: 1px solid #dcdcdc;
    border-radius: 8px;
  }
  .share h3 {
    margin: 0;
    font-size: 0.9375rem;
  }
  .share-link {
    font: inherit;
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    padding: 0.35rem 0.45rem;
    border: 1px solid #c9c9c9;
    border-radius: 6px;
    width: 100%;
    box-sizing: border-box;
  }
</style>
