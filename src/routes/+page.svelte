<script lang="ts">
  import { onMount } from 'svelte';
  import ModeStep from '../lib/components/ModeStep.svelte';
  import SignerStep from '../lib/components/SignerStep.svelte';
  import ThresholdStep from '../lib/components/ThresholdStep.svelte';
  import DeployStep from '../lib/components/DeployStep.svelte';
  import VerifyStep from '../lib/components/VerifyStep.svelte';
  import StatusLine from '../lib/components/StatusLine.svelte';
  import { session, setSession, loadFromStorage, loadStep, saveStep } from '../lib/session.svelte';
  import {
    newSession,
    addSigner,
    removeSigner,
    renameSigner,
    setThreshold,
    encodeSession,
    decodeSession,
    normalizeSignerAvailability,
  } from '../lib/session';
  import type { Session, SessionMode } from '../lib/session';
  import type { SignerRecord } from '../lib/signer-types';
  import { humanError } from '../lib/format';
  import { DEPLOYMENTS, verifyDeployments } from '../lib/chains';
  import { encodeCreateSigner, passkeySignerAddress } from '../lib/passkeyFactory';
  import {
    sepoliaPublicClient,
    predictSafeAddress,
    safeDeploymentCall,
    readExistingSafe,
    ownersBatchCalls,
    proposeSafeTransaction,
    execTransactionCall,
    sendFromWallet,
    waitForReceipt,
  } from '../lib/safe';
  import { connectInjected } from '../lib/signers/hotWallet';
  import { readLedgerAddress, readTrezorAddress } from '../lib/signers/hardware';
  import { createPasskey } from '../lib/webauthn';

  const STEPS = ['Start', 'Signers', 'Threshold', 'Deploy', 'Verify'] as const;

  let step = $state(0);
  let bootError = $state('');
  let booting = $state(true);
  let globalError = $state('');

  const thresholdOk = $derived(
    session.current.signers.length > 0 &&
      session.current.threshold >= 1 &&
      session.current.threshold <= session.current.signers.length,
  );

  onMount(() => {
    loadFromStorage();
    if (!session.current.saltNonce) newSalt();
    // Resume exactly where the user was, as long as that step is still reachable —
    // a session's steps are unlocked by its owner set, so a stale step index must not
    // skip ahead of data that no longer exists.
    const saved = loadStep();
    if (saved >= 0 && saved <= reachableStep()) step = saved;
    else if (session.current.safeAddress) step = session.current.deployed ? 4 : 3;
    else if (session.current.signers.length > 0) step = 2;
    void (async () => {
      try {
        await verifyDeployments(sepoliaPublicClient);
      } catch (err) {
        bootError = humanError(err);
      } finally {
        booting = false;
      }
    })();
  });

  /** The furthest step the current session data actually supports. */
  function reachableStep(): number {
    const s = session.current;
    if (s.deployed && s.safeAddress) return 4;
    if (s.safeAddress) return 3;
    if (s.signers.length > 0) return 2;
    return 1;
  }

  function go(next: number): void {
    step = next;
    saveStep(next);
    globalError = '';
    // The deploy step shows the address before anything is sent, so it is derived on
    // entry rather than on a button press.
    if (next === 3 && session.current.mode === 'create' && !session.current.safeAddress) {
      void previewPredictedAddress();
    }
  }

  async function previewPredictedAddress(): Promise<void> {
    const current = session.current;
    if (current.signers.length === 0 || !current.saltNonce) return;
    try {
      const predicted = await predictSafeAddress({
        owners: current.signers.map((s) => s.address),
        threshold: current.threshold,
        saltNonce: current.saltNonce,
      });
      if (session.current.saltNonce === current.saltNonce) {
        setSession({ ...session.current, safeAddress: predicted });
      }
    } catch (err) {
      globalError = humanError(err);
    }
  }

  function chooseMode(mode: SessionMode): void {
    setSession({ ...newSession(mode), saltNonce: String(Date.now()) });
    // A brand-new session must not inherit the previous session's step.
    saveStep(1);
    go(1);
  }

  async function openExisting(safeAddress: `0x${string}`): Promise<void> {
    const read = await readExistingSafe(safeAddress);
    // Imported owners are address-only: this tab holds no key for them. Connecting
    // the matching wallet later upgrades the same record in place.
    setSession({
      ...newSession('existing'),
      safeAddress,
      deployed: true,
      threshold: read.threshold,
      signers: read.owners.map((address) => ({
        kind: 'injected' as const,
        address,
        label: 'Existing owner',
        canSign: false,
      })),
    });
    go(1);
  }

