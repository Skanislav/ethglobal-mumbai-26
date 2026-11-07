<script lang="ts">
  import { joinNames } from '../../format';
  import { memberGroups } from '../../session';
  import type { Session } from '../../session';
  import MemberGroups from '../MemberGroups.svelte';

  let {
    session,
    threshold,
    signerCount,
    onOpenVault,
    onTestPayment,
  }: {
    session: Session;
    threshold: number;
    signerCount: number;
    onOpenVault: () => void;
    onTestPayment?: () => void;
  } = $props();

  const groups = $derived(memberGroups(session));
  const joinedNames = $derived(groups.filter((m) => m.joined).map((m) => m.name));
  const invitedCount = $derived(groups.length - joinedNames.length);
</script>

<div class="ready">
  <span class="check" aria-hidden="true">
    <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#12B76A" stroke-width="3">
      <path d="M5 13l4.5 4.5L19 7" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </span>

  <h1>{session.vaultName || 'Your family vault'} is ready</h1>
  <p class="lede">
    {#if invitedCount === 0}
      {joinNames(joinedNames)} {joinedNames.length === 1 ? 'is' : 'are'} all in. Any {threshold} of you can approve a
      payment.
    {:else}
      {joinNames(joinedNames)} {joinedNames.length === 1 ? 'is' : 'are'} in. Any {threshold} of
      {signerCount} {signerCount === 1 ? 'key' : 'keys'} can approve a payment, and {invitedCount}
      {invitedCount === 1 ? 'invited member joins' : 'invited members join'} when they add a key.
    {/if}
  </p>

  <div class="faces-wrap">
    <MemberGroups {groups} variant="faces" />
  </div>

  <span class="sf-chip">
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <circle cx="9" cy="9" r="3" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" stroke-linecap="round" />
      <path d="M16 7.3a3 3 0 0 1 0 5.4M17.5 19a5.5 5.5 0 0 0-2-4.2" stroke-linecap="round" />
    </svg>
    {threshold} of {signerCount} approvals
  </span>
</div>

<div class="cta">
  <button class="sf-btn" onclick={onOpenVault}>Next: open your vault</button>
  {#if onTestPayment}
    <button class="sf-btn sf-btn--ghost" onclick={onTestPayment}>Send a test payment</button>
  {/if}
</div>

<style>
  .ready {
    display: grid;
    flex: 1;
    gap: 0.85rem;
    align-content: center;
    justify-items: center;
    text-align: center;
  }

  .check {
    display: grid;
    place-items: center;
    width: 4.5rem;
    height: 4.5rem;
    border-radius: 50%;
    background: var(--sf-success-bg);
    box-shadow: 0 0 0 12px rgb(18 183 106 / 0.08);
  }

  h1 {
    margin: 0.5rem 0 0;
    font-size: 1.6rem;
    line-height: 1.2;
    letter-spacing: -0.02em;
  }

  .lede {
    margin: 0;
    color: var(--sf-muted);
    font-size: 0.9375rem;
    line-height: 1.45;
    max-width: 26ch;
  }

  .faces-wrap {
    display: flex;
    justify-content: center;
  }

  .cta {
    display: grid;
    gap: 0.55rem;
    margin-top: auto;
  }
</style>
