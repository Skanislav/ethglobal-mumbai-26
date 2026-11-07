<script lang="ts">
  import { onMount } from 'svelte';
  import { avatarClass, initial, humanError, memberSubtitle } from '../../format';
  import { MAX_SHARE_URL_LENGTH, ownersPerLink } from '../../invite';
  import { memberJoinState } from '../../session';
  import type { Session } from '../../session';

  let {
    session,
    inviteUrl = '',
    vaultName = '',
    onVaultName,
    onPublish,
    onAddPlanned,
    onRemovePlanned,
    onNext,
  }: {
    session: Session;
    /** The link built for this exact session; the parent caches it. */
    inviteUrl?: string;
    vaultName?: string;
    onVaultName: (name: string) => void;
    /** Encodes the session into a link; needs no wallet. */
    onPublish?: () => Promise<string>;
    onAddPlanned: (name: string) => void;
    onRemovePlanned: (name: string) => void;
    onNext: () => void;
  } = $props();

  let sharing = $state(false);
  let failure = $state('');
  let copied = $state(false);
  let newName = $state('');

  const roster = $derived(memberJoinState(session));
  const joined = $derived(roster.filter((m) => m.joined).length);
  const canAdvance = $derived(session.signers.some((s) => s.canSign));
  // Depends on this deployment's origin+path, so it is derived at runtime.
  const capacity = $derived(
    typeof location === 'undefined' ? 0 : ownersPerLink(location.origin, location.pathname),
  );

  onMount(() => {
    // The link carries the session itself, so there is nothing to publish and no
    // wallet to wait for: build it as soon as the screen appears.
    void share();
  });

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
    try {
      await navigator.clipboard.writeText(inviteUrl);
      copied = true;
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
  {#if inviteUrl}
    <div class="row">
      <input class="link" type="text" readonly value={inviteUrl} onfocus={(e) => e.currentTarget.select()} />
      <button class="sf-btn sf-btn--quiet" onclick={copy}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  {:else}
    {#if sharing}
      <p class="pending">Building the invite link…</p>
    {:else if !failure}
      <p class="pending">Invite link not built yet.</p>
    {/if}
  {/if}
  {#if inviteUrl}
    <p class="budget">
      {inviteUrl.length} of {MAX_SHARE_URL_LENGTH} characters. The link carries the whole vault,
      so it opens offline; it holds about {capacity} joined owners, and each extra one costs
      roughly 33 characters.
    </p>
  {/if}
  {#if failure}
    <p class="error">{failure}</p>
  {/if}
</div>

<div class="roster">
  <div class="head">
    <h2>Family members</h2>
    <span class="sf-muted">{joined} of {roster.length} joined</span>
  </div>
  <ul>
    {#each roster as member, index (member.name + index)}
      <li>
        <span class="sf-avatar {avatarClass(index)}">{initial(member.name)}</span>
        <span class="who">
          <span class="name">{member.name}</span>
          <span class="sub">{memberSubtitle(member)}</span>
        </span>
        {#if member.joined}
          <span class="sf-chip sf-chip--ok">Joined</span>
        {:else}
          <span class="sf-chip sf-chip--warn">Invited</span>
          {#if member.planned}
            <button class="remove" onclick={() => onRemovePlanned(member.name)} aria-label="Remove {member.name}">
              ×
            </button>
          {/if}
        {/if}
      </li>
    {/each}
  </ul>

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
    {sharing ? 'Building…' : inviteUrl ? 'Share invite link' : 'Build invite link'}
  </button>
  <button class="sf-btn sf-btn--ghost" onclick={onNext} disabled={!canAdvance}>Next: approval rule</button>
  {#if !canAdvance}
    <p class="hint">Add your own key first; the vault needs at least one signer here.</p>
  {/if}
</div>

<style>
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

  .roster ul {
    display: grid;
    gap: 0.4rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .roster li {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    padding: 0.6rem 0.7rem;
    border: 1px solid var(--sf-line);
    border-radius: var(--sf-radius-md);
    background: var(--sf-surface);
  }

  .who {
    display: grid;
    flex: 1;
    min-width: 0;
  }

  .name {
    font-weight: 600;
    font-size: 0.9375rem;
  }

  .sub {
    color: var(--sf-muted);
    font-size: 0.75rem;
  }

  .remove {
    padding: 0 0.2rem;
    border: none;
    background: none;
    color: var(--sf-muted);
    font-size: 1rem;
    cursor: pointer;
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
