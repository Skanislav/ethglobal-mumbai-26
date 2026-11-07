<script lang="ts">
  import type { Snippet } from 'svelte';

  let { onCreate, footer }: { onCreate: () => void; footer?: Snippet } = $props();

  /** The orbit ring: three avatars placed by angle, drawn in CSS rather than an image. */
  const orbit = [
    { label: 'M', slot: 'nw' },
    { label: 'D', slot: 'ne' },
    { label: 'A', slot: 's' },
  ];
</script>

<div class="welcome">
  <div class="brand">
    <span class="shield" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
        <path
          d="M12 2.5 4.5 5.5v6c0 4.5 3.1 8.4 7.5 10 4.4-1.6 7.5-5.5 7.5-10v-6L12 2.5Z"
          fill="#fff"
          fill-opacity="0.95"
        />
      </svg>
    </span>
    safelyfy
  </div>

  <div class="orbit" aria-hidden="true">
    <span class="ring"></span>
    <span class="shield shield--big">
      <svg viewBox="0 0 24 24" width="30" height="30" fill="none">
        <path
          d="M12 2.5 4.5 5.5v6c0 4.5 3.1 8.4 7.5 10 4.4-1.6 7.5-5.5 7.5-10v-6L12 2.5Z"
          fill="#fff"
        />
      </svg>
    </span>
    {#each orbit as person (person.label)}
      <span class="avatars {person.slot} sf-avatar {person.label === 'D' ? 'sf-avatar--violet' : person.label === 'A' ? 'sf-avatar--rose' : ''}">
        {person.label}
      </span>
    {/each}
  </div>

  <h1>One wallet for the whole family</h1>
  <p class="lede">
    Everyone keeps their own key on their own phone. Money moves only when enough of you agree.
  </p>

  <ul class="trust">
    <li><span class="dot">✓</span> No single point of failure</li>
    <li><span class="dot">✓</span> You hold the keys</li>
  </ul>

  <div class="ctas">
    <button class="sf-btn" onclick={onCreate}>Create a family vault</button>
  </div>

  {#if footer}
    <div class="footer">
      {@render footer()}
    </div>
  {/if}
</div>

<style>
  .welcome {
    display: grid;
    gap: 1rem;
    align-content: start;
    flex: 1;
    text-align: center;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: 800;
    letter-spacing: -0.01em;
  }

  .shield {
    display: grid;
    place-items: center;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 50%;
    background: var(--sf-primary);
    flex: none;
  }

  .orbit {
    position: relative;
    display: grid;
    place-items: center;
    height: 11rem;
    margin-top: 0.5rem;
  }

  .ring {
    position: absolute;
    width: 9rem;
    height: 9rem;
    border: 1px dashed #c9d2e6;
    border-radius: 50%;
  }

  .shield--big {
    width: 4.25rem;
    height: 4.25rem;
    box-shadow: 0 10px 24px rgb(43 77 246 / 0.28);
  }

  .avatars {
    position: absolute;
    width: 2.35rem;
    height: 2.35rem;
    box-shadow: 0 4px 12px rgb(16 24 40 / 0.14);
  }

  .nw {
    top: 0.75rem;
    left: 18%;
  }

  .ne {
    top: 1.25rem;
    right: 18%;
  }

  .s {
    bottom: 0.5rem;
  }

  h1 {
    margin: 0;
    font-size: 1.6rem;
    line-height: 1.2;
    letter-spacing: -0.02em;
  }

  .lede {
    margin: 0;
    color: var(--sf-muted);
    font-size: 0.9375rem;
    line-height: 1.45;
  }

  .trust {
    display: grid;
    gap: 0.45rem;
    margin: 0;
    padding: 0;
    list-style: none;
    justify-items: center;
  }

  .trust li {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0.7rem;
    border-radius: 999px;
    background: var(--sf-surface);
    border: 1px solid var(--sf-line);
    font-size: 0.8125rem;
    color: var(--sf-ink-soft);
  }

  .dot {
    display: grid;
    place-items: center;
    width: 1rem;
    height: 1rem;
    border-radius: 50%;
    background: var(--sf-primary-soft);
    color: var(--sf-primary);
    font-size: 0.625rem;
    font-weight: 700;
  }

  .ctas {
    display: grid;
    gap: 0.6rem;
    margin-top: auto;
    padding-top: 1rem;
  }

  .footer {
    display: grid;
    gap: 0.5rem;
  }
</style>
