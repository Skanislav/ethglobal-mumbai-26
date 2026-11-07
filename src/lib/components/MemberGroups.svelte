<script lang="ts">
  // Grouped family roster: one block per member, their keys nested underneath.
  // `faces` is the compact avatar row used on the rule/ready/home screens; `list`
  // is the full block per member used on the invite and vault-home screens. A
  // member past the threshold cutoff is dimmed (faces) or flagged (list): their
  // keys exist, but cannot approve under the current rule.
  import { avatarClass, initial, signerKindLabel, shortAddress } from '../format';
  import type { MemberGroup } from '../session';

  let {
    groups,
    threshold,
    variant = 'list',
    limit,
    onRemovePlanned,
  }: {
    groups: MemberGroup[];
    /** When set, members at index ≥ threshold render as beyond the cutoff. */
    threshold?: number;
    variant?: 'list' | 'faces';
    /** Faces only: show at most this many avatars, then a `+N` overflow chip. */
    limit?: number;
    onRemovePlanned?: (name: string) => void;
  } = $props();

  const joinedCount = $derived(groups.filter((g) => g.joined).length);
  const visible = $derived(limit === undefined ? groups : groups.slice(0, limit));
  const overflow = $derived(limit === undefined ? 0 : Math.max(groups.length - limit, 0));

  function dimmed(index: number, group: MemberGroup): boolean {
    return !group.joined || (threshold !== undefined && index >= threshold);
  }

  function faceTitle(group: MemberGroup): string {
    if (!group.joined) return `${group.name} — invited, cannot approve yet`;
    const kinds = group.devices.map((d) => signerKindLabel(d.kind)).join(', ');
    return group.devices.length === 1
      ? `${group.name} — ${kinds}`
      : `${group.name} — ${group.devices.length} keys (${kinds})`;
  }
</script>

{#if variant === 'faces'}
  <div class="faces">
    {#each visible as group, index (group.name + index)}
      <span
        class={[`sf-avatar ${avatarClass(index)}`, { dim: dimmed(index, group) }]}
        title={faceTitle(group)}
      >
        {initial(group.name)}
      </span>
    {/each}
    {#if overflow > 0}
      <span class="sf-avatar more">+{overflow}</span>
    {/if}
  </div>
{:else}
  <ul class="members">
    {#each groups as group, index (group.name + index)}
      {@const beyond = threshold !== undefined && index >= threshold}
      <li>
        <div class="head-row">
          <span class="sf-avatar {avatarClass(index)}">{initial(group.name)}</span>
          <span class="who">
            <span class="name">{group.name}</span>
            {#if group.joined}
              <span class="sub">
                {group.devices.length} {group.devices.length === 1 ? 'key' : 'keys'}
              </span>
            {/if}
          </span>
          {#if group.joined}
            <span class="sf-chip sf-chip--ok">Joined</span>
          {:else}
            <span class="sf-chip sf-chip--warn">Invited</span>
            {#if group.planned && onRemovePlanned}
              <button
                class="remove"
                onclick={() => onRemovePlanned(group.name)}
                aria-label="Remove {group.name}">×</button
              >
            {/if}
          {/if}
          {#if beyond}
            <span
              class="sf-chip sf-chip--warn"
              title="The rule needs {threshold} of {joinedCount} joined members, so this member's keys cannot approve."
              >Beyond the {threshold}-of-{joinedCount} cutoff</span
            >
          {/if}
        </div>
        {#if !group.joined}
          <p class="nokey">No key yet — share the link with {group.name}.</p>
        {:else}
          <ul class="devices">
            {#each group.devices as device (device.address)}
              <li>
                <span class="d-kind">{signerKindLabel(device.kind)}</span>
                <code class="d-addr">{shortAddress(device.address ?? '')}</code>
              </li>
            {/each}
          </ul>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .faces {
    display: flex;
    gap: 0.35rem;
  }

  .faces .dim {
    opacity: 0.45;
    filter: grayscale(0.6);
  }

  .faces .more {
    background: #d0d5dd;
    color: var(--sf-ink);
  }

  .members {
    display: grid;
    gap: 0.4rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .members > li {
    padding: 0.6rem 0.7rem;
    border: 1px solid var(--sf-line);
    border-radius: var(--sf-radius-md);
    background: var(--sf-surface);
    display: grid;
    gap: 0.45rem;
  }

  .head-row {
    display: flex;
    align-items: center;
    gap: 0.65rem;
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

  .nokey {
    margin: 0;
    color: var(--sf-muted);
    font-size: 0.8125rem;
  }

  .devices {
    display: grid;
    gap: 0.25rem;
    margin: 0;
    padding: 0 0 0 1.9rem;
    list-style: none;
  }

  .devices li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8125rem;
    color: var(--sf-ink-soft);
  }

  .d-kind {
    font-weight: 500;
  }

  .d-addr {
    color: var(--sf-muted);
    font-size: 0.75rem;
  }
</style>
