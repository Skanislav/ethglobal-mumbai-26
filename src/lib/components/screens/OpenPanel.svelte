<script lang="ts">
  import { onMount } from 'svelte';
  import StatusLine from '../StatusLine.svelte';
  import { addressRejection, checksum, humanError } from '../../format';
  import { ANON_RPC_SPECIFIER } from '../../chains';
  import {
    privateReads,
    privateReadsLabel,
    disablePrivateReads,
    enablePrivateReads,
    startPrivateReads,
  } from '../../privateReads.svelte';

  let {
    onOpen,
    onImportBlob,
  }: {
    /** Takes an invite link or a Safe address; throws with a human message. */
    onOpen: (value: string) => Promise<void>;
    onImportBlob: (event: Event) => void;
  } = $props();

  let input = $state('');
  let busy = $state(false);
  let failure = $state('');

  onMount(() => {
    startPrivateReads();
  });

  function toggleReads(): void {
    if (privateReads.enabled) disablePrivateReads();
    else enablePrivateReads();
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    failure = '';
    const value = input.trim();
    if (!value) {
      failure = 'Paste an invite link or a Safe address.';
      return;
    }
    // A Safe address is validated here so an ENS name or a typo never reaches the RPC.
    if (!/^https?:|#\/invite\//.test(value)) {
      const rejection = addressRejection(value);
      if (rejection) {
        failure = rejection;
        return;
      }
    }
    busy = true;
    try {
      await onOpen(/^https?:|#\/invite\//.test(value) ? value : checksum(value));
    } catch (err) {
      // Named blob/session errors carry the actionable sentence; a bare Error is the
      // page's own validation message and reads correctly as-is.
      failure = humanError(err);
    } finally {
      busy = false;
    }
  }
</script>

<details class="open">
  <summary>I already have a vault or an invite</summary>

  <form onsubmit={submit}>
    <label for="open-value">Invite link or Safe address</label>
    <input
      id="open-value"
      type="text"
      placeholder="https://…/#/invite/… or 0x…"
      bind:value={input}
      oninput={() => (failure = '')}
    />
    <button class="sf-btn sf-btn--quiet" type="submit" disabled={busy}>
      {busy ? 'Reading…' : 'Open'}
    </button>
  </form>

  {#if failure}
    <StatusLine status="error" message={failure} />
  {/if}

  <label class="file">
    Import a session file
    <input type="file" accept="application/json" onchange={onImportBlob} />
  </label>

  <div class="reads">
    <label>
      <input type="checkbox" checked={privateReads.enabled} onchange={toggleReads} />
      Private reads
    </label>
    <span class="reads-label">{privateReadsLabel()}</span>
    {#if privateReads.enabled && privateReads.status === 'ready'}
      <code class="specifier">{ANON_RPC_SPECIFIER}</code>
    {:else if privateReads.enabled && privateReads.status === 'unavailable'}
      <StatusLine
        status="error"
        message={`Private reads unavailable: ${privateReads.reason ?? 'unknown reason'}`}
      />
    {/if}
    <p class="hint">
      Reads can go through an anon-rpc sandbox so a fixed gateway does not learn which Safe you are
      inspecting. Writes always go to the plain Sepolia RPC, where they are public anyway.
    </p>
  </div>
</details>

<style>
  .open {
    border-top: 1px solid var(--sf-line);
    padding-top: 0.6rem;
    font-size: 0.8125rem;
    text-align: left;
  }

  summary {
    cursor: pointer;
    color: var(--sf-ink-soft);
    font-weight: 600;
  }

  form {
    display: grid;
    gap: 0.35rem;
    margin-top: 0.6rem;
    justify-items: start;
  }

  form input {
    width: 100%;
    box-sizing: border-box;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--sf-line);
    border-radius: 10px;
    font: inherit;
    font-size: 0.8125rem;
  }

  .file {
    display: grid;
    gap: 0.25rem;
    margin-top: 0.6rem;
    color: var(--sf-muted);
  }

  .reads {
    display: grid;
    gap: 0.25rem;
    margin-top: 0.75rem;
    padding: 0.6rem;
    border: 1px solid var(--sf-line);
    border-radius: 10px;
  }

  .reads-label,
  .hint {
    color: var(--sf-muted);
    font-size: 0.75rem;
  }

  .specifier {
    font-size: 0.6875rem;
    overflow-wrap: anywhere;
  }

  .hint {
    margin: 0;
  }
</style>
