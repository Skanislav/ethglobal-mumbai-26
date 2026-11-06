<script lang="ts">
  import StatusLine from './StatusLine.svelte';
  import { addressRejection, checksum, etherscanTx, formatEth, formatUsd, humanError, shortAddress } from '../format';
  import { readCostContext } from '../costs';
  import type { CostContext } from '../costs';
  import type { SignerRecord } from '../signer-types';
  import { encodeSession } from '../session';
  import type { Session } from '../session';
  import { signRecord } from '../signers';
  import { haloStatusText } from '../signers/halo';
  import type { HaloStatus } from '../signers/halo';
  import { safeTxHashParts } from '../safeTxDigest';
  import { sendFromWallet, waitForReceipt } from '../safe';
  import { connectInjected } from '../signers/hotWallet';

  let {
    session,
    onPrepare,
    onSignerSigned,
    executeCall,
    onExecuted,
  }: {
    session: Session;
    onPrepare: (to: `0x${string}`) => Promise<void>;
    onSignerSigned: (owner: `0x${string}`, blob: `0x${string}`, isContract: boolean) => void;
    executeCall: () => Promise<{ to: `0x${string}`; data: `0x${string}`; nonce: number }>;
    onExecuted: (txHash: `0x${string}`) => Promise<void>;
  } = $props();

  let targetInput = $state('');
  let targetError = $state('');
  let signBusy = $state<string | null>(null);
  let signStatus = $state<{ kind: 'busy' | 'ok' | 'error'; message: string; detail?: string } | null>(null);
  let prepBusy = $state(false);
  let execBusy = $state(false);
  let execStatus = $state<{ kind: 'busy' | 'ok' | 'error'; message: string; detail?: string } | null>(null);
  let cost = $state<CostContext | null>(null);
  let exportBlob = $state('');
  let lastTx = $state('');

  const defaultTarget = $derived(session.signers[0]?.address ?? '');
  const signatures = $derived(session.pending?.signatures ?? {});
  const signedOwners = $derived(Object.keys(signatures));
  const unsignedBlockers = $derived(session.signers.filter((s) => !s.canSign));
  const canExecute = $derived(signedOwners.length >= session.threshold);
  const pending = $derived(session.pending);

  async function prepare(): Promise<void> {
    const raw = targetInput.trim() || defaultTarget;
    const rejection = addressRejection(raw);
    targetError = rejection ?? '';
    if (rejection) return;
    prepBusy = true;
    try {
      await onPrepare(checksum(raw));
    } catch (err) {
      targetError = humanError(err);
    } finally {
      prepBusy = false;
    }
  }

  async function sign(record: SignerRecord): Promise<void> {
    if (!pending) return;
    signBusy = record.address;
    signStatus = { kind: 'busy', message: `Waiting for ${record.label}…` };
    try {
      // Every field comes from the stored proposal: for a MultiSend batch the `to`
      // is MultiSend and `operation` is 1, so reconstructing them here would sign a
      // different transaction than the one being executed.
      const ctx = {
        safeAddress: session.safeAddress as `0x${string}`,
        chainId: 11155111,
        safeTxHash: pending.safeTxHash,
        ownerAddress: record.address,
        data: {
          to: pending.to,
          value: pending.value,
          data: pending.data,
          operation: pending.operation,
          safeTxGas: pending.safeTxGas,
          baseGas: pending.baseGas,
          gasPrice: pending.gasPrice,
          gasToken: pending.gasToken,
          refundReceiver: pending.refundReceiver,
          nonce: pending.nonce,
        },
      } as const;
      // Prove the digest the stored fields produce is the one the owners were asked to
      // sign; a mismatch aborts before a device ever prompts.
      safeTxHashParts(ctx);
      const signature = await signRecord(record, ctx, {
        onHaloStatus: (status) => (signStatus = { kind: 'busy', message: haloStatusText(status as HaloStatus) }),
      });
      onSignerSigned(record.address, signature.data as `0x${string}`, signature.isContractSignature);
      signStatus = { kind: 'ok', message: `${record.label} signed.` };
    } catch (err) {
      signStatus = { kind: 'error', message: humanError(err) };
    } finally {
      signBusy = null;
    }
  }

  async function previewCost(): Promise<void> {
    try {
      const call = await executeCall();
      cost = await readCostContext({ to: call.to, data: call.data });
    } catch (err) {
      cost = { status: 'gas-unavailable', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async function execute(): Promise<void> {
    execBusy = true;
    execStatus = { kind: 'busy', message: 'Confirm the execution in your wallet…' };
    try {
      const call = await executeCall();
      const payer = await connectInjected('Executor');
      const hash = await sendFromWallet(payer.provider, payer.address, { to: call.to, data: call.data });
      execStatus = { kind: 'busy', message: 'Waiting for the receipt…', detail: hash };
      const receipt = await waitForReceipt(hash);
      await onExecuted(hash);
      lastTx = hash;
      execStatus = {
        kind: receipt.status === 'success' ? 'ok' : 'error',
        message:
          receipt.status === 'success'
            ? `Test transaction executed. New nonce: ${call.nonce + 1}`
            : 'The transaction reverted onchain; nothing moved.',
        detail: hash,
      };
    } catch (err) {
      execStatus = { kind: 'error', message: humanError(err) };
    } finally {
      execBusy = false;
    }
  }

  function exportSession(): void {
    exportBlob = encodeSession(session);
    void navigator.clipboard?.writeText(exportBlob).catch(() => undefined);
  }

  function downloadSession(): void {
    const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `safe-session-${session.safeAddress ?? 'draft'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
</script>

<section class="step">
  <h2>Verify</h2>
  <p class="lede">
    One test transaction proves the multisig works: the Safe executes a call to an owner and its
    nonce advances.
  </p>

  <div class="target">
    <label for="to">Recipient of the test call (defaults to the first owner)</label>
    <input id="to" type="text" placeholder={defaultTarget} bind:value={targetInput} />
    <button onclick={prepare} disabled={prepBusy || session.signers.length === 0}>
      {prepBusy ? 'Building…' : pending ? 'Rebuild proposal' : 'Build proposal'}
    </button>
    {#if targetError}<StatusLine status="error" message={targetError} />{/if}
  </div>

  <dl class="facts">
    <dt>Safe</dt>
    <dd><code>{session.safeAddress ?? 'not deployed yet'}</code></dd>
    <dt>Safe tx hash</dt>
    <dd><code>{pending?.safeTxHash ?? 'build a proposal to get one'}</code></dd>
    <dt>Signatures</dt>
    <dd>{signedOwners.length} collected · {session.threshold} needed</dd>
  </dl>

  <ul class="signers">
    {#each session.signers as signer (signer.address)}
      <li>
        <span class="label">{signer.label}</span>
        <code>{shortAddress(signer.address)}</code>
        {#if signedOwners.includes(signer.address.toLowerCase())}
          <span class="signed">signed</span>
        {:else if !signer.canSign}
          <span class="blocked">cannot sign here</span>
        {:else}
          <button onclick={() => sign(signer)} disabled={signBusy !== null || !pending}>
            {signBusy === signer.address ? 'Waiting…' : 'Sign'}
          </button>
        {/if}
      </li>
    {/each}
  </ul>

  {#if signStatus}
    <StatusLine status={signStatus.kind} message={signStatus.message} detail={signStatus.detail} />
  {/if}

  {#if unsignedBlockers.length > 0}
    <p class="badge">
      These owners cannot sign in this browser: {unsignedBlockers.map((s) => s.label).join(', ')}.
      Remove and re-export, or have them sign in their own session.
    </p>
  {/if}

  <div class="cost">
    <button onclick={previewCost} disabled={!pending}>Estimate execution cost</button>
    {#if cost}
      {#if cost.status === 'ready'}
        <p class="line">
          ≈ {formatEth(cost.gas.feeWei)} ETH
          {#if cost.price}
            (≈ {formatUsd(cost.gas.feeWei, cost.price.usd)} · Sepolia test feed)
          {:else}
            · USD price unavailable{cost.priceError ? ` (${cost.priceError})` : ''}
          {/if}
        </p>
      {:else}
        <StatusLine status="error" message={`Gas estimate unavailable: ${cost.reason}`} />
      {/if}
    {/if}
  </div>

  <button class="primary" onclick={execute} disabled={execBusy || !canExecute}>
    {execBusy ? 'Executing…' : 'Execute test transaction'}
  </button>

  {#if execStatus}
    <StatusLine status={execStatus.kind} message={execStatus.message} detail={execStatus.detail} />
  {/if}

  {#if lastTx}
    <p class="line">
      <a href={etherscanTx(lastTx)} target="_blank" rel="noreferrer">View on Etherscan</a>
      {#if session.executedTxHashes.length > 0}
        · {session.executedTxHashes.length} executed in this session
      {/if}
    </p>
  {/if}

  <div class="export">
    <button onclick={exportSession}>Copy session link</button>
    <button onclick={downloadSession}>Download session .json</button>
    <p class="hint">
      The export carries public data only: addresses, threshold, labels. Never a key. Anyone with it
      can rebuild the same Safe view.
    </p>
    {#if exportBlob}
      <textarea readonly rows="4" value={exportBlob}></textarea>
    {/if}
  </div>
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
  .target {
    display: grid;
    gap: 0.35rem;
    justify-items: start;
  }
  .target input {
    width: min(100%, 34rem);
    font-family: ui-monospace, monospace;
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
  .signers {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.4rem;
  }
  .signers li {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    font-size: 0.875rem;
  }
  .signed {
    color: #136b28;
  }
  .blocked {
    color: #a11a1a;
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
  .badge {
    margin: 0;
    padding: 0.4rem 0.6rem;
    background: #fff4d6;
    border: 1px solid #e0c070;
    border-radius: 6px;
    font-size: 0.8125rem;
  }
  .hint {
    margin: 0;
    font-size: 0.8125rem;
    color: #666;
    max-width: 52ch;
  }
  .export {
    display: grid;
    gap: 0.5rem;
    justify-items: start;
  }
  .export textarea {
    width: min(100%, 34rem);
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
  }
</style>