/** Owner or threshold changes make a stored predicted address stale: drop it. */
  function invalidatePrediction(next: Session): Session {
    return next.mode === 'create' ? { ...next, safeAddress: undefined, deployed: false } : next;
  }

  function add(record: SignerRecord): void {
    try {
      setSession(invalidatePrediction(addSigner(session.current, record)));
    } catch (err) {
      globalError = humanError(err);
    }
  }

  function rename(address: `0x${string}`, label: string): void {
    try {
      setSession(renameSigner(session.current, address, label));
    } catch (err) {
      globalError = humanError(err);
    }
  }

  function remove(address: `0x${string}`): void {
    setSession(invalidatePrediction(removeSigner(session.current, address)));
  }

  function changeThreshold(n: number): void {
    setSession(invalidatePrediction(setThreshold(session.current, n)));
  }

  function newSalt(): void {
    setSession({ ...session.current, saltNonce: String(Date.now()), safeAddress: undefined, deployed: false });
  }

  async function onCreatePasskey(label: string): Promise<SignerRecord> {
    const enrolled = await createPasskey(label);
    const address = await passkeySignerAddress(sepoliaPublicClient, enrolled.coordinates);
    return {
      kind: 'passkey',
      address,
      label,
      canSign: true,
      rawId: enrolled.rawId,
      coordinates: enrolled.coordinates,
      origin: enrolled.origin,
    };
  }

  async function onDeviceAddress(kind: 'ledger' | 'trezor', path: string): Promise<SignerRecord> {
    if (kind === 'ledger') {
      return { kind: 'ledger', address: await readLedgerAddress(path), label: 'Ledger', canSign: true, path };
    }
    return { kind: 'trezor', address: await readTrezorAddress(path), label: 'Trezor', canSign: true, path };
  }

  /** Calldata preview and the call the payer broadcasts. Same object, one source. */
  async function onDeployCall() {
    const current = session.current;
    const blueprint = {
      owners: current.signers.map((s) => s.address),
      threshold: current.threshold,
      saltNonce: current.saltNonce ?? '0',
    };
    const call = await safeDeploymentCall(blueprint);
    setSession({ ...current, safeAddress: call.predictedAddress });
    return call;
  }

  /** Authoritative refetch after the deploy receipt: owners and threshold come from chain. */
  async function onDeployed(): Promise<void> {
    const current = session.current;
    if (!current.safeAddress) throw new Error('No predicted address in this session.');
    const read = await readExistingSafe(current.safeAddress);
    setSession({
      ...current,
      deployed: true,
      threshold: read.threshold,
      signers: current.signers.map((s) => {
        const onchain = read.owners.find((o) => o.toLowerCase() === s.address.toLowerCase());
        return onchain ? { ...s, address: onchain } : s;
      }),
    });

    // Passkey proxies are deployed permissionlessly, idempotently, one per owner.
    const passkeys = current.signers.flatMap((s) => (s.kind === 'passkey' ? [s] : []));
    if (passkeys.length === 0) return;
    const payer = await connectInjected('Proxy deployer');
    for (const signer of passkeys) {
      if (signer.kind !== 'passkey') continue;
      const code = await sepoliaPublicClient.getCode({ address: signer.address });
      if (code && code !== '0x') continue;
      const hash = await sendFromWallet(payer.provider, payer.address, {
        to: DEPLOYMENTS.passkeySignerFactory,
        data: encodeCreateSigner(signer.coordinates),
      });
      await waitForReceipt(hash);
    }
  }

  /**
   * Existing-Safe path: propose the owner-install batch, then hand the user to
   * the Verify step for the threshold signatures it needs.
   */
  async function onInstallOwners(passkeys: SignerRecord[], nextThreshold: number): Promise<void> {
    const current = session.current;
    if (!current.safeAddress) throw new Error('No Safe in this session.');
    const coordinates = passkeys.flatMap((s) => (s.kind === 'passkey' ? [s.coordinates] : []));
    const calls = ownersBatchCalls(current.safeAddress, coordinates, nextThreshold);
    setSession({ ...current, pending: await proposeSafeTransaction(current.safeAddress, calls) });
    go(4);
  }

  /** Verify step: a one-call proposal to an owner (the default no-op test). */
  async function onPrepare(to: `0x${string}`): Promise<void> {
    const current = session.current;
    if (!current.safeAddress) throw new Error('Deploy the Safe first.');
    setSession({
      ...current,
      pending: await proposeSafeTransaction(current.safeAddress, [{ to, value: '0', data: '0x' }]),
    });
  }

  function onSignerSigned(owner: `0x${string}`, blob: `0x${string}`, isContract: boolean): void {
    const current = session.current;
    if (!current.pending) return;
    setSession({
      ...current,
      pending: {
        ...current.pending,
        signatures: { ...current.pending.signatures, [owner.toLowerCase()]: { blob, isContract } },
      },
    });
  }

  function onExecuteCall() {
    const current = session.current;
    if (!current.pending || !current.safeAddress) throw new Error('Build a proposal first.');
    return Promise.resolve(execTransactionCall(current.safeAddress, current.pending, current.threshold));
  }

  async function onExecuted(txHash: `0x${string}`): Promise<void> {
    const current = session.current;
    if (!current.safeAddress) return;
    const read = await readExistingSafe(current.safeAddress);
    setSession({
      ...current,
      executedTxHashes: [...current.executedTxHashes, txHash],
      pending: undefined,
      threshold: read.threshold,
    });
  }

  function importBlob(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    void file
      .text()
      .then((text) => {
        const parsed = JSON.parse(text) as unknown;
        const blob = typeof parsed === 'string' ? parsed : encodeSession(parsed as Session);
        setSession(normalizeSignerAvailability(decodeSession(blob)));
        go(session.current.deployed ? 4 : 1);
      })
      .catch((err: unknown) => {
        globalError = humanError(err);
      });
  }
