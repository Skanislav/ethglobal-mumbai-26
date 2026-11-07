<script lang="ts">
  import { onMount } from 'svelte';
  import '../lib/theme.css';
  import RpcStatusBorder from '../lib/components/RpcStatusBorder.svelte';
  import { startPrivateReads } from '../lib/privateReads.svelte';

  let { children } = $props();

  // Boot the private-read sandbox globally: the status border frames every
  // screen, so the client must not depend on the welcome panel being mounted.
  onMount(() => {
    startPrivateReads();
  });
</script>

{@render children()}
<RpcStatusBorder />
