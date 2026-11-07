<script lang="ts">
  import { formatEth, formatUsd, shortAddress } from '../../format';
  import type { CostContext } from '../../costs';

  let {
    status,
    message,
    predicted,
    cost = null,
    costBusy = false,
    txHash,
    onRetry,
    onClose,
  }: {
    status: 'predicting' | 'awaitingWallet' | 'deploying' | 'error';
    message: string;
    predicted?: `0x${string}`;
    cost?: CostContext | null;
    costBusy?: boolean;
    txHash?: `0x${string}`;
    onRetry: () => void;
    onClose?: () => void;
  } = $props();
</script>

<div class="overlay" role="dialog" aria-modal="true" aria-label="Deploying the family vault">
  <div class="sheet sf-card">
    {#if status === 'error'}
      <span class="mark mark--error" aria-hidden="true">!</span>
    {:else}
      <span class="spinner" aria-hidden="true"></span>
    {/if}

    <h2>{status === 'error' ? 'The vault was not deployed' : 'Creating your family vault'}</h2>
    <p class="message">{message}</p>

    {#if predicted}
      <dl class="facts">
        <dt>Vault address</dt>
        <dd><code>{predicted}</code></dd>
      </dl>
    {/if}

    {#if costBusy}
      <p class="sf-muted">Reading the live deploy cost…</p>
    {:else if cost?.status === 'ready'}
      <p class="cost">
        ≈ {formatEth(cost.gas.feeWei)} ETH
        {#if cost.price}(≈ {formatUsd(cost.gas.feeWei, cost.price.usd)}){/if}
      </p>
    {:else if cost}
      <p class="sf-muted">Gas estimate unavailable: {cost.reason}</p>
    {/if}

    {#if txHash}
      <p class="sf-muted">Transaction {shortAddress(txHash)} sent; waiting for its receipt.</p>
    {/if}

    {#if status === 'error'}
      <div class="row">
        <button class="sf-btn" onclick={onRetry}>Try again</button>
        {#if onClose}
          <button class="sf-btn sf-btn--ghost" onclick={onClose}>Close</button>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: end center;
    padding: 1rem;
    background: rgb(16 24 40 / 0.45);
    z-index: 20;
  }

  @media (min-width: 480px) {
    .overlay {
      place-items: center;
    }
  }

  .sheet {
    display: grid;
    gap: 0.7rem;
    justify-items: center;
    width: 100%;
    max-width: 420px;
    text-align: center;
  }

  h2 {
    margin: 0;
    font-size: 1.05rem;
  }

  .message {
    margin: 0;
    font-size: 0.875rem;
    color: var(--sf-muted);
  }

  .spinner {
    width: 2.25rem;
    height: 2.25rem;
    border-radius: 50%;
    border: 3px solid var(--sf-primary-soft);
    border-top-color: var(--sf-primary);
    animation: spin 0.9s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .mark--error {
    display: grid;
    place-items: center;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: 50%;
    background: var(--sf-warn-bg);
    color: var(--sf-warn-ink);
    font-weight: 800;
  }

  .facts {
    display: grid;
    gap: 0.15rem;
    margin: 0;
    width: 100%;
    justify-items: center;
  }

  .facts dt {
    font-size: 0.6875rem;
    color: var(--sf-muted);
  }

  .facts dd {
    margin: 0;
    font-size: 0.6875rem;
    overflow-wrap: anywhere;
  }

  .cost {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--sf-ink-soft);
  }

  .row {
    display: grid;
    gap: 0.5rem;
    width: 100%;
  }
</style>
