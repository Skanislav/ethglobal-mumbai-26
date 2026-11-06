// The read-routing seam. `client.ts` and the anon-rpc sandbox both need it, and the
// Node-side fork script needs `client.ts` without any Svelte runes — so the routing
// decision is a plain module with a settable source, not a `$state`.

export type RoutingProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

let active: RoutingProvider | null = null;

/** The sandbox to route reads through, or null for the plain endpoint. */
export function setReadRouter(provider: RoutingProvider | null): void {
  active = provider;
}

export function readRouter(): RoutingProvider | null {
  return active;
}