</script>

<main>
  <header>
    <h1>Safe Signer Onboarding</h1>
    <p class="tagline">
      Assemble a Safe multisig from the signers you actually have. Sepolia only; no server, no
      custody.
    </p>
  </header>

  {#if booting}
    <StatusLine status="busy" message="Checking the pinned Safe deployments on Sepolia…" />
  {:else if bootError}
    <StatusLine status="error" message={bootError} />
  {:else}
    <nav class="steps" aria-label="Wizard steps">
      {#each STEPS as label, index (label)}
        <button class={{ current: index === step }} onclick={() => go(index)}>
          <span class="index">{index + 1}</span>
          {label}
        </button>
      {/each}
    </nav>

    {#if globalError}
      <StatusLine status="error" message={globalError} />
    {/if}

    {#if step === 0}
      <ModeStep onChoose={chooseMode} onExisting={openExisting} />
      <label class="import">
        Import a session file
        <input type="file" accept="application/json" onchange={importBlob} />
      </label>
    {:else if step === 1}
      <SignerStep
        signers={session.current.signers}
        onAdd={add}
        onRemove={remove}
        onCreatePasskey={onCreatePasskey}
        onDeviceAddress={onDeviceAddress}
        onRename={rename}
      />
      <div class="nav">
        <button onclick={() => go(0)}>Back</button>
        <button class="primary" disabled={!thresholdOk} onclick={() => go(2)}>Continue</button>
      </div>
    {:else if step === 2}
      <ThresholdStep
        count={session.current.signers.length}
        threshold={session.current.threshold}
        onThreshold={changeThreshold}
      />
      <div class="nav">
        <button onclick={() => go(1)}>Back</button>
        <button class="primary" disabled={!thresholdOk} onclick={() => go(3)}>Continue</button>
      </div>
    {:else if step === 3}
      <DeployStep
        signers={session.current.signers}
        threshold={session.current.threshold}
        predicted={session.current.safeAddress ?? ''}
        mode={session.current.mode}
        saltNonce={session.current.saltNonce ?? ''}
        onNewSalt={newSalt}
        onDeployed={onDeployed}
        deployCall={onDeployCall}
        existingThreshold={session.current.threshold}
        onInstallOwners={onInstallOwners}
      />
      <div class="nav">
        <button onclick={() => go(2)}>Back</button>
        <button class="primary" disabled={!session.current.deployed} onclick={() => go(4)}>
          Continue
        </button>
      </div>
    {:else if step === 4}
      <VerifyStep
        session={session.current}
        onPrepare={onPrepare}
        onSignerSigned={onSignerSigned}
        executeCall={onExecuteCall}
        onExecuted={onExecuted}
      />
      <div class="nav">
        <button onclick={() => go(3)}>Back</button>
      </div>
    {/if}
  {/if}

  <footer>
    <p>
      The wizard holds no funds and deploys no contracts. A deployed Safe is fully controllable from
      the standard Safe UI.
    </p>
  </footer>
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    color: #1a1a1a;
    background: #fbfbfa;
  }
  :global(button) {
    font: inherit;
    padding: 0.4rem 0.8rem;
    border: 1px solid #c9c9c9;
    border-radius: 6px;
    background: #fff;
    cursor: pointer;
  }
  :global(button:disabled) {
    opacity: 0.55;
    cursor: not-allowed;
  }
  :global(button.primary) {
    background: #12ff80;
    border-color: #0bbf60;
    font-weight: 600;
    color: #0b2b17;
  }
  :global(input[type='text']) {
    padding: 0.35rem 0.5rem;
    border: 1px solid #c9c9c9;
    border-radius: 6px;
    font: inherit;
  }
  main {
    max-width: 56rem;
    margin: 0 auto;
    padding: 2rem 1.25rem 3rem;
    display: grid;
    gap: 1.5rem;
  }
  header {
    display: grid;
    gap: 0.35rem;
  }
  h1 {
    margin: 0;
    font-size: 1.5rem;
  }
  .tagline {
    margin: 0;
    color: #555;
    max-width: 60ch;
  }
  .steps {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .steps button {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    font-size: 0.875rem;
  }
  .steps button.current {
    border-color: #12ff80;
    box-shadow: 0 0 0 2px #b9ffdb;
  }
  .index {
    display: inline-grid;
    place-items: center;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 999px;
    background: #eee;
    font-size: 0.75rem;
  }
  .nav {
    display: flex;
    gap: 0.5rem;
  }
  .import {
    display: grid;
    gap: 0.35rem;
    font-size: 0.875rem;
    justify-items: start;
  }
  footer {
    border-top: 1px solid #e4e4e4;
    padding-top: 1rem;
    font-size: 0.8125rem;
    color: #666;
  }
  footer p {
    margin: 0;
  }
</style>
