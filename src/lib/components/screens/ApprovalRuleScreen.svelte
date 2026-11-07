<script lang="ts">
  import MemberGroups from '../MemberGroups.svelte';
  import { memberGroups } from '../../session';
  import type { Session } from '../../session';

  let {
    session,
    threshold,
    onThreshold,
    onCreateVault,
    busy = false,
    error = '',
  }: {
    session: Session;
    threshold: number;
    onThreshold: (n: number) => void;
    onCreateVault: () => void;
    busy?: boolean;
    error?: string;
  } = $props();

  /**
   * Owners the Safe will actually have. The threshold counts these, never the
   * invited names: an invited member holds no key yet and cannot approve.
   */
  const ownerCount = $derived(session.signers.length);
  const groups = $derived(memberGroups(session));
  const total = $derived(Math.max(ownerCount, 1));
  const invited = $derived(Math.max(groups.length - session.signers.length, 0));
  const recommended = $derived(Math.max(2, Math.ceil(total / 2)));

  function step(delta: number): void {
    const next = Math.min(Math.max(threshold + delta, 1), total);
    if (next !== threshold) onThreshold(next);
  }
</script>

<h1>How many approvals to move money?</h1>
<p class="lede">Pick how many family members must say yes before a payment goes through.</p>

<div class="card sf-card">
  <div class="stepper">
    <button class="round" onclick={() => step(-1)} disabled={threshold <= 1} aria-label="Fewer approvals">−</button>
    <div class="count">
      <span class="big">{threshold}</span>
      <span class="of">of {total} {total === 1 ? 'member' : 'members'} with a key</span>
    </div>
    <button class="round" onclick={() => step(1)} disabled={threshold >= total} aria-label="More approvals">+</button>
  </div>

  <MemberGroups {groups} {threshold} variant="faces" />

  {#if threshold === recommended && total > 1}
    <p class="rec"><span class="sf-chip sf-chip--ok">✓ Recommended for {total} people</span></p>
  {/if}

  {#if invited > 0}
    <p class="invited">
      {invited} invited {invited === 1 ? 'member' : 'members'} cannot approve until they join with their own key.
    </p>
  {/if}
</div>

{#if threshold === 1 && total > 1}
  <p class="warn">
    A threshold of 1 makes this a single-key wallet. Raise it before you deploy.
  </p>
{/if}

<div class="explain">
  <svg class="bulb" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
    <path d="M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3Z" stroke-linejoin="round" />
    <path d="M9.5 19h5" stroke-linecap="round" />
  </svg>
  <p>
    {#if threshold === 1 && total > 1}
      One person alone can move the money. For a family vault, pick at least two so a lost phone
      cannot lock anyone out or spend on its own.
    {:else if total === 1}
      With one key, that key alone moves the money. Invite your family and they can be added as
      owners once they join.
    {:else}
      Any {threshold} of you must agree before money moves. If one phone gets lost, the other
      {total - 1} can still open the vault.
    {/if}
  </p>
</div>

{#if error}
  <p class="warn">{error}</p>
{/if}

<div class="cta">
  <button class="sf-btn" onclick={onCreateVault} disabled={busy}>
    {busy ? 'Creating the vault…' : 'Create family vault'}
  </button>
</div>

<style>
  h1 {
    margin: 0;
    font-size: 1.5rem;
    line-height: 1.25;
    letter-spacing: -0.02em;
  }

  .lede {
    margin: 0;
    color: var(--sf-muted);
    font-size: 0.9375rem;
  }

  .card {
    display: grid;
    gap: 1rem;
    justify-items: center;
  }

  .stepper {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .round {
    display: grid;
    place-items: center;
    width: 2.25rem;
    height: 2.25rem;
    border: 1px solid var(--sf-line);
    border-radius: 50%;
    background: var(--sf-surface);
    font-size: 1.1rem;
    color: var(--sf-ink);
    cursor: pointer;
  }

  .round:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .count {
    display: grid;
    justify-items: center;
    min-width: 6rem;
  }

  .big {
    font-size: 2.5rem;
    font-weight: 800;
    line-height: 1;
    color: var(--sf-primary);
  }

  .of {
    font-size: 0.8125rem;
    color: var(--sf-muted);
  }

  .rec {
    margin: 0;
  }

  .invited {
    margin: 0;
    font-size: 0.75rem;
    color: var(--sf-muted);
    text-align: center;
  }

  .warn {
    margin: 0;
    padding: 0.6rem 0.75rem;
    border-radius: var(--sf-radius-md);
    background: var(--sf-warn-bg);
    color: var(--sf-warn-ink);
    font-size: 0.8125rem;
  }

  .explain {
    display: flex;
    gap: 0.6rem;
    padding: 0.85rem;
    border-radius: var(--sf-radius-md);
    background: var(--sf-primary-soft);
  }

  .explain p {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--sf-ink-soft);
    line-height: 1.45;
  }

  .bulb {
    flex: none;
    color: var(--sf-primary);
    margin-top: 0.1rem;
  }

  .cta {
    margin-top: auto;
  }
</style>
