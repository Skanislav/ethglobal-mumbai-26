<script lang="ts">
  import { avatarClass, formatEth, initial, shortAddress, humanError, memberSubtitle } from '../../format';
  import { memberJoinState } from '../../session';
  import type { Session } from '../../session';

  let {
    session,
    balanceWei,
    inviteUrl = '',
    onSend,
    onInvite,
    onRefresh,
  }: {
    session: Session;
    balanceWei: bigint | null;
    /** Cached invite link for this session, published once by the parent. */
    inviteUrl?: string;
    onSend: () => void;
    onInvite?: () => Promise<string>;
    onRefresh?: () => void;
  } = $props();

  let panel = $state<'none' | 'receive' | 'invite'>('none');
  let copied = $state('');
  let failure = $state('');
  let inviting = $state(false);

  const roster = $derived(memberJoinState(session));
  const address = $derived(session.safeAddress ?? '');

  async function showInvite(): Promise<void> {
    panel = 'invite';
    failure = '';
    if (inviteUrl || !onInvite) return;
    inviting = true;
    try {
      await onInvite();
    } catch (err) {
      failure = humanError(err);
    } finally {
      inviting = false;
    }
  }

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      copied = text;
      failure = '';
    } catch {
      failure = 'Copy blocked — select the value and copy it by hand.';
    }
  }
</script>

<header class="top">
  <div class="who">
    <span class="eyebrow">Family vault</span>
    <h1>{session.vaultName || 'Untitled vault'}</h1>
  </div>
  <div class="faces">
    {#each roster.slice(0, 3) as member, index (member.name + index)}
      <span class="sf-avatar {avatarClass(index)}">{initial(member.name)}</span>
    {/each}
    {#if roster.length > 3}
      <span class="sf-avatar more">+{roster.length - 3}</span>
    {/if}
  </div>
</header>

<section class="balance">
  <span class="label">Vault balance</span>
  <div class="amount">
    {#if balanceWei === null}
      <span class="unavailable">Balance unavailable — check RPC</span>
    {:else}
      {formatEth(balanceWei)}<span class="unit">ETH</span>
    {/if}
  </div>
  <div class="meta">
    <span>{session.threshold} of {session.signers.length} approvals</span>
    <span class="net">
      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M9.5 14.5 14.5 9.5M8 12l-1.6 1.6a3.2 3.2 0 0 0 4.5 4.5L12.5 16" stroke-linecap="round" />
        <path d="M16 12l1.6-1.6a3.2 3.2 0 0 0-4.5-4.5L11.5 8" stroke-linecap="round" />
      </svg>
      Test network
    </span>
  </div>
</section>

<div class="actions">
  <button class="action" onclick={onSend}>
    <span class="icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M7 17 17 7M9 7h8v8" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </span>
    Send
  </button>
  <button class="action" onclick={() => (panel = panel === 'receive' ? 'none' : 'receive')}>
    <span class="icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M17 7 7 17M15 17H7V9" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </span>
    Receive
  </button>
  <button class="action" onclick={showInvite} disabled={!onInvite}>
    <span class="icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 6v12M6 12h12" stroke-linecap="round" />
      </svg>
    </span>
    Invite
  </button>
</div>

{#if panel === 'receive'}
  <div class="panel sf-card">
    <span class="label">Vault address</span>
    <code class="address">{address || 'Deploy the vault first.'}</code>
    {#if address}
      <div class="row">
        <span class="sf-muted">{shortAddress(address)}</span>
        <button class="sf-btn sf-btn--quiet" onclick={() => copy(address)}>
          {copied === address ? 'Copied' : 'Copy address'}
        </button>
      </div>
    {/if}
  </div>
{/if}

{#if panel === 'invite'}
  <div class="panel sf-card">
    <span class="label">Invite link</span>
    {#if inviting}
      <p class="sf-muted">Publishing the invite to Sepolia…</p>
    {:else if inviteUrl}
      <input class="link" type="text" readonly value={inviteUrl} onfocus={(e) => e.currentTarget.select()} />
      <button class="sf-btn sf-btn--quiet" onclick={() => copy(inviteUrl)}>
        {copied === inviteUrl ? 'Copied' : 'Copy link'}
      </button>
    {:else}
      <p class="sf-muted">Connect a wallet on Sepolia to publish the invite link.</p>
    {/if}
    {#if failure}<p class="error">{failure}</p>{/if}
  </div>
{/if}

<section class="members">
  <div class="head">
    <h2>Members</h2>
    {#if onRefresh}
      <button class="refresh" onclick={onRefresh}>Refresh</button>
    {/if}
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
        {/if}
      </li>
    {/each}
  </ul>
</section>

<p class="foot">
  Every payment is a Safe transaction: it needs {session.threshold} of {session.signers.length} owners to
  sign before it can run.
</p>

<style>
  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .eyebrow {
    font-size: 0.6875rem;
    color: var(--sf-muted);
  }

  h1 {
    margin: 0;
    font-size: 1.25rem;
    letter-spacing: -0.01em;
  }

  .faces {
    display: flex;
  }

  .faces span + span {
    margin-left: -0.45rem;
  }

  .faces .sf-avatar {
    border: 2px solid var(--sf-bg);
  }

  .more {
    background: #d0d5dd;
    color: var(--sf-ink);
  }

  .balance {
    display: grid;
    gap: 0.3rem;
    padding: 1rem 1.1rem;
    border-radius: var(--sf-radius-lg);
    background: var(--sf-primary);
    color: #fff;
  }

  .label {
    font-size: 0.75rem;
    opacity: 0.85;
  }

  .amount {
    font-size: 1.85rem;
    font-weight: 800;
    letter-spacing: -0.02em;
  }

  .unit {
    font-size: 0.9rem;
    font-weight: 600;
    margin-left: 0.35rem;
  }

  .unavailable {
    font-size: 0.9375rem;
    font-weight: 600;
  }

  .meta {
    display: flex;
    gap: 1rem;
    font-size: 0.75rem;
    opacity: 0.9;
  }

  .net {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }

  .actions {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.5rem;
  }

  .action {
    display: grid;
    justify-items: center;
    gap: 0.3rem;
    padding: 0.75rem 0.4rem;
    border: 1px solid var(--sf-line);
    border-radius: var(--sf-radius-md);
    background: var(--sf-surface);
    font: 600 0.8125rem var(--sf-font);
    color: var(--sf-ink);
    cursor: pointer;
  }

  .action:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .icon {
    display: grid;
    place-items: center;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 50%;
    background: var(--sf-primary-soft);
    color: var(--sf-primary);
  }

  .panel {
    display: grid;
    gap: 0.5rem;
  }

  .panel .label {
    color: var(--sf-muted);
    opacity: 1;
    font-weight: 600;
  }

  .address {
    font-size: 0.8125rem;
    overflow-wrap: anywhere;
    color: var(--sf-ink-soft);
  }

  .link {
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--sf-line);
    border-radius: 10px;
    font: inherit;
    font-size: 0.8125rem;
    color: var(--sf-ink-soft);
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .error {
    margin: 0;
    color: var(--sf-warn-ink);
    font-size: 0.8125rem;
  }

  .members {
    display: grid;
    gap: 0.4rem;
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

  .refresh {
    border: none;
    background: none;
    color: var(--sf-primary);
    font: 600 0.75rem var(--sf-font);
    cursor: pointer;
  }

  .members ul {
    display: grid;
    gap: 0.4rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .members li {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    padding: 0.55rem 0.7rem;
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

  .foot {
    margin: auto 0 0;
    text-align: center;
    font-size: 0.6875rem;
    color: var(--sf-muted);
  }
</style>
