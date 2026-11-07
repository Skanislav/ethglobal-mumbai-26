<script lang="ts">
  import { onMount } from 'svelte';
  import { avatarClass, formatEth, formatUsd, initial, humanError, memberSubtitle } from '../../format';
  import { estimateBlobPublishCost } from '../../costs';
  import type { CostContext } from '../../costs';
  import { memberJoinState } from '../../session';
  import type { Session } from '../../session';

  let {
    session,
    inviteUrl = '',
    vaultName = '',
    onVaultName,
    onPublish,
    onAddPlanned,
    onRemovePlanned,
    onNext,
  }: {
    session: Session;
    /** Already-published link for this exact session; the parent caches it. */
    inviteUrl?: string;
    vaultName?: string;
    onVaultName: (name: string) => void;
    /** Publishes the session and returns the invite link; may need a wallet. */
    onPublish?: () => Promise<string>;
    onAddPlanned: (name: string) => void;
    onRemovePlanned: (name: string) => void;
    onNext: () => void;
  } = $props();

  let shareCost = $state<CostContext | null>(null);
  let sharing = $state(false);
  let failure = $state('');
  let copied = $state(false);
  let newName = $state('');
  let needsWallet = $state(false);

  const roster = $derived(memberJoinState(session));
  const joined = $derived(roster.filter((m) => m.joined).length);
  const canAdvance = $derived(session.signers.some((s) => s.canSign));

  onMount(() => {
    // Publishing is a blob transaction, so it only runs unprompted when a wallet is
    // already authorized; otherwise the box says what it needs and the click prompts.
    void (async () => {
      if (!onPublish || inviteUrl) return;
      const eth = typeof window === 'undefined' ? undefined : window.ethereum;
      let accounts: unknown = [];
      try {
        accounts = eth ? await eth.request({ method: 'eth_accounts' }) : [];
      } catch {
        accounts = [];
      }
      if (Array.isArray(accounts) && accounts.length > 0) await share();
      else needsWallet = true;
    })();
  });

  async function share(): Promise<void> {
    if (!onPublish) return;
    sharing = true;
    failure = '';
    copied = false;
    try {
      await onPublish();
      // Cost is read after the publish, when the payer wallet is already connected.
      shareCost = await estimateBlobPublishCost();
    } catch (err) {
      failure = humanError(err);
      needsWallet = true;
    } finally {
      sharing = false;
    }
  }

  async function copy(): Promise<void> {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      copied = true;
      failure = '';
    } catch {
      failure = 'Copy blocked — select the link and copy it by hand.';
    }
  }

  function add(): void {
    const name = newName.trim();
    if (!name) return;
    onAddPlanned(name);
    newName = '';
  }
</script>

<h1>Invite your family</h1>
<p class="lede">Send this link to people you trust. Each of them adds their own key.</p>

<label class="vault-name">
  <span>Vault name</span>
  <input
    type="text"
    maxlength="40"
    placeholder="The Novaks"
    value={vaultName}
    onchange={(event) => onVaultName(event.currentTarget.value)}
    aria-label="Vault name"
  />
</label>

