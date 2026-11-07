<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    step = 0,
    total = 0,
    onBack,
    header,
    actions,
    children,
  }: {
    /** 1-based position in the flow; 0 hides the progress bar. */
    step?: number;
    total?: number;
    onBack?: () => void;
    header?: Snippet;
    actions?: Snippet;
    children: Snippet;
  } = $props();
</script>

<div class="phone">
  <div class="top">
    {#if onBack}
      <button class="back" onclick={onBack} aria-label="Go back">‹</button>
    {:else}
      <span class="back back--empty" aria-hidden="true"></span>
    {/if}
    {#if total > 0}
      <div class="bars" aria-label="Step {step} of {total}">
        {#each Array.from({ length: total }, (_, i) => i + 1) as index (index)}
          <span class={['bar', { on: index <= step }]}></span>
        {/each}
      </div>
      <span class="count">{step}/{total}</span>
    {:else}
      <span class="count" aria-hidden="true"></span>
    {/if}
  </div>

  {#if header}
    {@render header()}
  {/if}

  {@render children()}

  {#if actions}
    <div class="actions">{@render actions()}</div>
  {/if}
</div>

<style>
  .phone {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    min-height: 100dvh;
    width: 100%;
    max-width: 420px;
    margin-inline: auto;
    padding: 1rem 1.1rem calc(1rem + env(safe-area-inset-bottom));
    box-sizing: border-box;
  }

  /* On a wide viewport the flow keeps the phone frame instead of stretching. */
  @media (min-width: 480px) {
    .phone {
      min-height: auto;
      margin-block: 2rem;
      border-radius: 28px;
      background: var(--sf-surface);
      box-shadow: var(--sf-shadow);
      padding-bottom: 1.25rem;
    }
  }

  .top {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-height: 2rem;
  }

  .back {
    display: grid;
    place-items: center;
    width: 2rem;
    height: 2rem;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: var(--sf-ink);
    font-size: 1.5rem;
    line-height: 1;
    cursor: pointer;
  }

  .back--empty {
    cursor: default;
  }

  .bars {
    display: flex;
    flex: 1;
    gap: 0.35rem;
  }

  .bar {
    height: 4px;
    flex: 1;
    border-radius: 999px;
    background: var(--sf-line);
  }

  .bar.on {
    background: var(--sf-primary);
  }

  .count {
    min-width: 2rem;
    text-align: right;
    font-size: 0.75rem;
    color: var(--sf-muted);
    font-variant-numeric: tabular-nums;
  }

  .actions {
    margin-top: auto;
    display: grid;
    gap: 0.6rem;
  }
</style>
