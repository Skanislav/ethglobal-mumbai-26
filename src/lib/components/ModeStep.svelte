<script lang="ts">
  import { onMount } from 'svelte';
  import StatusLine from './StatusLine.svelte';
  import { addressRejection, checksum } from '../format';
  import { ANON_RPC_SPECIFIER } from '../chains';
  import {
    privateReads,
    privateReadsLabel,
    disablePrivateReads,
    enablePrivateReads,
    startPrivateReads,
  } from '../privateReads.svelte';
  import type { SessionMode } from '../session';

  let {
    onChoose,
    onExisting,
  }: {
    onChoose: (mode: SessionMode) => void;
    onExisting: (safeAddress: `0x${string}`) => Promise<void>;
  } = $props();

  let existingInput = $state('');
  let existingBusy = $state(false);
  let existingError = $state('');

  onMount(() => {
    startPrivateReads();
  });

  function toggleReads(): void {
    if (privateReads.enabled) disablePrivateReads();
    else enablePrivateReads();
  }

  async function submitExisting(): Promise<void> {
    const rejection = addressRejection(existingInput);
    existingError = rejection ?? '';
    if (rejection) return;
    existingBusy = true;
    try {
      await onExisting(checksum(existingInput));
    } catch (err) {
      existingError = err instanceof Error ? err.message : String(err);
    } finally {
      existingBusy = false;
    }
  }
</script>

<section class="step">
  <h2>Start</h2>

  <div class="reads">
    <label>
      <input type="checkbox" checked={privateReads.enabled} onchange={toggleReads} />
      Private reads
    </label>
    <span class="reads-label">{privateReadsLabel()}</span>
    {#if privateReads.enabled && privateReads.status === 'ready'}
      <code class="specifier">{ANON_RPC_SPECIFIER}</code>
    {:else if privateReads.enabled && privateReads.status === 'unavailable'}
      <StatusLine status="error" message={`Private reads unavailable: ${privateReads.reason ?? 'unknown reason'}`} />
    {/if}
    <p class="hint">
      Reads can go through an anon-rpc sandbox so a fixed gateway does not learn which Safe you are
      inspecting. Writes always go to the plain Sepolia RPC, where they are public anyway.
    </p>
  </div>

  <div class="modes">
    <button class="primary" onclick={() => onChoose('create')}>Create a new Safe</button>
    <div class="existing">
      <label for="existing-safe">Or open an existing Safe on Sepolia</label>
      <input
        id="existing-safe"
        type="text"
        placeholder="0x…"
        bind:value={existingInput}
        oninput={() => (existingError = '')}
      />
      <button onclick={submitExisting} disabled={existingBusy}>
        {existingBusy ? 'Reading…' : 'Open existing Safe'}
      </button>
      {#if existingError}
        <StatusLine status="error" message={existingError} />
      {/if}
      <p class="hint">Hex address only; ENS names are out of scope on a Sepolia-only tool.</p>
    </div>
  </div>
</section>

<style>
  .step {
    display: grid;
    gap: 1.5rem;
  }
  .reads {
    display: grid;
    gap: 0.25rem;
    padding: 0.75rem;
    border: 1px solid #d8d8d8;
    border-radius: 8px;
  }
  .reads-label {
    font-size: 0.875rem;
    color: #333;
  }
  .specifier {
    font-size: 0.75rem;
    color: #555;
    overflow-wrap: anywhere;
  }
  .modes {
    display: grid;
    gap: 1.25rem;
  }
  .existing {
    display: grid;
    gap: 0.5rem;
    justify-items: start;
  }
  .hint {
    margin: 0;
    font-size: 0.8125rem;
    color: #666;
  }
  button.primary {
    justify-self: start;
  }
</style>
