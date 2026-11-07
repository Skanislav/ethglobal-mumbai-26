<script lang="ts">
  // The invite link is a self-contained URL fragment — no wallet, no publish fee.
  import { humanError } from '../../format';
  import { MAX_SHARE_URL_LENGTH, ownersPerLink } from '../../invite';
  import { memberGroups } from '../../session';
  import type { Session } from '../../session';
  import MemberGroups from '../MemberGroups.svelte';

  let {
    session,
    inviteUrl = '',
    shareError = '',
    vaultName = '',
    onVaultName,
    onPublish,
    onAddPlanned,
    onRemovePlanned,
    onNext,
  }: {
    session: Session;
    /** Link for this exact session; the parent keeps it current via a debounced effect. */
    inviteUrl?: string;
    /** Set when regenerating the link failed (e.g. payload too large). */
    shareError?: string;
    vaultName?: string;
    onVaultName: (name: string) => void;
    /** Rebuilds the link by hand; the parent normally keeps it current automatically. */
    onPublish?: () => Promise<string>;
    onAddPlanned: (name: string) => void;
    onRemovePlanned: (name: string) => void;
    onNext: () => void;
  } = $props();

  let sharing = $state(false);
  let failure = $state('');
  let copied = $state(false);
  let copiedUrl = $state('');
  let newName = $state('');

  const groups = $derived(memberGroups(session));
  const joined = $derived(groups.filter((m) => m.joined).length);
  const canAdvance = $derived(session.signers.some((s) => s.canSign));
  // Depends on this deployment's origin+path, so it is derived at runtime.
  const capacity = $derived(
    typeof location === 'undefined' ? 0 : ownersPerLink(location.origin, location.pathname),
  );


  async function share(): Promise<void> {
    if (!onPublish) return;
    sharing = true;
    failure = '';
    copied = false;
    try {
      await onPublish();
    } catch (err) {
      failure = humanError(err);
    } finally {
      sharing = false;
    }
  }

  async function copy(): Promise<void> {
    if (!inviteUrl) return;
    // Second press, this exact link already copied: the job is to send it back,
    // so the button advances instead of copying again.
    if (copied && copiedUrl === inviteUrl) {
      onNext();
      return;
    }
    try {
      await navigator.clipboard.writeText(inviteUrl);
      copied = true;
      copiedUrl = inviteUrl;
      failure = '';
    } catch {
      failure = 'Copy blocked — select the link and copy it by hand.';
    }
  }

  function add(): void {
    const name = newName.trim();
    if (!name) return;
    onAddPlanned(name);
    newName = '';
  }
</script>

<h1>Invite your family</h1>
<p class="lede">Send this link to people you trust. Each of them adds their own key.</p>

<label class="vault-name">
  <span>Vault name</span>
  <input
    type="text"
    maxlength="40"
    placeholder="The Novaks"
    value={vaultName}
    onchange={(event) => onVaultName(event.currentTarget.value)}
    aria-label="Vault name"
  />
</label>