<div class="invite">
  <span class="label">Invite link</span>
  {#if inviteUrl}
    <div class="row">
      <input class="link" type="text" readonly value={inviteUrl} onfocus={(e) => e.currentTarget.select()} />
      <button class="sf-btn sf-btn--quiet" onclick={copy}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  {:else}
    {#if sharing}
      <p class="pending">Publishing the invite to Sepolia…</p>
    {:else if !failure}
      <p class="pending">
        {needsWallet
          ? 'Connect a wallet on Sepolia to publish the invite link.'
          : 'Invite link not published yet.'}
      </p>
    {/if}
  {/if}
  {#if shareCost?.status === 'ready'}
    <p class="cost">
      Publish cost ≈ {formatEth(shareCost.gas.feeWei)} ETH
      {#if shareCost.price}(≈ {formatUsd(shareCost.gas.feeWei, shareCost.price.usd)}){/if}
    </p>
  {/if}
  {#if failure}
    <p class="error">{failure}</p>
  {/if}
</div>

<div class="roster">
  <div class="head">
    <h2>Family members</h2>
    <span class="sf-muted">{joined} of {roster.length} joined</span>
  </div>
  <ul>
    {#each roster as member, index (member.name + index)}
      <li>
        <span class="sf-avatar {avatarClass(index)}">{initial(member.name)}</span>
        <span class="who">
          <span class="name">{member.name}</span>
          <span class="sub">{memberSubtitle(member)}</span>
        </span>
        {#if member.joined}
          <span class="sf-chip sf-chip--ok">Joined</span>
        {:else}
          <span class="sf-chip sf-chip--warn">Invited</span>
          {#if member.planned}
            <button class="remove" onclick={() => onRemovePlanned(member.name)} aria-label="Remove {member.name}">
              ×
            </button>
          {/if}
        {/if}
      </li>
    {/each}
  </ul>

  <form
    class="add"
    onsubmit={(event) => {
      event.preventDefault();
      add();
    }}
  >
    <input type="text" placeholder="Add a family member" maxlength="64" bind:value={newName} aria-label="Member name" />
    <button class="sf-btn sf-btn--quiet" type="submit" disabled={!newName.trim()}>Add</button>
  </form>
</div>

<div class="cta">
  <button class="sf-btn" onclick={inviteUrl ? copy : share} disabled={sharing || !onPublish}>
    {sharing ? 'Publishing…' : inviteUrl ? 'Share invite link' : 'Connect a wallet and publish'}
  </button>
  <button class="sf-btn sf-btn--ghost" onclick={onNext} disabled={!canAdvance}>Next: approval rule</button>
  {#if !canAdvance}
    <p class="hint">Add your own key first; the vault needs at least one signer here.</p>
  {/if}
</div>

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

  .vault-name {
    display: grid;
    gap: 0.3rem;
    font-size: 0.8125rem;
    color: var(--sf-ink-soft);
  }

  .vault-name input {
    padding: 0.55rem 0.7rem;
    border: 1px solid var(--sf-line);
    border-radius: var(--sf-radius-md);
    font: inherit;
    font-size: 0.9375rem;
    color: var(--sf-ink);
    background: var(--sf-surface);
  }

  .invite {
    display: grid;
    gap: 0.4rem;
    padding: 0.85rem;
    border-radius: var(--sf-radius-md);
    background: var(--sf-primary-soft);
  }

  .label {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--sf-ink-soft);
  }

  .row {
    display: flex;
    gap: 0.4rem;
  }

  .link {
    flex: 1;
    min-width: 0;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--sf-line);
    border-radius: 10px;
    background: var(--sf-surface);
    font: inherit;
    font-size: 0.8125rem;
    color: var(--sf-ink-soft);
  }

  .pending {
    margin: 0;
    padding: 0.5rem 0.6rem;
    border-radius: 10px;
    background: var(--sf-surface);
    font-size: 0.8125rem;
    color: var(--sf-muted);
  }

  .cost,
  .hint {
    margin: 0;
    font-size: 0.75rem;
    color: var(--sf-muted);
  }

  .error {
    margin: 0;
    color: var(--sf-warn-ink);
    font-size: 0.8125rem;
  }

  .roster {
    display: grid;
    gap: 0.5rem;
  }

  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }

  h2 {
    margin: 0;
    font-size: 0.95rem;
  }

  .roster ul {
    display: grid;
    gap: 0.4rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .roster li {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    padding: 0.6rem 0.7rem;
    border: 1px solid var(--sf-line);
    border-radius: var(--sf-radius-md);
    background: var(--sf-surface);
  }

  .who {
    display: grid;
    flex: 1;
    min-width: 0;
  }

  .name {
    font-weight: 600;
    font-size: 0.9375rem;
  }

  .sub {
    color: var(--sf-muted);
    font-size: 0.75rem;
  }

  .remove {
    padding: 0 0.2rem;
    border: none;
    background: none;
    color: var(--sf-muted);
    font-size: 1rem;
    cursor: pointer;
  }

  .add {
    display: flex;
    gap: 0.4rem;
  }

  .add input {
    flex: 1;
    min-width: 0;
    padding: 0.55rem 0.7rem;
    border: 1px dashed #c9d2e6;
    border-radius: var(--sf-radius-md);
    background: transparent;
    font: inherit;
    font-size: 0.875rem;
  }

  .cta {
    display: grid;
    gap: 0.5rem;
    margin-top: auto;
  }
</style>
