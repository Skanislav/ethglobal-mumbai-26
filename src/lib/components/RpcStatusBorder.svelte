<script lang="ts">
  import { privateReads, privateReadsLabel } from '../privateReads.svelte';

  const state = $derived(
    !privateReads.enabled
      ? 'off'
      : privateReads.status === 'ready'
        ? 'ready'
        : privateReads.status === 'pending'
          ? 'pending'
          : 'error',
  );
</script>

<div class="rpc-border rpc-border--{state}" role="status" aria-label={privateReadsLabel()}>
  <span class="rpc-border__label rpc-border__label--{state}">{privateReadsLabel()}</span>
</div>

<style>
  .rpc-border {
    position: fixed;
    inset: 0;
    pointer-events: none; /* non-interactive; the toggle lives in OpenPanel */
    border: 3px solid;
    z-index: 9999;
  }
  .rpc-border--ready {
    border-color: var(--sf-primary, #12ff80);
  }
  .rpc-border--pending {
    border-color: #f0b429; /* yellow: sandbox booting */
  }
  .rpc-border--error {
    border-color: var(--sf-warn-ink, #c0392b);
  }
  .rpc-border--off {
    border-color: #9aa1ad; /* grey: plain gateway */
  }
  .rpc-border__label {
    position: absolute;
    top: 0;
    right: 0;
    padding: 0.15rem 0.5rem;
    font-size: 0.6875rem;
    border-bottom-left-radius: 8px;
    color: #fff;
    pointer-events: none;
  }
  .rpc-border__label--ready {
    background: var(--sf-primary, #12ff80);
    color: #0b2b17;
  }
  .rpc-border__label--pending {
    background: #f0b429;
    color: #3d2e00;
  }
  .rpc-border__label--error {
    background: var(--sf-warn-ink, #c0392b);
  }
  .rpc-border__label--off {
    background: #9aa1ad;
  }
</style>