<div class="invite">
  <span class="label">Invite link</span>
  {#if session.viaInvite}
    <p class="handback">
      You joined through a link, so nothing here syncs by itself. The key you just added — and any change
      you make — exists only in the link below. <strong>Copy it and send it back to whoever invited
      you</strong>{groups.length - joined > 0 ? ' (or on to the next member)' : ''}; their copy and the
      vault's owner list update only from the newest link.
    </p>
  {/if}
  {#if inviteUrl}
    <div class="row">
      <input class="link" type="text" readonly value={inviteUrl} onfocus={(e) => e.currentTarget.select()} />
      <button class="sf-btn sf-btn--quiet" onclick={copy}>{copied && copiedUrl === inviteUrl ? 'Copied' : 'Copy'}</button>
    </div>
  {:else if sharing}
    <p class="pending">Building your invite link…</p>
  {:else if !failure && !shareError}
    <p class="pending">Building your invite link…</p>
  {/if}
  {#if inviteUrl}
    <p class="budget">
      {inviteUrl.length} of {MAX_SHARE_URL_LENGTH} characters. The link carries the whole
      vault, so it opens offline; it holds about {capacity} joined owners, and each extra
      one costs roughly 33 characters.
    </p>
  {/if}
  {#if failure}
    <p class="error">{failure}</p>
  {/if}
  {#if shareError}
    <p class="error">{shareError}</p>
  {/if}
</div>

<div class="roster">
  <div class="head">
    <h2>Family members</h2>
    <span class="sf-muted">{joined} of {groups.length} joined</span>
  </div>
  <MemberGroups {groups} threshold={session.threshold} {onRemovePlanned} />

  <form
    class="add"
    onsubmit={(event) => {
      event.preventDefault();
      add();
    }}
  >
    <input type="text" placeholder="Add a family member" maxlength="64" bind:value={newName} aria-label="Member name" />
    <button class="sf-btn sf-btn--quiet" type="submit" disabled={!newName.trim()}>Add</button>
  </form>
</div>

<div class="cta">
  <button class="sf-btn" onclick={inviteUrl ? copy : share} disabled={sharing || !onPublish}>
    {sharing
      ? 'Building…'
      : inviteUrl
        ? session.viaInvite
          ? copied
            ? 'Copied — now send it back'
            : 'Copy link to send back'
          : 'Share invite link'
        : 'Create invite link'}
  </button>
  <button class="sf-btn sf-btn--ghost" onclick={onNext} disabled={!canAdvance}>Next: approval rule</button>
  {#if !canAdvance}
    <p class="hint">Add your own key first; the vault needs at least one signer here.</p>
  {/if}
</div>

<style>
  .handback {
    margin: 0;
    padding: 0.55rem 0.7rem;
    font-size: 0.8125rem;
    color: var(--sf-ink-soft);
    border: 1px dashed var(--sf-line);
    border-radius: var(--sf-radius-md);
  }

  h1 {
    margin: 0;
    font-size: 1.5rem;
    letter-spacing: -0.02em;
  }

  .lede {
    margin: 0;
    color: var(--sf-muted);
    font-size: 0.9375rem;
  }

  .vault-name {
    display: grid;
    gap: 0.3rem;
    font-size: 0.8125rem;
    color: var(--sf-ink-soft);
  }

  .vault-name input {
    padding: 0.55rem 0.7rem;
    border: 1px solid var(--sf-line);
    border-radius: var(--sf-radius-md);
    font: inherit;
    font-size: 0.9375rem;
    color: var(--sf-ink);
    background: var(--sf-surface);
  }

  .invite {
    display: grid;
    gap: 0.4rem;
    padding: 0.85rem;
    border-radius: var(--sf-radius-md);
    background: var(--sf-primary-soft);
  }

  .label {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--sf-ink-soft);
  }

  .row {
    display: flex;
    gap: 0.4rem;
  }

  .link {
    flex: 1;
    min-width: 0;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--sf-line);
    border-radius: 10px;
    background: var(--sf-surface);
    font: inherit;
    font-size: 0.8125rem;
    color: var(--sf-ink-soft);
  }

  .pending {
    margin: 0;
    padding: 0.5rem 0.6rem;
    border-radius: 10px;
    background: var(--sf-surface);
    font-size: 0.8125rem;
    color: var(--sf-muted);
  }

  .hint {
    margin: 0;
    font-size: 0.75rem;
    color: var(--sf-muted);
  }

  .budget {
    margin: 0;
    font-size: 0.75rem;
    line-height: 1.4;
    color: var(--sf-muted);
  }

  .error {
    margin: 0;
    color: var(--sf-warn-ink);
    font-size: 0.8125rem;
  }

  .roster {
    display: grid;
    gap: 0.5rem;
  }

  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }

  h2 {
    margin: 0;
    font-size: 0.95rem;
  }

  .add {
    display: flex;
    gap: 0.4rem;
  }

  .add input {
    flex: 1;
    min-width: 0;
    padding: 0.55rem 0.7rem;
    border: 1px dashed #c9d2e6;
    border-radius: var(--sf-radius-md);
    background: transparent;
    font: inherit;
    font-size: 0.875rem;
  }

  .cta {
    display: grid;
    gap: 0.5rem;
    margin-top: auto;
  }
</style>
