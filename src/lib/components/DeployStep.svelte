<script lang="ts">
  import StatusLine from './StatusLine.svelte';
  import { checksum, formatEth, formatUsd, humanError, shortAddress } from '../format';
  import { readCostContext } from '../costs';
  import type { CostContext } from '../costs';
  import type { SignerRecord } from '../signer-types';
  import { sendFromWallet, waitForReceipt } from '../safe';
  import { connectInjected } from '../signers/hotWallet';

  let {
    signers = [],
    threshold = 1,
    predicted = '',
    mode = 'create',
    saltNonce = '',
    onNewSalt,
    onDeployed,
    deployCall,
    existingThreshold = 1,
    onInstallOwners,
  }: {
    signers?: SignerRecord[];
    threshold?: number;
    predicted?: string;
    mode?: 'create' | 'existing';
    saltNonce?: string;
    onNewSalt: () => void;
    onDeployed: () => void;
    deployCall: () => Promise<{ to: `0x${string}`; data: `0x${string}`; value: string; predictedAddress: `0x${string}` }>;
    existingThreshold?: number;
    onInstallOwners: (passkeys: SignerRecord[], nextThreshold: number) => Promise<void>;
  } = $props();

  let deployBusy = $state(false);
  let deployStatus = $state<{ kind: 'busy' | 'ok' | 'error'; message: string; detail?: string } | null>(null);
  let cost = $state<CostContext | null>(null);
  let costBusy = $state(false);

  const passkeys = $derived(signers.filter((s) => s.kind === 'passkey'));

  async function previewCost(): Promise<void> {
    costBusy = true;
    try {
      const call = await deployCall();
      cost = await readCostContext({ to: call.to, data: call.data, value: call.value });
    } catch (err) {
      cost = { status: 'gas-unavailable', reason: err instanceof Error ? err.message : String(err) };
    } finally {
      costBusy = false;
    }
  }

  async function deploy(): Promise<void> {
    deployBusy = true;
    deployStatus = { kind: 'busy', message: 'Confirm the deployment in your wallet…' };
    try {
      const call = await deployCall();
      const payer = await connectInjected('Deploy payer');
      const hash = await sendFromWallet(payer.provider, payer.address, {
        to: call.to,
        data: call.data,
        value: call.value,
      });
      deployStatus = { kind: 'busy', message: 'Waiting for the deployment receipt…', detail: hash };
      await waitForReceipt(hash);
      // Authoritative refetch: the deployed state comes from chain, not local state.
      onDeployed();
      deployStatus = { kind: 'ok', message: `Safe deployed at ${shortAddress(call.predictedAddress)}`, detail: hash };
    } catch (err) {
      deployStatus = { kind: 'error', message: humanError(err) };
    } finally {
      deployBusy = false;
    }
  }

  async function installOwners(): Promise<void> {
    deployBusy = true;
    deployStatus = { kind: 'busy', message: 'Confirm the owner-install batch in your wallet…' };
    try {
      await onInstallOwners(passkeys, threshold);
      // Proposed, not sent: the batch needs the existing owners' threshold signatures.
      deployStatus = { kind: 'ok', message: 'Batch proposed. Collect signatures in the Verify step.' };
    } catch (err) {
      deployStatus = { kind: 'error', message: humanError(err) };
    } finally {
      deployBusy = false;
    }
  }
</script>

<section class="step">
  <h2>{mode === 'create' ? 'Deploy' : 'Update owners'}</h2>

  {#if mode === 'create'}
    <p class="lede">
      The Safe is deployed with exactly this owner list and threshold. Its address is fixed by the
      owners, the threshold, and the salt — so it is knowable before anything is sent.
    </p>

    <dl class="facts">
      <dt>Predicted address</dt>
      <dd><code>{predicted || 'add signers and a threshold first'}</code></dd>
      <dt>Owners</dt>
      <dd>{signers.length} ({signers.map((s) => s.kind).join(', ')})</dd>
      <dt>Threshold</dt>
      <dd>{threshold} of {signers.length}</dd>
      <dt>Salt nonce</dt>
      <dd>
        <code>{saltNonce}</code>
        <button class="link" onclick={onNewSalt}>new salt</button>
      </dd>
    </dl>

    <div class="cost">
      <button onclick={previewCost} disabled={costBusy || signers.length === 0}>
        {costBusy ? 'Estimating…' : 'Estimate deploy cost'}
      </button>
      {#if cost}
        {#if cost.status === 'ready'}
          <p class="line">
            ≈ {formatEth(cost.gas.feeWei)} ETH
            {#if cost.price}
              (≈ {formatUsd(cost.gas.feeWei, cost.price.usd)} · Sepolia test feed, read
              {new Date(cost.price.fetchedAt).toLocaleTimeString()})
            {:else}
              · USD price unavailable{cost.priceError ? ` (${cost.priceError})` : ''}
            {/if}
          </p>
        {:else}
          <StatusLine status="error" message={`Gas estimate unavailable: ${cost.reason}`} />
        {/if}
      {/if}
    </div>

    <button class="primary" onclick={deploy} disabled={deployBusy || signers.length === 0 || !predicted}>
      {deployBusy ? 'Deploying…' : 'Deploy Safe'}
    </button>

    {#if passkeys.length > 0}
      <p class="hint">
        {passkeys.length} passkey owner{passkeys.length === 1 ? '' : 's'} will need
        <code>factory.createSigner</code> before they can sign; the Safe accepts them as owners from the
        start.
      </p>
    {/if}
  {:else}
    <p class="lede">
      This Safe already exists. Adding passkey owners is one batched Safe transaction:
      <code>factory.createSigner</code> for each passkey, then <code>addOwnerWithThreshold</code>.
    </p>
    <dl class="facts">
      <dt>Safe</dt>
      <dd><code>{predicted}</code></dd>
      <dt>Current onchain threshold</dt>
      <dd>{existingThreshold}</dd>
      <dt>Passkey owners to install</dt>
      <dd>{passkeys.length}</dd>
      <dt>New threshold</dt>
      <dd>{threshold}</dd>
    </dl>
    <button class="primary" onclick={installOwners} disabled={deployBusy}>
      {deployBusy ? 'Submitting…' : 'Install owners and change threshold'}
    </button>
  {/if}

  {#if deployStatus}
    <StatusLine status={deployStatus.kind} message={deployStatus.message} detail={deployStatus.detail} />
  {/if}

  <p class="hint">
    The deployer pays gas and need not be an owner. Every address used here resolves from the Safe
    deployment registries; the app ships no contracts of its own.
  </p>
</section>

<style>
  .step {
    display: grid;
    gap: 1rem;
  }
  .lede {
    margin: 0;
    max-width: 52ch;
  }
  .facts {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.35rem 1rem;
    margin: 0;
    font-size: 0.875rem;
  }
  .facts dt {
    color: #555;
  }
  .facts dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .cost {
    display: flex;
    gap: 0.75rem;
    align-items: baseline;
    flex-wrap: wrap;
  }
  .line {
    margin: 0;
    font-size: 0.875rem;
  }
  .hint {
    margin: 0;
    font-size: 0.8125rem;
    color: #666;
    max-width: 52ch;
  }
  .link {
    border: none;
    background: none;
    padding: 0;
    margin-left: 0.5rem;
    color: #1a5fb4;
    text-decoration: underline;
    cursor: pointer;
    font-size: 0.8125rem;
  }
</style>
