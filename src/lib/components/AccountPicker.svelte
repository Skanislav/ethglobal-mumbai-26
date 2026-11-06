<script lang="ts">
  import { formatEth, shortAddress } from '../format';
  import { hdPath } from '../signers/discovery';
  import type { DiscoveredAccount } from '../signers/discovery';

  let {
    kind,
    accounts = [],
    busy = false,
    onPick,
    onRescan,
    onManual,
  }: {
    kind: 'ledger' | 'trezor';
    accounts?: DiscoveredAccount[];
    busy?: boolean;
    onPick: (account: DiscoveredAccount) => void;
    onRescan: () => void;
    onManual: (path: string) => void;
  } = $props();

  const deviceName = $derived(kind === 'ledger' ? 'Ledger' : 'Trezor');
  let manualPath = $state(hdPath(0));

  /** Sepolia balances are routinely dust, so an exact zero is stated rather than shown as 0 ETH. */
  function balanceText(account: DiscoveredAccount): string {
    if (account.balance === null) return 'balance unknown';
    return account.balance === 0n ? 'no Sepolia ETH' : `${formatEth(account.balance)} ETH`;
  }
</script>

<div class="discovery">
  <p class="heading">
    Accounts on this {deviceName} — {accounts.length} scanned at <code>m/44'/60'/i'/0/0</code>.
  </p>

  <ul class="accounts">
    {#each accounts as account (account.path)}
      <li class={{ owner: account.alreadyOwner }}>
        <div class="where">
          <span class="account">Account {account.account}</span>
          <code class="path">m/{account.path}</code>
        </div>
        <code class="address">{shortAddress(account.address)}</code>
        <span class="balance">{balanceText(account)}</span>
        {#if account.alreadyOwner}
          <span class="owner-tag">already an owner</span>
        {:else}
          <button onclick={() => onPick(account)} disabled={busy}>
            {busy ? 'Reading device…' : `Use account ${account.account}`}
          </button>
        {/if}
      </li>
    {/each}
  </ul>

  <div class="foot">
    <button class="link" onclick={onRescan} disabled={busy}>Scan again</button>
    <span class="manual">
      <label for="manual-{kind}">Or enter a path</label>
      <input id="manual-{kind}" type="text" bind:value={manualPath} aria-label="{deviceName} derivation path" />
      <button onclick={() => onManual(manualPath)} disabled={busy}>Use path</button>
    </span>
  </div>
</div>

<style>
  .discovery {
    display: grid;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  .heading {
    margin: 0;
    font-size: 0.8125rem;
    opacity: 0.8;
  }
  .accounts {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.25rem;
  }
  .accounts li {
    display: grid;
    grid-template-columns: 1fr auto auto auto;
    gap: 0.5rem;
    align-items: center;
    padding: 0.4rem 0.5rem;
    border: 1px solid #d8d8d8;
    border-radius: 6px;
    font-size: 0.8125rem;
  }
  .accounts li.owner {
    background: #f4f4f4;
  }
  .where {
    display: grid;
    gap: 0.1rem;
  }
  .account {
    font-weight: 600;
  }
  .path {
    font-size: 0.75rem;
    opacity: 0.7;
  }
  .address {
    font-size: 0.8125rem;
  }
  .balance {
    font-variant-numeric: tabular-nums;
    opacity: 0.75;
  }
  .owner-tag {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.6;
  }
  .foot {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
    font-size: 0.8125rem;
  }
  .manual {
    display: flex;
    gap: 0.35rem;
    align-items: center;
  }
  .manual input {
    width: 11rem;
  }
  .link {
    background: none;
    border: 0;
    padding: 0;
    color: inherit;
    text-decoration: underline;
    cursor: pointer;
    font: inherit;
  }
</style>
