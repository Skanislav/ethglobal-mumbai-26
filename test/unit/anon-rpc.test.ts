// The private-read boundary: only read methods reach the sandbox, a failed boot
// surfaces instead of falling back, and each call is isolated by a fresh key.

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { encodeFunctionData, parseAbi } from 'viem';

type FetchInit = { headers?: Record<string, string>; body?: string; anonOptions?: { isolationKey?: string } };
type FetchCall = { url: string; init: FetchInit };

const AB = parseAbi(['function decimals() view returns (uint8)']);

/** Stub of the anon-rpc worker: records calls, answers with a canned JSON-RPC result. */
class StubWorker {
  static calls: FetchCall[] = [];
  static readyBehaviour: 'ok' | 'reject' = 'ok';
  ready: Promise<void>;
  closed = false;
  constructor() {
    this.ready =
      StubWorker.readyBehaviour === 'ok'
        ? Promise.resolve()
        : Promise.reject(new Error('bundle hash mismatch: expected 0xd9fa, got 0xdead'));
    this.ready.catch(() => {});
  }
  async fetch(url: string, init: FetchInit): Promise<Response> {
    StubWorker.calls.push({ url, init });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x12' }), { status: 200 });
  }
  close(): void {
    this.closed = true;
  }
}

process.env.STUB_ANON = '1';

function makeProvider(overrides: Record<string, unknown> = {}) {
  return {
    specifierAddress: '0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A' as const,
    plainRpcUrl: 'http://stub.invalid/',
    endpoint: 'http://stub.invalid/private',
    ...overrides,
  };
}

describe('makeRpcProvider', () => {
  it('posts the JSON-RPC envelope and returns the result', async () => {
    const seen: { body: string; method: string }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      const parsed = JSON.parse(init.body) as { method: string; id: number; jsonrpc: string };
      seen.push({ body: init.body, method: parsed.method });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: '0x10' }), { status: 200 });
    }) as unknown as typeof fetch;

    const { makeRpcProvider } = await import('../../src/lib/anonRpc');
    const provider = makeRpcProvider('http://stub.invalid/');
    const result = await provider.request({ method: 'eth_blockNumber' });

    globalThis.fetch = original;
    expect(result).toBe('0x10');
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('eth_blockNumber');
    expect(JSON.parse(seen[0].body).jsonrpc).toBe('2.0');
  });

  it('surfaces an RPC error object as a thrown error', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } }), {
        status: 200,
      })) as unknown as typeof fetch;
    const { makeRpcProvider } = await import('../../src/lib/anonRpc');
    const provider = makeRpcProvider('http://stub.invalid/');
    await expect(provider.request({ method: 'eth_call' })).rejects.toThrow(/boom/);
    globalThis.fetch = original;
  });
});

