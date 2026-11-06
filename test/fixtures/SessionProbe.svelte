<script lang="ts">
  // Test fixture: reads the module-level session directly, which is exactly the
  // cross-component sharing the app relies on.
  import { session } from '../../src/lib/session.svelte';
</script>

<p data-testid="probe">
  count={session.current.signers.length} threshold={session.current.threshold}
</p>
