# AGENTS.md — project rules

Toolchain: `bun` only. Node is never the runtime for a project script — every public
script runs `bun run --bun <name>.raw`, because `node_modules/.bin/*` shebangs point at
`/usr/bin/env node` and Node < 20.12 lacks `util.styleText`, which SvelteKit 3 imports at
startup. Running the `.raw` scripts directly needs Node ≥ 20.12 (`.nvmrc` pins 20).

Svelte work uses the official Svelte MCP server (`svelte`, url https://mcp.svelte.dev/mcp,
registered in .omp/mcp.json).

1. `list-sections` first when a question is Svelte/SvelteKit-specific, then
   `get-documentation` with {"section": [...]} for ALL relevant sections (the argument key is
   `section`, not `sections`).
2. After writing or editing any `.svelte` file, call `svelte-autofixer` with
   {"code": <full file>, "desired_svelte_version": "5.57.3"} and fix everything it reports;
   repeat while its response sets require_another_tool_call_after_fixing = true.
3. Never call `playground-link` — code lives in this project, not the playground.
4. Svelte 5 rules the autofixer flags: `onclick={...}` attributes (not `on:click`),
   `$state`/`$props`/`$effect` runes, never `export const x = $derived(...)` from a
   `.svelte.ts` module (export a function), no `$lib` (SvelteKit 3: relative imports).
5. Runes live only in `*.svelte.ts` files that render. Anything a Node script or a plain
   unit test imports must be rune-free — `client.ts` routes reads through
   `readRouter.ts`, not through `privateReads.svelte.ts`, for exactly this reason.

Onchain work (addresses, deploys, transactions, gas quotes): read
https://ethskills.com/SKILL.md first and fetch the task-relevant skills. Hard rules for this
repo: resolve Safe contract addresses only via `@safe-global/safe-deployments`
(src/lib/chains.ts) — ethskills' address table lists the L1-flavor singleton and MultiSend,
not the L2/MultiSendCallOnly set protocol-kit uses on Sepolia; the `verifiers` argument of
`SafeWebAuthnSignerFactory` is the P-256 verifier *address* as uint176, never a bitfield;
never quote a gas or USD cost from memory (estimate + live feed at click time); no private
key or keyed RPC URL may be committed; this project ships zero custom contracts and must
not grow any.