describe('createPrivateReadProvider', () => {
  beforeEach(() => {
    StubWorker.calls = [];
    StubWorker.readyBehaviour = 'ok';
    // Faithful to the real export: it takes a serialized error and adopts its message/name.
    class StubRpcError extends Error {
      code?: string;
      constructor(e: { name?: string; message: string; code?: string }) {
        super(e.message);
        this.name = e.name ?? 'RpcError';
        this.code = e.code;
      }
    }
    mock.module('@anon-rpc/browser-harness', () => ({ AnonRpcWorker: StubWorker, RpcError: StubRpcError }));
  });

  it('routes a read through the sandbox with a fresh isolation key per call', async () => {
    const { createPrivateReadProvider } = await import('../../src/lib/anonRpc');
    const provider = await createPrivateReadProvider(makeProvider());
    expect(provider.status()).toBe('ready');

    await provider.request({ method: 'eth_blockNumber' });
    await provider.request({ method: 'eth_blockNumber' });

    const keys = StubWorker.calls.map((c) => c.init.anonOptions?.isolationKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeDefined();
    expect(keys[0]).not.toBe(keys[1]);

    const body = JSON.parse(StubWorker.calls[0].init.body ?? '{}') as { method: string };
    expect(body.method).toBe('eth_blockNumber');
  });

  it('keeps the isolation key configurable for deterministic tests', async () => {
    const { createPrivateReadProvider } = await import('../../src/lib/anonRpc');
    let n = 0;
    const provider = await createPrivateReadProvider(makeProvider({ perCallIsolationKey: () => `k${++n}` }));
    await provider.request({ method: 'eth_chainId' });
    await provider.request({ method: 'eth_chainId' });
    expect(StubWorker.calls.map((c) => c.init.anonOptions?.isolationKey)).toEqual(['k1', 'k2']);
  });

  it('refuses a write method before touching the worker', async () => {
    const { createPrivateReadProvider, NotARead } = await import('../../src/lib/anonRpc');
    const provider = await createPrivateReadProvider(makeProvider());
    await expect(provider.request({ method: 'eth_sendTransaction' })).rejects.toBeInstanceOf(NotARead);
    expect(StubWorker.calls).toHaveLength(0);
  });

  it('refuses every non-read method, not just the obvious one', async () => {
    const { createPrivateReadProvider, NotARead } = await import('../../src/lib/anonRpc');
    const provider = await createPrivateReadProvider(makeProvider());
    for (const method of ['eth_sendRawTransaction', 'eth_sign', 'personal_sign', 'net_version']) {
      await expect(provider.request({ method })).rejects.toBeInstanceOf(NotARead);
    }
    expect(StubWorker.calls).toHaveLength(0);
  });

  it('fails loudly when the bundle hash does not match, and never falls back', async () => {
    StubWorker.readyBehaviour = 'reject';
    const { createPrivateReadProvider } = await import('../../src/lib/anonRpc');
    const provider = await createPrivateReadProvider(makeProvider());

    expect(provider.status()).toBe('unavailable');
    expect(provider.failure()).toContain('bundle hash mismatch');
    // The failure surfaces as an RpcError named `worker-failed`; the message carries the reason.
    await expect(provider.request({ method: 'eth_call' })).rejects.toMatchObject({ name: 'worker-failed' });
    expect(StubWorker.calls).toHaveLength(0);
  });

  it('encodes a contract call the public endpoint can answer', async () => {
    const { createPrivateReadProvider } = await import('../../src/lib/anonRpc');
    const provider = await createPrivateReadProvider(makeProvider());
    const data = encodeFunctionData({ abi: AB, functionName: 'decimals' });
    const result = await provider.request({ method: 'eth_call', params: [{ to: '0x0000000000000000000000000000000000000001', data }, 'latest'] });
    expect(result).toBe('0x12');
    const body = JSON.parse(StubWorker.calls[0].init.body ?? '{}') as { params: unknown[] };
    expect(body.params[0]).toEqual({ to: '0x0000000000000000000000000000000000000001', data });
  });
});

describe('private-read failure reporting', () => {
  beforeEach(() => {
    StubWorker.calls = [];
    StubWorker.readyBehaviour = 'ok';
    mock.module('@anon-rpc/browser-harness', () => ({
      AnonRpcWorker: class extends StubWorker {
        async fetch(url: string, init: FetchInit): Promise<Response> {
          StubWorker.calls.push({ url, init });
          return new Response(
            JSON.stringify({
              id: 1,
              jsonrpc: '2.0',
              error: { message: 'chain is not available on free plan', code: 35 },
            }),
            { status: 400 },
          );
        }
      },
      RpcError: class extends Error {},
    }));
  });

  it('surfaces the upstream body and endpoint, not just the status code', async () => {
    const { createPrivateReadProvider, PrivateReadFailed } = await import('../../src/lib/anonRpc');
    const provider = await createPrivateReadProvider(makeProvider({ endpoint: 'https://sepolia.drpc.org' }));

    const failure = await provider.request({ method: 'eth_call' }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(PrivateReadFailed);
    const err = failure as InstanceType<typeof PrivateReadFailed>;

    // The message a user actually saw was "HTTP 400", which says nothing. The
    // actionable part is the upstream explanation, and the host that produced it.
    expect(err.httpStatus).toBe(400);
    expect(err.endpoint).toBe('https://sepolia.drpc.org');
    expect(err.upstream).toContain('chain is not available on free plan');
    expect(err.message).toContain('sepolia.drpc.org');
    expect(err.message).toContain('chain is not available on free plan');
  });

  it('keeps a non-JSON body as its own explanation', async () => {
    mock.module('@anon-rpc/browser-harness', () => ({
      AnonRpcWorker: class extends StubWorker {
        async fetch(url: string, init: FetchInit): Promise<Response> {
          StubWorker.calls.push({ url, init });
          return new Response('<html>522 origin down</html>', { status: 522 });
        }
      },
      RpcError: class extends Error {},
    }));
    const { createPrivateReadProvider } = await import('../../src/lib/anonRpc');
    const provider = await createPrivateReadProvider(makeProvider({ endpoint: 'https://rpc.sepolia.org' }));
    const failure = (await provider.request({ method: 'eth_call' }).catch((e: unknown) => e)) as Error;
    expect(failure.message).toContain('522');
    expect(failure.message).toContain('522 origin down');
  });
});

describe('humanError for private reads', () => {
  it('tells the user how to keep working', async () => {
    const { humanError } = await import('../../src/lib/format');
    const { PrivateReadFailed } = await import('../../src/lib/anonRpc');
    const err = new PrivateReadFailed({
      httpStatus: 400,
      endpoint: 'https://sepolia.drpc.org',
      upstream: 'chain is not available on free plan',
    });
    const message = humanError(err);
    expect(message).toContain('sepolia.drpc.org');
    expect(message).toContain('chain is not available on free plan');
    expect(message).toContain('Turn off private reads');
  });
});
