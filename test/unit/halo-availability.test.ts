// Availability detection must construct NDEFReader the way libhalo's own
// `detectMethod()` does: a browser whose class exists but whose constructor
// throws (insecure context, desktop stub) used to pass the `typeof` check and
// then fail deep in a scan as "device does not support Web NFC" — on phones
// that have NFC, which is the reported regression.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { haloAvailable, haloProbe } from '../../src/lib/signers/halo';

const realWindow = globalThis.window;

function stubWindow(shape: Record<string, unknown>): void {
  (globalThis as Record<string, unknown>).window = shape;
}

beforeEach(() => stubWindow({ isSecureContext: true }));
afterEach(() => {
  (globalThis as Record<string, unknown>).window = realWindow;
});

describe('halo availability', () => {
  it('is unavailable when the NDEFReader constructor throws despite the class existing', () => {
    // happy-dom and desktop browsers both ship a shape like this.
    stubWindow({
      isSecureContext: true,
      NDEFReader: class {
        constructor() {
          throw new Error('NFC not supported on this platform');
        }
      },
    });
    expect(haloAvailable()).toBe(false);
  });

  it('is available when the constructor succeeds or a bridge is injected', () => {
    stubWindow({ isSecureContext: true, NDEFReader: class {} });
    expect(haloAvailable()).toBe(true);
    stubWindow({ isSecureContext: true, HaloBridge: class {} });
    expect(haloAvailable()).toBe(true);
  });

  it('reports the constructor error verbatim so the user sees the real cause', async () => {
    stubWindow({
      isSecureContext: true,
      NDEFReader: class {
        constructor() {
          throw new Error('NFC hardware is disabled');
        }
      },
    });
    const probe = await haloProbe();
    expect(probe.ok).toBe(false);
    if (!probe.ok) expect(probe.reason).toContain('NFC hardware is disabled');
  });

  it('names the insecure-context cause, the most common silent failure for NFC', async () => {
    stubWindow({ isSecureContext: false, NDEFReader: class {} });
    const probe = await haloProbe();
    expect(probe).toEqual({ ok: false, reason: 'NFC needs a secure context — open this page over HTTPS' });
  });

  it('detects webnfc when the constructor works', async () => {
    stubWindow({ isSecureContext: true, NDEFReader: class {} });
    expect(await haloProbe()).toEqual({ ok: true, method: 'webnfc' });
  });
});
