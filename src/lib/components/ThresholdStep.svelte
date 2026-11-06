<script lang="ts">
  import StatusLine from './StatusLine.svelte';

  let {
    count = 0,
    threshold = 1,
    onThreshold,
  }: { count?: number; threshold?: number; onThreshold: (n: number) => void } = $props();

  const max = $derived(Math.max(count, 1));

  /** Clamps to 1..count and only notifies when the value actually changed. */
  function commit(input: HTMLInputElement): void {
    const parsed = Number.parseInt(input.value, 10);
    const clamped = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), max) : threshold;
    input.value = String(clamped);
    if (clamped !== threshold) onThreshold(clamped);
  }
</script>

<section class="step">
  <h2>Threshold</h2>
  <p class="lede">How many of these {count} signers must approve before the Safe moves anything.</p>

  <div class="control">
    <label for="threshold">Required signatures</label>
    <input
      id="threshold"
      type="number"
      min="1"
      max={max}
      step="1"
      value={threshold}
      onchange={(event) => commit(event.currentTarget)}
      onblur={(event) => commit(event.currentTarget)}
    />
    <span class="of">of {count}</span>
  </div>

  {#if count > 0}
    <p class="consequence">
      {#if threshold === 1}
        Any one of these {count} can move the funds alone.
      {:else}
        Any {threshold} of these {count} can move the funds.
      {/if}
    </p>
  {:else}
    <StatusLine status="info" message="Add signers first; the threshold cannot exceed the owner count." />
  {/if}

  {#if threshold === 1 && count > 1}
    <StatusLine
      status="error"
      message="A threshold of 1 makes this a single-key wallet. Raise it before you deploy."
    />
  {/if}
</section>

<style>
  .step {
    display: grid;
    gap: 1rem;
  }
  .lede {
    margin: 0;
    max-width: 48ch;
  }
  .control {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .control input {
    width: 5rem;
  }
  .of {
    color: #555;
    font-size: 0.875rem;
  }
  .consequence {
    margin: 0;
    font-weight: 600;
  }
</style>
