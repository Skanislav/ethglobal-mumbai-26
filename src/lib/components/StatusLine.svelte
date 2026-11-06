<script lang="ts">
  type Tone = 'info' | 'busy' | 'ok' | 'error';

  let {
    status = 'idle' as 'idle' | 'busy' | 'ok' | 'error' | 'info',
    message = '',
    detail = '',
  }: { status?: 'idle' | 'busy' | 'ok' | 'error' | 'info'; message?: string; detail?: string } = $props();

  const tone: Tone = $derived(status === 'busy' ? 'busy' : status === 'ok' ? 'ok' : status === 'error' ? 'error' : 'info');
</script>

{#if message}
  <p class="status {tone}" role={status === 'error' ? 'alert' : 'status'}>
    <span class="dot" aria-hidden="true"></span>
    <span class="text">{message}</span>
    {#if detail}<span class="detail">{detail}</span>{/if}
  </p>
{/if}

<style>
  .status {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    margin: 0.5rem 0;
    font-size: 0.875rem;
    line-height: 1.4;
  }
  .dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 999px;
    background: currentColor;
    flex: none;
  }
  .busy {
    color: #8a6d00;
  }
  .ok {
    color: #136b28;
  }
  .error {
    color: #a11a1a;
  }
  .info {
    color: #444;
  }
  .detail {
    opacity: 0.75;
    font-size: 0.8125rem;
  }
</style>
