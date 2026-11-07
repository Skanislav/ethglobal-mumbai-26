<script lang="ts">
  // Paginated Ledger-account picker: one page of ten 44'/60'/i'/0/0 accounts at
  // a time, each with its Sepolia balance and an already-an-owner flag. Adding a
  // row flags it in place so several accounts can be added in one sitting; Done
  // closes. The manual path is the escape hatch inside a details. Trezor never
  // uses this modal — its account picker lives inside Trezor Suite.
  import { describeAccounts, HD_PAGE_SIZE } from '../signers/discovery';
  import type { DiscoveredAccount } from '../signers/discovery';
  import type { SignerRecord } from '../signer-types';
  import { formatEth, shortAddress } from '../format';
  import { SvelteSet } from 'svelte/reactivity';

  let {
    owners,
    onScan,
    onAdd,
    onAdded,
    onClose,
  }: {
    /** Current signers, so accounts already on the vault render as Owner rows. */
    owners: SignerRecord[];
    onScan: (page: number) => Promise<{ path: string; address: `0x${string}` }[]>;
    /** Builds the signer record for a device path (reads the address from the Ledger). */
    onAdd: (path: string) => Promise<SignerRecord>;
    /** Propagates each added record to the screen, which stores it. */
    onAdded: (record: SignerRecord) => void;
    onClose: () => void;
  } = $props();

  let page = $state(0);
  let accounts = $state<DiscoveredAccount[] | null>(null);
  let busy = $state(false);
  let failure = $state('');
  let manual = $state('');
  /** Paths added this session, across pages — the row stays flagged after a page flip. */
  const added = new SvelteSet<string>();

  function isOwner(account: DiscoveredAccount): boolean {
    return account.alreadyOwner || added.has(account.path);
  }

  async function load(p: number): Promise<void> {
    busy = true;
    failure = '';
    try {
      accounts = await describeAccounts(await onScan(p), owners);
      page = p;
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      accounts = null;
    } finally {
      busy = false;
    }
  }

  // Load the first page when the modal opens.
  $effect(() => {
    if (accounts === null && !busy) void load(0);
  });

  async function pick(account: DiscoveredAccount): Promise<void> {
    busy = true;
    failure = '';
    try {
      onAdded(await onAdd(account.path));
      added.add(account.path);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  async function manualAdd(): Promise<void> {
    const value = manual.trim();
    if (!value) return;
    busy = true;
    failure = '';
    try {
      onAdded(await onAdd(value));
      added.add(value);
      manual = '';
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

<div
  class="modal-backdrop"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onClose();
  }}
>
  <div class="modal" role="dialog" aria-modal="true" aria-label="Choose an account">
    <header>
      <h2>Accounts on this Ledger</h2>
      <p class="sf-muted">
        Showing <code>m/44'/60'/{page * HD_PAGE_SIZE}'</code>–<code>m/44'/60'/{page * HD_PAGE_SIZE + HD_PAGE_SIZE - 1}'</code>
        — one page per click.
      </p>
      <button class="close" aria-label="Close" onclick={onClose}>×</button>
    </header>

    {#if failure}
      <p class="error">{failure}</p>
    {/if}

    {#if accounts}
      <ul class="accounts">
        {#each accounts as account (account.path)}
          <li class={{ owner: isOwner(account) }}>
            <code>{account.path}</code>
            <span class="addr"><code>{shortAddress(account.address)}</code></span>
            <span class="balance">
              {account.balance === null
                ? 'balance unknown'
                : account.balance === 0n
                  ? 'no Sepolia ETH'
                  : `${formatEth(account.balance)} ETH`}
            </span>
            {#if isOwner(account)}
              <span class="sf-chip sf-chip--ok">Added</span>
            {:else}
              <button class="sf-btn sf-btn--quiet" disabled={busy} onclick={() => pick(account)}>Add</button>
            {/if}
          </li>
        {/each}
      </ul>
    {:else}
      <p class="sf-muted">Reading the device…</p>
    {/if}

    <details class="manual">
      <summary>Enter a path by hand</summary>
      <form
        onsubmit={(e) => {
          e.preventDefault();
          void manualAdd();
        }}
      >
        <input type="text" bind:value={manual} placeholder="44'/60'/0'/0/0" />
        <button type="submit" class="sf-btn sf-btn--quiet" disabled={busy || !manual.trim()}>Add</button>
      </form>
    </details>

    <footer>
      <button class="sf-btn sf-btn--quiet" disabled={busy || page === 0} onclick={() => load(page - 1)}>
        ← Previous
      </button>
      <span class="sf-muted">
        Page {page + 1}{added.size > 0 ? ` · ${added.size} added` : ''}
      </span>
      <button class="sf-btn" disabled={busy} onclick={() => load(page + 1)}>Next page →</button>
    </footer>

    <div class="done">
      <button class="sf-btn" onclick={onClose}>
        {added.size > 0 ? `Done — ${added.size} added` : 'Close'}
      </button>
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(10, 14, 20, 0.45);
    display: grid;
    place-items: center;
    z-index: 10000;
  }

  .modal {
    background: var(--sf-surface);
    border-radius: var(--sf-radius-md);
    width: min(34rem, calc(100vw - 2rem));
    max-height: calc(100vh - 2rem);
    overflow: auto;
    padding: 1rem;
    display: grid;
    gap: 0.75rem;
    position: relative;
  }

  header h2 {
    margin: 0;
    font-size: 1.05rem;
  }

  header p {
    margin: 0.25rem 0 0;
    font-size: 0.75rem;
  }

  .close {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    border: none;
    background: none;
    font-size: 1.25rem;
    cursor: pointer;
  }

  .accounts {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.5rem;
  }

  .accounts li {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.55rem 0.6rem;
    border: 1px solid var(--sf-line);
    border-radius: var(--sf-radius-md);
  }

  .accounts li.owner {
    opacity: 0.65;
  }

  .addr {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .balance {
    font-size: 0.75rem;
    color: var(--sf-muted);
    white-space: nowrap;
  }

  .manual summary {
    cursor: pointer;
    color: var(--sf-muted);
    font-size: 0.8125rem;
  }

  .manual form {
    display: flex;
    gap: 0.4rem;
    margin-top: 0.4rem;
  }

  .manual input {
    flex: 1;
    min-width: 0;
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--sf-line);
    border-radius: 10px;
    font: inherit;
    font-size: 0.8125rem;
  }

  .error {
    margin: 0;
    color: var(--sf-warn-ink);
    font-size: 0.8125rem;
  }

  footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .done {
    display: grid;
  }
</style>
