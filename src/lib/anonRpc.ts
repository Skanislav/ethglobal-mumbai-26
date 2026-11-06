// The private-read boundary (ethereum/anon-rpc). Reads go through a hash-pinned
// worker in a null-origin sandbox; writes never do. If the worker cannot boot or
// its bundle hash does not match, the provider fails loudly instead of silently
// falling back to the plain gateway — the user must know which mode is active.

import { AnonRpcWorker, RpcError } from '@anon-rpc/browser-harness';
import { ANON_RPC_SPECIFIER, PRIVATE_READ_ENDPOINT } from './chains';

/** Only these methods are read-capable; anything else stays on the plain transport. */
const READ_METHODS: Record<string, true> = {
  eth_call: true,
  eth_getBalance: true,
  eth_blockNumber: true,
  eth_getCode: true,
  eth_getTransactionReceipt: true,
  eth_getLogs: true,
  eth_getTransactionCount: true,
  eth_estimateGas: true,
  eth_gasPrice: true,
  eth_feeHistory: true,
  eth_chainId: true,
};

export class NotARead extends Error {
  constructor(method: string) {
    super(`NotARead: ${method} must not go through the private-read sandbox`);
    this.name = 'NotARead';
  }
}

export type RpcProviderShim = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

/** Five-line JSON-RPC shim over the public endpoint; used only to bootstrap. */
export function makeRpcProvider(url: string): RpcProviderShim {
  return {
    async request({ method, params }) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params: params ?? [] }),
      });
      const body = (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
      if (body.error) throw new RpcError({ name: 'RpcError', message: body.error.message, code: String(body.error.code) });
      return body.result;
    },
  };
}

export type PrivateReadStatus = 'pending' | 'ready' | 'unavailable';

export type PrivateReadProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  close(): void;
  status(): PrivateReadStatus;
  failure(): string | null;
};

export type PrivateReadOptions = {
  specifierAddress?: `0x${string}`;
  plainRpcUrl: string;
  /** Fixed only in tests; production passes a fresh UUID per call. */
  perCallIsolationKey?: () => string;
  endpoint?: string;
};

export class PrivateReadFailed extends Error {
  readonly httpStatus: number;
  readonly endpoint: string;
  readonly upstream: string;

  constructor(args: { httpStatus: number; endpoint: string; upstream: string; detail?: string }) {
    const host = (() => {
      try {
        return new URL(args.endpoint).host;
      } catch {
        return args.endpoint;
      }
    })();
    super(
      `PrivateReadFailed: ${host} returned HTTP ${args.httpStatus}${args.detail ? ` — ${args.detail}` : ''}` +
        `${args.upstream ? ` (upstream said: ${args.upstream})` : ''}`,
    );
    this.name = 'PrivateReadFailed';
    this.httpStatus = args.httpStatus;
    this.endpoint = args.endpoint;
    this.upstream = args.upstream;
  }
}

/** Pulls the server's own explanation out of a body that may not be JSON at all. */
async function describeFailure(res: Response): Promise<{ detail: string; upstream: string }> {
  const raw = await res.text().catch(() => '');
  if (!raw) return { detail: '', upstream: '' };
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string; code?: number | string } };
    if (parsed.error?.message) {
      return {
        detail: `error ${parsed.error.code ?? '?'}: ${parsed.error.message}`,
        upstream: parsed.error.message,
      };
    }
  } catch {
    // Not JSON: keep the raw text, trimmed, as the explanation.
  }
  return { detail: '', upstream: raw.slice(0, 300) };
}

export async function createPrivateReadProvider(opts: PrivateReadOptions): Promise<PrivateReadProvider> {
  let status: PrivateReadStatus = 'pending';
  let failure: string | null = null;
  const worker = new AnonRpcWorker({
    address: opts.specifierAddress ?? ANON_RPC_SPECIFIER,
    preExisting: { rpcProvider: makeRpcProvider(opts.plainRpcUrl) },
  });
  const nextKey = opts.perCallIsolationKey ?? (() => crypto.randomUUID());

  try {
    await worker.ready;
    status = 'ready';
  } catch (e) {
    status = 'unavailable';
    failure = e instanceof Error ? e.message : String(e);
    worker.close();
  }

  return {
    async request({ method, params }) {
      if (READ_METHODS[method] !== true) throw new NotARead(method);
      if (status !== 'ready') throw new RpcError({ name: 'worker-failed', message: failure ?? 'private reads are not ready' });
      const res = await worker.fetch(opts.endpoint ?? PRIVATE_READ_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params: params ?? [] }),
        anonOptions: { isolationKey: nextKey() },
      });
      if (!res.ok) {
        const endpoint = opts.endpoint ?? PRIVATE_READ_ENDPOINT;
        const { detail, upstream } = await describeFailure(res);
        throw new PrivateReadFailed({ httpStatus: res.status, endpoint, upstream, detail });
      }
      const body = (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
      if (body.error) {
        throw new RpcError({ name: 'RpcError', message: body.error.message, code: String(body.error.code) });
      }
      return body.result;
    },
    close() {
      worker.close();
    },
    status() {
      return status;
    },
    failure() {
      return failure;
    },
  };
}
