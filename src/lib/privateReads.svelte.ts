// The private-read toggle. Default on: reads go through the anon-rpc sandbox.
// If it cannot boot, the failure is shown, never hidden, and reads fall back to
// the plain gateway with the UI saying so.

import { createPrivateReadProvider } from './anonRpc';
import type { PrivateReadStatus, PrivateReadProvider } from './anonRpc';
import { RPC_URL } from './chains';
import { setReadRouter } from './readRouter';

export const privateReads = $state<{
  enabled: boolean;
  status: PrivateReadStatus;
  reason: string | null;
}>({ enabled: true, status: 'pending', reason: null });

let provider: PrivateReadProvider | null = null;
let booting: Promise<void> | null = null;

export function privateReadsEnabled(): boolean {
  return privateReads.enabled && privateReads.status === 'ready';
}

/** The live sandbox, or null when reads must use the plain endpoint. */


/**
 * How long the sandbox may take to boot before the app stops claiming it is starting
 * and states plainly that reads are on the plain gateway. The anon-rpc worker retries
 * its KPS anchors indefinitely, so without a deadline the UI would say "starting…"
 * forever while every read silently used the plain endpoint.
 */
const BOOT_DEADLINE_MS = 20_000;

export function startPrivateReads(): void {
  // Only a session still in `pending` boots: a resolved status means the sandbox is
  // already up (or already known to be unavailable), so booting again would be
  // either redundant or a silent retry of a failure the UI already reported.
  if (!privateReads.enabled || privateReads.status !== 'pending' || booting || provider) return;
  booting = (async () => {
    const deadline = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), BOOT_DEADLINE_MS),
    );
    try {
      const outcome = await Promise.race([
        createPrivateReadProvider({ plainRpcUrl: RPC_URL }),
        deadline,
      ]);
      if (outcome === 'timeout') {
        privateReads.status = 'unavailable';
        privateReads.reason = `sandbox did not boot within ${BOOT_DEADLINE_MS / 1000}s`;
        setReadRouter(null);
        return;
      }
      provider = outcome;
      privateReads.status = provider.status();
      privateReads.reason = provider.failure();
      // Reads follow the sandbox only while it is genuinely ready.
      setReadRouter(privateReads.status === 'ready' ? provider : null);
    } catch (err) {
      privateReads.status = 'unavailable';
      privateReads.reason = err instanceof Error ? err.message : String(err);
      setReadRouter(null);
    } finally {
      booting = null;
    }
  })();
}

export function disablePrivateReads(): void {
  privateReads.enabled = false;
  provider?.close();
  provider = null;
  setReadRouter(null);
  privateReads.status = 'unavailable';
  privateReads.reason = 'disabled in this session';
}

export function enablePrivateReads(): void {
  privateReads.enabled = true;
  privateReads.status = 'pending';
  privateReads.reason = null;
  startPrivateReads();
}

/** Human label for the toggle, used verbatim in the UI. */
export function privateReadsLabel(): string {
  if (!privateReads.enabled) return 'Reads: plain (gateway sees traffic)';
  if (privateReads.status === 'ready') return 'Reads: private (anon-rpc)';
  if (privateReads.status === 'pending') return 'Reads: starting private sandbox…';
  return 'Reads: plain (gateway sees traffic)';
}
