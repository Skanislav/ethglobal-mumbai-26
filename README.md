[![Safe Signer Onboarding](https://img.shields.io/badge/Safe-1.4.1-12FF80)](https://safe.global) ![chain](https://img.shields.io/badge/chain-Sepolia%20only-orange)

# Safe Signer Onboarding

A client-only wizard for putting together a Safe multisig out of the signers you
actually have — a browser wallet, a passkey, an ARX HaLo NFC chip, a Ledger, a
Trezor, or a throwaway demo key — then deploying the Safe with that exact owner
set and threshold and executing one test transaction.

There is no backend, no relay, no custody. A session is a JSON blob you move
around out-of-band (copy/paste, a file, or a URL fragment). One Safe per session,
one pending transaction at a time: this is an onboarding tool, not a Safe UI.

## Session persistence

Everything needed to continue survives a reload: the session blob (owners, threshold, salt,
pending transaction, collected signatures), the current step, and demo keys. All of it
lives in `localStorage` under `sso.*` and none of it is ever sent anywhere.

Owner labels are editable in place and are the only user-facing name an owner has; they
never affect ownership or signing. A passkey takes its name at creation and passes it to
the credential, so it is recognisable later in the OS keychain.

**Demo keys are stored on disk in plaintext.** That is the price of surviving a reload. The
key is Sepolia-only and holds nothing, the UI keeps a permanent TESTNET-ONLY badge while one
is in the owner set, and "Forget demo keys" removes them. A key is never written into an
exported session, a URL, or any request.

## Sharing a vault with a second person

The Invite screen turns the session into a link. The other person opens it, sees the vault and
its invited members, adds their own key, and sends a fresh link on to the next person — the
session continues locally on each machine.

**The link carries the session.** Nothing is published, no fee is paid, and opening a link
needs no chain access:

```
{origin}{pathname}#/invite/<payload>
payload = base64url( version 0x01 || deflate-raw(compact JSON) )
```

The payload sits in the fragment, which a browser never puts on the wire, so no request-line
limit applies and an invite is not sent to any server by opening or sharing it. The guard is
`MAX_SHARE_URL_LENGTH = 2048`, because that is what chat clients, mail clients and link
previews behave like. For the record, no RFC sets a URI limit: RFC 9110 has none, and RFC 2616
§3.2.1 only cautions above 255 bytes — the 2048 figure is IE's 2083 and Apache's request-line
advice. Taking the smaller number costs nothing and removes the question.

### Capacity

A joined owner costs **33.5 characters** (a 20-byte address plus a label, with DEFLATE over the
lot); an invited name costs a few, because it carries no address; a vault's fixed part is ~124.

Lengths vary by a few characters between runs — DEFLATE's block boundaries fall differently
over high-entropy addresses — so these are ranges, not single values:

| Vault | Link length |
|---|---|
| 3 owners, 2 invited names | ~250 |
| 10 owners | 472–477 |
| 30 owners | 1137–1145 |
| 50 owners | 1806–1812 |
| **57 owners — the ceiling at `https://safelyfy.example/`** | **2038–2046** |
| 58 owners | over 2048, refused |

So **about 57 joined owners** fit, or far more invited names than a real family has. The exact
number moves by one owner for every ~33 characters of origin+path: 57 on a 24-character origin,
56 on a 29-character one. A deployed vault costs slightly more, since its address and salt
travel too.

`ownersPerLink(origin, pathname)` derives the number from those measured constants, and the
Invite screen shows it live — the built link reports its own length against the budget:

> 134 of 2048 characters. The link carries the whole vault, so it opens offline; it holds about
> 56 joined owners, and each extra one costs roughly 33 characters.

`createInviteLink` throws `ShareTooLarge` rather than hand back a link that will arrive
truncated, and the message says what to do:

> That vault is too big to fit in a link: the link would be 2666 characters, over 2048. Every
> joined owner adds ~33 characters, so remove a few members and share again.

The separate `MAX_MEMBERS` cap of 128 is a sanity bound that the length limit reaches first, so
the failure always names the real reason.

`decodeSharePayload` re-validates through `decodeSession`, the same validator every stored
session passes, so a link can never construct a session the app could not persist. An owner who
arrives by link is `canSign: false`: the key stayed with whoever holds it, and connecting the
matching wallet upgrades that record in place.

### Why not EIP-4844 blobs

Blobs were the first design and could not work. Publishing one needs a type-3 transaction;
ordinary wallets refuse to build one, and a wallet that "accepts" the request can still send the
payload as ordinary calldata — the publisher pays gas and gets a success receipt for a
transaction that carried no blob, so the link names something that does not exist. That happened
in practice here: a legacy type-0 self-send, `gasUsed` 12000, no `blobGasUsed`.

### Why not a Patricia trie

A trie is a key→value structure: each node spends a path element per nibble, so serialising this
payload that way is several times *larger* than the payload. Measured on a small vault: a 3.2 KB
lower bound for an MPT versus 947 bytes for plain base64url, and 368 bytes once DEFLATE runs. A
link needs the smallest representation; integrity comes from validating the decoded session, not
from trie structure.

## Signer kinds

| Kind | How it becomes an owner | Signs by |
|---|---|---|
| Browser wallet | its EOA address | EIP-1193 `eth_signTypedData_v4` through protocol-kit |
| Demo key | an EOA generated in this tab | in-tab key from `sessionStorage` |
| Passkey | `SafeWebAuthnSignerFactory.getSigner(x, y, verifiers)` proxy address | WebAuthn assertion encoded as a contract signature |
| HaLo NFC chip | the chip's uncompressed secp256k1 key → EOA, read by tapping the chip to the phone | NFC tap over the raw SafeTx digest |
| Ledger | EOA at the HD path | `signEIP712HashedMessage` over WebHID |
| Trezor | EOA at the HD path | `ethereumSignTypedData` via the Suite popup |

## State transitions

Every onchain action this app can produce is listed here. All of them are user
triggered; **the app deploys no contracts of its own** and holds no authority.

| Transition | Caller | Why they pay | If nobody calls |
|---|---|---|---|
| `createProxyWithNonce` — Safe deploy | any funded Sepolia EOA | onboarding their own Safe | the Safe never exists; nothing is at risk |
| `factory.createSigner` — passkey proxy | any funded EOA | makes their passkey usable as the owner they chose | passkey owner unusable; the Safe still works for its other owners |
| `addOwnerWithThreshold` / `changeThreshold` | an existing owner via threshold signatures | configuring their own Safe | the signer set stays as it is |
| `execTransaction` — test transaction | any funded EOA holding threshold signatures | proving their Safe works | nothing executes; funds untouched |

Nothing runs on a schedule and nothing must be kept alive. A deployed Safe is
fully operable from the standard Safe UI with or without this app.

## CROPS

- **Censorship resistance** — no operator, no allowlist, no privileged path. The
  app is a static bundle; anyone can fork or rehost it.
- **Open source** — MIT. The build is a static `build/` directory served from an
  `index.html` fallback, so it can be hosted anywhere, IPFS included.
- **Privacy** — everything the app does onchain is public by design (owner list,
  threshold, calldata). The exported session carries only public data plus
  labels: never a key. Reads optionally go through an anon-rpc sandbox so a
  fixed gateway does not learn which Safe you are inspecting; writes stay on the
  observable plain RPC, which the UI states plainly.
- **Security** — no funds custody. The only credential the app can hold is the
  explicitly labeled demo key, which lives in `sessionStorage` and dies with the
  tab. Escape path: the Safe itself is yours, operable from the standard Safe UI.

## Commands

Every script runs under **bun**, and that is load-bearing rather than a preference.
`node_modules/.bin/svelte-kit` starts with `#!/usr/bin/env node`, so a plain
`bun run check` hands the process to whatever `node` is first on `PATH`. Under Node
18 that fails immediately:

```
SyntaxError: The requested module 'node:util' does not provide an export named 'styleText'
```

`util.styleText` landed in Node 20.12, and SvelteKit 3 requires it. The scripts are
therefore split: `*.raw` holds the real command, and the public name runs it through
`bun run --bun`, which forces bun's own runtime instead of honouring the shebang. So
`bun run check` works regardless of which Node you have installed. `.nvmrc` pins Node
20 for anyone who runs the `.raw` scripts directly.

```sh
bun install          # exact pins in package.json, lockfile committed
bun run dev          # vite dev server on :5173
bun run check        # svelte-kit sync + svelte-check
bun run test         # vitest component tests (happy-dom + browser condition)
bun run test:unit    # bun test, pure-TS units (session codec, encodings)
bun run build        # adapter-static output in build/
bun run preview      # serve build/ on :4173
bun run pin          # pin build/ to IPFS via Pinata, print the CID
bun run deploy       # build, then pin
```

`VITE_RPC_URL` overrides the Sepolia endpoint used for reads and writes (default:
`https://ethereum-sepolia-rpc.publicnode.com`). No keyed RPC URL may be committed.

`VITE_PRIVATE_READ_ENDPOINT` overrides the destination the anon-rpc sandbox calls
(default: `https://sepolia.gateway.tenderly.co`). Do not point it at
`sepolia.drpc.org`: that host answers HTTP 400 `code 35` — "chain is not available on
free plan" — for Sepolia, which is what produced the earlier `private read failed with
HTTP 400`.

Private reads are a toggle, never a hidden dependency. The sandbox has 20 seconds to
boot; if it does not, or if any read fails, the UI says **"Reads: plain (gateway sees
traffic)"** together with the reason and the upstream's own message (for a non-2xx
response the body is surfaced, not just the status code). Every read then uses the plain
endpoint and the wizard keeps working; the failure is never swallowed and never silently
retried.

## Deployment to IPFS

The build is a static `build/` directory whose entry point is `index.html`, so it can be
pinned to IPFS and served by any gateway or by an ENS name. `bun run pin` does the pinning;
`bun run deploy` runs `build` first.

```sh
cp .env.example .env      # then set PINATA_JWT (app.pinata.cloud → API Keys → New Key,
bun run deploy            # Files: Write). The JWT is a write credential: never commit it.
```

`PINATA_GATEWAY` is optional. When it holds a dedicated gateway host
(`my-gw.mypinata.cloud`), the post-pin check and the printed preview URL use it; otherwise
they use `dweb.link`.

The pin posts one multipart request to `POST /pinning/pinFileToIPFS` with every file under
a single `site/` wrapper path. That wrapper is what keeps `index.html` at the **root** of
the returned CID — the wrapper name is consumed as the directory being pinned and never
appears in a served path. A pin that instead nests the site one level down serves a
directory listing at `ipfs://<cid>/`, which breaks both eth.limo and any gateway, so the
script checks rather than trusts:

- it fetches the root of the new CID from the configured gateway, `gateway.pinata.cloud`,
  `dweb.link` and `ipfs.io`, retrying for about a minute;
- a **200 at the CID root with no app bootstrap** (i.e. a directory listing) fails the run
  with the CID still saved to `.cid` — the content is pinned, the contenthash must not be
  set. Only that signature counts as evidence: a 404 (not yet propagated), a 400 (gateway
  never saw the CID), a 429 or a 5xx is reported as *unconfirmed* rather than painted red,
  because none of them say anything about the pin. An unconfirmed run prints the preview
  URL and tells you to look before touching ENS.

CIDs are requested as CIDv1 (`bafy…`), because `<cid>.ipfs.dweb.link` does not serve CIDv0.

Set the ENS contenthash by hand, after the gate passes: [app.ens.domains](https://app.ens.domains)
→ your name → **Records → Content Hash → Edit** → `ipfs://<cid>` → sign. That is a mainnet
transaction, which is exactly why no key for it lives in CI.

`.github/workflows/deploy.yml` runs `check`, `test`, `build` and `pin` on every push to
`main`, writes the CID to the job summary and uploads `.cid` as an artifact. It needs the
`PINATA_JWT` secret (and optionally `PINATA_GATEWAY`). A missing JWT fails the job rather
than skipping the pin.

Alternative pinning, if you would rather not use Pinata: `ipfs add -r --cid-version 1 build`
(or BuidlGuidl's key-free `npx bgipfs upload build`), then point the contenthash at the
resulting CID.

## Onchain verification

```sh
anvil --fork-url https://ethereum-sepolia-rpc.publicnode.com --port 8545 \
      --gas-price 1000000000 --base-fee 1000000000
cast rpc anvil_setIntervalMining 1 --rpc-url http://127.0.0.1:8545
RPC_URL=http://127.0.0.1:8545 FORK_PAYER_KEY=0x… bun run test:fork
```

The script drives the app's own modules, three times over:

1. Predicts and deploys a 2-of-2 Safe (hot wallet + passkey), deploys the passkey
   proxy, signs with both, executes, and asserts the nonce advanced by one.
2. Deploys a 1-of-1 Safe and moves it to 2-of-2 with one MultiSend batch
   (`operation` 1) that runs `factory.createSigner` then `addOwnerWithThreshold`,
   then executes a 2-of-2 transaction from the newly installed owner set.
3. Encodes a vault to an invite link, decodes it, has the reader join and re-share,
   and asserts the new link carries both members and the raised threshold. This leg
   touches no chain: the link is the whole payload.

It closes with two refusals: a single signature cannot execute a 2-of-2 (reverts
`GS021`), and the client refuses to build `execTransaction` below the threshold.
`FORK_PAYER_KEY` is read from the environment at run time.

## What is verified, and what is not

Exercised end to end on an anvil fork of Sepolia, through this app's own modules:

- **The browser walkthrough.** The Safe was deployed from the UI, both owners signed
  (browser wallet + demo key), the test transaction executed, and `nonce()` advanced
  to 1 onchain with receipt status `0x1`.
- **Signature encodings.** The passkey blob round-trips `r` and `s` byte-for-byte,
  including an `s` tail that is not `1f` (protocol-kit's own passkey path rewrote it
  to `1f`), and the client-data slice matches what `WebAuthn.sol` rebuilds.
- **Passkey owners.** A 2-of-2 Safe whose passkey proxy was deployed after the Safe,
  then executed onchain.
- **Existing-Safe owner install.** A MultiSend batch (`operation` 1) running
  `factory.createSigner` then `addOwnerWithThreshold`, moving a 1-of-1 Safe to 2-of-2,
  followed by a successful 2-of-2 execution.
- **Refusals.** One signature cannot satisfy a 2-of-2 (reverts `GS021`), and the app
  refuses to build `execTransaction` below the threshold.
- **Invite links.** A vault encodes to a link that fits 2048 characters for up to 57
  joined owners, and decodes back with the same vault name, joined owner and pending
  invitees; owners arriving by link are never signable; a truncated, foreign or
  oversized payload is refused with its own message. In the browser, the Invite screen
  built a link with no wallet connected, opening it in a fresh tab imported the vault
  and stripped the fragment, and re-sharing from that imported session produced a new
  link carrying the same members.
- **Live reads.** Pinned deployments verified onchain, ETH/USD read from the Sepolia
  Chainlink feed, gas estimated on the exact calldata at click time.

Not automatable here: a real passkey prompt, a real HaLo tap, a real Ledger over
WebHID, a real Trezor through the Suite popup. Their signature encodings are proven at
the fork level (Trezor's digest path is byte-identical to Ledger's); the physical
transports need a human with the device.

The anon-rpc sandbox is the one component whose readiness depends on third-party KPS
anchors. Where no anchor is reachable it reports `unavailable` with the specific
failures and the UI states it verbatim; reads then use the plain gateway.
