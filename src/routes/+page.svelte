<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import SignerStep from '../lib/components/SignerStep.svelte';
  import ThresholdStep from '../lib/components/ThresholdStep.svelte';
  import DeployStep from '../lib/components/DeployStep.svelte';
  import VerifyStep from '../lib/components/VerifyStep.svelte';
  import StatusLine from '../lib/components/StatusLine.svelte';
  import ScreenShell from '../lib/components/screens/ScreenShell.svelte';
  import WelcomeScreen from '../lib/components/screens/WelcomeScreen.svelte';
  import OpenPanel from '../lib/components/screens/OpenPanel.svelte';
  import KeyPickerScreen from '../lib/components/screens/KeyPickerScreen.svelte';
  import InviteScreen from '../lib/components/screens/InviteScreen.svelte';
  import ApprovalRuleScreen from '../lib/components/screens/ApprovalRuleScreen.svelte';
  import VaultReadyScreen from '../lib/components/screens/VaultReadyScreen.svelte';
  import VaultHomeScreen from '../lib/components/screens/VaultHomeScreen.svelte';
  import DeployOverlay from '../lib/components/screens/DeployOverlay.svelte';
  import { session, setSession, loadFromStorage, loadStep, saveStep } from '../lib/session.svelte';
  import {
    newSession,
    addSigner,
    addPlannedMember,
    removePlannedMember,
    removeSigner,
    renameSigner,
    setThreshold,
    setVaultName,
    memberJoinState,
    encodeSession,
    decodeSession,
    normalizeSignerAvailability,
  } from '../lib/session';
  import type { Session, SessionMode } from '../lib/session';
  import type { SignerRecord } from '../lib/signer-types';
  import { humanError, checksum } from '../lib/format';
  import { DEPLOYMENTS, verifyDeployments } from '../lib/chains';
  import { encodeCreateSigner, passkeySignerAddress } from '../lib/passkeyFactory';
  import {
    sepoliaPublicClient,
    predictSafeAddress,
    safeDeploymentCall,
    deployWithPayer,
    readExistingSafe,
    ownersBatchCalls,
    proposeSafeTransaction,
    execTransactionCall,
    sendFromWallet,
    publishShareBlob,
    waitForReceipt,
  } from '../lib/safe';
  import { readCostContext } from '../lib/costs';
  import type { CostContext } from '../lib/costs';
  import { connectInjected } from '../lib/signers/hotWallet';
  import { readLedgerAddress, readTrezorAddress, scanLedgerPaths, scanTrezorPaths } from '../lib/signers/hardware';
  import { discoveryPaths } from '../lib/signers/discovery';
  import { createPasskey } from '../lib/webauthn';
  import { decryptSessionBlob, fetchShareBlob, packSession, parseShareLink, shareLink } from '../lib/sessionShare';
  import { forgetAllShares, forgetShare, listShares, saveShare } from '../lib/shareLinks';
  import type { StoredShare } from '../lib/shareLinks';

  /**
   * Two flows share one step counter. Create is the mobile-first family flow:
   * welcome → key → invite → rule → ready → vault, then 6 for the send path.
   * Existing keeps the original wizard for opening and updating a deployed Safe.
   */
  const CREATE_VERIFY_STEP = 6;
  const EXISTING_STEPS = ['Start', 'Signers', 'Threshold', 'Deploy', 'Verify'] as const;

  let step = $state(0);
  let bootError = $state('');
  let booting = $state(true);
  let bootStatus = $state('Checking the pinned Safe deployments on Sepolia…');
  let globalError = $state('');
  let shares = $state<StoredShare[]>([]);

  /** Create-flow deploy: the overlay between the rule screen and the ready screen. */
  let deployPhase = $state<'idle' | 'predicting' | 'awaitingWallet' | 'deploying' | 'error'>('idle');
  let deployMessage = $state('');
  let deployCost = $state<CostContext | null>(null);
  let deployCostBusy = $state(false);
  let deployHash = $state<`0x${string}` | undefined>(undefined);

  let balanceWei = $state<bigint | null>(null);
  /** The published invite link, cached because publishing costs a blob transaction. */
  let inviteUrl = $state('');

  const isCreate = $derived(session.current.mode === 'create');
  const roster = $derived(memberJoinState(session.current));

  const thresholdOk = $derived(
    session.current.signers.length > 0 &&
      session.current.threshold >= 1 &&
      session.current.threshold <= session.current.signers.length,
  );

  onMount(() => {
    // A share link is read before anything local is loaded: the link is the user's
    // explicit instruction, and a stale stored session must not win over it.
    const share = parseShareLink(location.href);
    void (async () => {
      let imported = false;
      if (share) {
        // Reading a blob can poll for a minute while the indexer catches up; the
        // boot line has to say that, or the wait looks like a hang in the Safe check.
        bootStatus = 'Reading the shared session from its Sepolia blob…';
        try {
          const bytes = await fetchShareBlob(share.versionedHash);
          setSession(normalizeSignerAvailability(await decryptSessionBlob(bytes, share.keyB64)));
          // Strip the fragment so a reload resumes the stored session instead of
          // re-fetching a blob that is already in localStorage. A shallow goto is
          // the router-aware equivalent of `history.replaceState`.
          await goto(`${location.pathname}${location.search}`, { replace: true, shallow: true });
          imported = true;
        } catch (err) {
          // `humanError` now names each blob failure precisely; only the generic
          // "still polling" timeout needs the hint about reopening the link.
          globalError =
            err instanceof Error && err.name === 'BlobNotIndexed'
              ? 'No blob found for that link yet. If it was published moments ago, reopen it in a minute; otherwise check the link.'
              : humanError(err);
        }
        bootStatus = 'Checking the pinned Safe deployments on Sepolia…';
      }
      // A failed import leaves whatever was stored alone; a successful one replaced it.
      if (!imported) loadFromStorage();
      shares = listShares();
      // A salt only matters for deriving a fresh Safe; a session that already has an
      // address keeps it (newSalt would clear the address and the deployed flag).
      if (!session.current.saltNonce && !session.current.safeAddress) newSalt();
      const furthest = reachableStep();
      const saved = loadStep();
      // The send path (index 6) sits past the create flow's furthest step 5; it is
      // reachable only from a deployed vault, and it resumes there on reload.
      const resumable = saved === CREATE_VERIFY_STEP && isCreate && session.current.deployed ? saved : -1;
      if (imported) {
        go(furthest);
      } else if (resumable >= 0) {
        go(resumable);
      } else if (saved >= 0 && saved <= furthest) {
        // Resume exactly where the user was, as long as that step is still reachable —
        // a session's steps are unlocked by its data, so a stale index must not skip
        // ahead of data that no longer exists.
        go(saved);
      } else if (session.current.deployed && session.current.safeAddress) {
        go(isCreate ? 5 : 4);
      } else if (session.current.safeAddress) {
        go(3);
      } else if (session.current.signers.length > 0) {
        go(2);
      }
      try {
        await verifyDeployments(sepoliaPublicClient);
      } catch (err) {
        bootError = humanError(err);
      } finally {
        booting = false;
      }
      if (step === 5) void refreshBalance();
    })();
  });

  /** The furthest step the current session data actually supports, per flow. */
  function reachableStep(): number {
    const s = session.current;
    if (s.mode === 'create') {
      if (s.deployed && s.safeAddress) return 5;
      if (s.signers.length > 0) return 3;
      return 1;
    }
    if (s.deployed && s.safeAddress) return 4;
    if (s.safeAddress) return 3;
    if (s.signers.length > 0) return 2;
    return 1;
  }

  function go(next: number): void {
    step = next;
    saveStep(next);
    globalError = '';
    // The rule step shows the address before anything is sent, so it is derived on
    // entry rather than on a button press.
    if (next === 3 && isCreate && !session.current.safeAddress) {
      void previewPredictedAddress();
    }
    if (next === 5) void refreshBalance();
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

  async function refreshBalance(): Promise<void> {
    const address = session.current.safeAddress;
    if (!address) {
      balanceWei = null;
      return;
    }
    try {
      balanceWei = await sepoliaPublicClient.getBalance({ address });
    } catch {
      // The dashboard says "balance unavailable" rather than inventing a number.
      balanceWei = null;
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

  /**
   * The welcome footer takes either an invite link (→ back into the boot import) or a
   * Safe address (→ the existing-Safe flow), so one field serves both.
   */
  async function openFromWelcome(value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed) throw new Error('Paste an invite link or a Safe address.');
    if (/^https?:|#\/share\//.test(trimmed)) {
      // Read the blob here rather than navigating to the fragment: `goto` on a
      // hash-only URL does not remount the page, so the boot import would never run
      // and the link would silently do nothing.
      const share = parseShareLink(trimmed);
      if (!share) {
        throw new Error('That link carries no readable session. Paste the whole link, including the part after the second slash.');
      }
      const bytes = await fetchShareBlob(share.versionedHash);
      setSession(normalizeSignerAvailability(await decryptSessionBlob(bytes, share.keyB64)));
      inviteUrl = '';
      go(reachableStep());
      return;
    }
    await openExisting(checksum(trimmed));
  }

  /** Owner or threshold changes make a stored predicted address stale: drop it. */
  function invalidatePrediction(next: Session): Session {
    return next.mode === 'create' ? { ...next, safeAddress: undefined, deployed: false } : next;
  }

  function add(record: SignerRecord): void {
    try {
      inviteUrl = '';
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

  function invite(name: string): void {
    try {
      // The invite link encodes the roster, so a roster change makes it stale.
      inviteUrl = '';
      setSession(addPlannedMember(session.current, name));
    } catch (err) {
      globalError = humanError(err);
    }
  }

  function uninvite(name: string): void {
    inviteUrl = '';
    setSession(removePlannedMember(session.current, name));
  }

  function setVaultTitle(name: string): void {
    try {
      setSession(setVaultName(session.current, name));
    } catch (err) {
      globalError = humanError(err);
    }
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

  /**
   * One device session per scan: both transports hold the device open, so opening
   * it per account would prompt the user once per row.
   */
  async function onDeviceScan(kind: 'ledger' | 'trezor'): Promise<{ path: string; address: `0x${string}` }[]> {
    const paths = discoveryPaths();
    return kind === 'ledger' ? scanLedgerPaths(paths) : scanTrezorPaths(paths);
  }

  async function onConnectInjected(): Promise<SignerRecord> {
    const conn = await connectInjected();
    return { kind: 'injected', address: conn.address, label: conn.label, canSign: true };
  }

  /** The key screen is linear: a key that was just added carries the user to the invite. */
  function addKey(record: SignerRecord): void {
    add(record);
    if (!globalError) go(2);
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

  /** Rule screen → overlay → deployed vault. Every failure lands back in the overlay. */
  async function createVault(): Promise<void> {
    if (deployPhase !== 'idle' && deployPhase !== 'error') return;
    deployPhase = 'predicting';
    deployMessage = 'Deriving the vault address…';
    deployCost = null;
    deployHash = undefined;
    try {
      const call = await onDeployCall();
      deployCostBusy = true;
      // AGENTS.md: never quote gas from memory — estimate the exact call at click time.
      deployCost = await readCostContext({ to: call.to, data: call.data, value: call.value });
      deployCostBusy = false;
      deployPhase = 'awaitingWallet';
      deployMessage = 'Confirm the deployment in your wallet…';
      await deployWithPayer(call, (hash) => {
        deployHash = hash;
        deployPhase = 'deploying';
        deployMessage = 'Waiting for the deployment receipt…';
      });
      deployMessage = 'Checking the deployed vault on Sepolia…';
      await onDeployed();
      deployPhase = 'idle';
      go(4);
    } catch (err) {
      deployCostBusy = false;
      deployPhase = 'error';
      deployMessage = humanError(err);
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
    if (current.mode === 'create') void refreshBalance();
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
        go(session.current.deployed ? (session.current.mode === 'create' ? 5 : 4) : 1);
      })
      .catch((err: unknown) => {
        globalError = humanError(err);
      });
  }

  /**
   * Publishes the session to a blob and returns the link that opens it. The key is
   * generated here and only ever appears in the returned fragment.
   */
  async function shareSession(): Promise<string> {
    if (inviteUrl) return inviteUrl;
    const current = session.current;
    const { keyB64, blobHex } = await packSession(current);
    const { versionedHash } = await publishShareBlob(blobHex);
    const url = shareLink(location.origin, location.pathname, { keyB64, versionedHash });
    // Remembered so the publisher can get the link back after closing the tab. A
    // reader's browser that republishes lands here too: its link is new and its own.
    shares = saveShare({
      url,
      versionedHash,
      createdAt: new Date().toISOString(),
      signerCount: current.signers.length,
      threshold: current.threshold,
    });
    inviteUrl = url;
    return url;
  }

  function dropShare(versionedHash: `0x${string}`): void {
    shares = forgetShare(versionedHash);
  }

  function dropAllShares(): void {
    forgetAllShares();
    shares = [];
  }
</script>

{#if booting}
  <main class="boot">
    <StatusLine status="busy" message={bootStatus} />
    {#if globalError}
      <StatusLine status="error" message={globalError} />
    {/if}
  </main>
{:else if bootError}
  <main class="boot">
    <StatusLine status="error" message={bootError} />
  </main>
{:else if step === 0}
  <!-- Step 0 is the same welcome screen in both flows: it is where a new vault is
       started and where an existing one is opened, so neither flow can begin elsewhere. -->
  <ScreenShell>
    <WelcomeScreen onCreate={() => chooseMode('create')}>
      {#snippet footer()}
        <OpenPanel onOpen={openFromWelcome} onImportBlob={importBlob} />
      {/snippet}
    </WelcomeScreen>
  </ScreenShell>
{:else if isCreate}
  {#if globalError}
    <div class="flow-error">
      <StatusLine status="error" message={globalError} />
    </div>
  {/if}

  {#if step === 1}
    <ScreenShell step={1} total={3} onBack={() => go(0)}>
      <KeyPickerScreen
        onAdded={addKey}
        onCreatePasskey={onCreatePasskey}
        onDeviceAddress={onDeviceAddress}
        onConnectInjected={onConnectInjected}
        hasSigner={session.current.signers.length > 0}
        onContinue={() => go(2)}
      />
    </ScreenShell>
  {:else if step === 2}
    <ScreenShell step={2} total={3} onBack={() => go(1)}>
      <InviteScreen
        session={session.current}
        {inviteUrl}
        vaultName={session.current.vaultName ?? ''}
        onVaultName={setVaultTitle}
        onPublish={shareSession}
        onAddPlanned={invite}
        onRemovePlanned={uninvite}
        onNext={() => go(3)}
      />
    </ScreenShell>
  {:else if step === 3}
    <ScreenShell step={3} total={3} onBack={() => go(2)}>
      <ApprovalRuleScreen
        roster={roster}
        ownerCount={session.current.signers.length}
        threshold={session.current.threshold}
        onThreshold={changeThreshold}
        onCreateVault={createVault}
        busy={deployPhase !== 'idle' && deployPhase !== 'error'}
        error={deployPhase === 'error' ? deployMessage : ''}
      />
    </ScreenShell>
  {:else if step === 4}
    <ScreenShell>
      <VaultReadyScreen
        vaultName={session.current.vaultName}
        roster={roster}
        threshold={session.current.threshold}
        signerCount={session.current.signers.length}
        onOpenVault={() => go(5)}
        onTestPayment={() => go(CREATE_VERIFY_STEP)}
      />
    </ScreenShell>
  {:else if step === 5}
    <ScreenShell>
      <VaultHomeScreen
        session={session.current}
        balanceWei={balanceWei}
        {inviteUrl}
        onSend={() => go(CREATE_VERIFY_STEP)}
        onInvite={shareSession}
        onRefresh={() => void refreshBalance()}
      />
    </ScreenShell>
  {:else}
    <main class="existing">
      <VerifyStep
        session={session.current}
        onPrepare={onPrepare}
        onSignerSigned={onSignerSigned}
        executeCall={onExecuteCall}
        onExecuted={onExecuted}
      />
      <div class="nav">
        <button onclick={() => go(5)}>Back to the vault</button>
      </div>
    </main>
  {/if}

  {#if deployPhase !== 'idle'}
    <DeployOverlay
      status={deployPhase}
      message={deployMessage}
      predicted={session.current.safeAddress}
      cost={deployCost}
      costBusy={deployCostBusy}
      txHash={deployHash}
      onRetry={createVault}
      onClose={() => (deployPhase = 'idle')}
    />
  {/if}
{:else}
  <main>
    <header>
      <h1>Existing Safe</h1>
      <p class="tagline">
        Every owner below is read from Sepolia. This tab holds keys for none of them until you
        connect the wallet that owns one.
      </p>
    </header>

    <nav class="steps" aria-label="Wizard steps">
      {#each EXISTING_STEPS as label, index (label)}
        <button class={{ current: index === step }} onclick={() => go(index)}>
          <span class="index">{index + 1}</span>
          {label}
        </button>
      {/each}
    </nav>

    {#if globalError}
      <StatusLine status="error" message={globalError} />
    {/if}

    {#if step === 1}
      <SignerStep
        signers={session.current.signers}
        onAdd={add}
        onRemove={remove}
        onCreatePasskey={onCreatePasskey}
        onDeviceAddress={onDeviceAddress}
        onDeviceScan={onDeviceScan}
        onRename={rename}
        onShare={shareSession}
        {shares}
        onForgetShare={dropShare}
        onForgetAllShares={dropAllShares}
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

    <footer>
      <p>
        The wizard holds no funds and deploys no contracts. A deployed Safe is fully controllable
        from the standard Safe UI.
      </p>
    </footer>
  </main>
{/if}

<style>
  :global(body) {
    margin: 0;
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    color: #1a1a1a;
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
  main.boot {
    max-width: 32rem;
  }
  /* The create flow is an app, not a wizard page: the screen owns the whole viewport. */
  main.existing {
    max-width: 48rem;
  }
  .flow-error {
    max-width: 420px;
    margin: 0.75rem auto 0;
    padding-inline: 1.1rem;
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
