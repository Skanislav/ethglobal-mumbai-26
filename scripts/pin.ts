// Pin the static build in `build/` to IPFS via Pinata and write the folder CID to `.cid`.
//
// Why the wrapper folder: `POST /pinning/pinFileToIPFS` accepts many parts, but every part
// name must share one root directory — otherwise the API answers "More than one file and/or
// directory was provided for pinning." Each part is therefore sent as `site/<path>`, and the
// CID that comes back is the CID of that `site` directory. The wrapper name never appears in
// a path, so `ipfs://<cid>/index.html` resolves at the root of the CID — which is exactly what
// an ENS contenthash needs.
//
// The last step is a gate, not a courtesy: it fetches the CID root back off gateways and
// fails the run when a gateway serves 200 without the app bootstrap. A CID that nests the
// site under a folder serves a directory listing at `ipfs://<cid>/`, which breaks eth.limo
// and every gateway, so the check runs before anyone pastes the CID into ENS.
//
// The gate only fails on positive evidence. 404 (propagation lag), 400 (gateway has never
// seen the CID), 429 and 5xx all mean "no answer", and are reported as unconfirmed.
//
// Required env: PINATA_JWT
// Optional env: PINATA_GATEWAY (dedicated gateway host, e.g. my-gw.mypinata.cloud)
//               PINATA_API_URL   (override for a local stub; defaults to api.pinata.cloud)
//               SKIP_VERIFY=1    (pin, but do not run the root check)

import { readdir, readFile } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const BUILD_DIR = 'build';
const WRAPPER = 'site';
const API = (process.env.PINATA_API_URL ?? 'https://api.pinata.cloud').replace(/\/+$/, '');
const JWT = process.env.PINATA_JWT;
const GATEWAY = process.env.PINATA_GATEWAY?.trim();
const SKIP_VERIFY = process.env.SKIP_VERIFY === '1';

function die(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

if (!JWT) {
  die(
    'Missing PINATA_JWT. Create a JWT at https://app.pinata.cloud (API Keys → New Key, ' +
      'Files: Write) and put it in .env as PINATA_JWT=…',
  );
}

if (!existsSync(join(BUILD_DIR, 'index.html'))) {
  die(`No ${BUILD_DIR}/index.html. Run \`bun run build\` first.`);
}

/**
 * Every file under `dir`, recursively, as build-relative POSIX paths.
 *
 * Dotfiles are included: `static/.well-known/` and `.nojekyll` are real site content and
 * dropping them would change what the deploy serves. Only OS/editor junk is skipped, and
 * a stray `.DS_Store` in `static/` is exactly the case that would otherwise be pinned.
 */
const JUNK: Record<string, true> = { '.DS_Store': true, 'Thumbs.db': true };
async function collect(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (JUNK[entry.name]) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collect(full)));
      continue;
    }
    out.push(relative(BUILD_DIR, full).split(sep).join('/'));
  }
  return out.sort();
}

const paths = await collect(BUILD_DIR);
if (paths.length === 0) die(`${BUILD_DIR}/ is empty.`);

const form = new FormData();
let bytes = 0;
for (const path of paths) {
  const data = await readFile(join(BUILD_DIR, path));
  bytes += data.byteLength;
  // Third argument is the multipart filename; Pinata reads the directory structure from it.
  form.append('file', new File([data], path), `${WRAPPER}/${path}`);
}
form.append('pinataMetadata', JSON.stringify({ name: 'safe-signer-onboarding' }));
// CIDv1 (`bafy…`) so the site is reachable from a subdomain gateway: `<cid>.ipfs.dweb.link`
// does not serve CIDv0. ENS contenthash accepts either.
form.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));

console.log(`Pinning ${paths.length} files (${(bytes / 1024).toFixed(1)} KB) to IPFS via Pinata…`);

const res = await fetch(`${API}/pinning/pinFileToIPFS`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${JWT}` },
  body: form,
}).catch((err: unknown) => {
  die(
    `Could not reach ${API}: ${err instanceof Error ? err.message : String(err)}\n` +
      '   Check network access and PINATA_API_URL.',
  );
});

// A non-2xx carries Pinata's own reason in the body (expired JWT, missing scope, oversized
// upload). Surface it verbatim instead of just the status code.
if (!res.ok) {
  const body = await res.text().catch(() => '<no body>');
  die(`Pinata returned HTTP ${res.status}: ${body}`);
}

const pinned = (await res.json()) as { IpfsHash?: string; PinSize?: number };
const cid = pinned.IpfsHash;
if (!cid) die(`Pinata response had no IpfsHash: ${JSON.stringify(pinned)}`);

writeFileSync('.cid', `${cid}\n`);

/**
 * Paths to probe for structure, best first. Only CID-relative content is fetched, so a
 * path-style gateway is fine here: this asks "is the site at the CID root?", not "does a
 * browser resolve the app?".
 */
function probeBases(id: string): string[] {
  const urls: string[] = [];
  if (GATEWAY) {
    const host = GATEWAY.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const scheme = /^https?:\/\//.test(GATEWAY) ? GATEWAY.slice(0, GATEWAY.indexOf(':') + 1) : 'https:';
    urls.push(`${scheme}//${host}/ipfs/${id}/`);
  }
  urls.push(`https://gateway.pinata.cloud/ipfs/${id}/`);
  urls.push(`https://${id}.ipfs.dweb.link/`);
  urls.push(`https://ipfs.io/ipfs/${id}/`);
  return urls;
}

/**
 * A probe answers one of three things:
 *   'ok'      — root HTML bootstraps the app and a root asset resolves
 *   'nested'  — the gateway answered **200 at the CID root** but served no app bootstrap.
 *               That is what a directory listing looks like, and it is the only signature
 *               that actually proves the site is not at the root.
 *   'silent'  — anything else. A 404 is propagation lag, not nesting; a 400/403/410/429/5xx
 *               is gateway policy (`gateway.pinata.cloud` answers 400 for a CID it has never
 *               seen). None of those are evidence about the pin, so only 'nested' fails it.
 */
async function probe(base: string): Promise<{ verdict: 'ok' | 'nested' | 'silent'; detail: string }> {
  const deadline = AbortSignal.timeout(20_000);
  try {
    const page = await fetch(base, { signal: deadline });
    if (page.status !== 200) return { verdict: 'silent', detail: `HTTP ${page.status} at ${base}` };
    if (!(await page.text()).includes('/_app/immutable/')) {
      return { verdict: 'nested', detail: `${base} answered 200 without the app bootstrap — the site is not at the CID root` };
    }
    const asset = await fetch(new URL('_app/version.json', base), { signal: deadline });
    if (asset.status !== 200) return { verdict: 'silent', detail: `HTTP ${asset.status} for _app/version.json` };
    return { verdict: 'ok', detail: base };
  } catch (err) {
    return { verdict: 'silent', detail: err instanceof Error ? err.message : String(err) };
  }
}

// The build is an SPA fallback, so its asset references are root-absolute (`/_app/…`).
// Behind ENS (a domain root) and on per-CID subdomain gateways that resolves; behind a
// path-style gateway it resolves to the gateway's own root and 404s. Both URLs are worth
// printing, but only one renders the app, and saying so here is cheaper than a debugging
// session later.
//
// Only a real HTTPS gateway can be turned into a per-CID subdomain: `http://127.0.0.1:45871`
// has no `*.ipfs.<host>` form, so a local or scheme-less override falls back to the public one.
const dedicatedHost = GATEWAY?.match(/^https:\/\/([^/]+)\/?$/)?.[1];
const subdomainPreview = `https://${cid}.ipfs.${dedicatedHost ?? 'dweb.link'}/`;

console.log(`\n✅ Pinned ${((pinned.PinSize ?? bytes) / 1024).toFixed(1)} KB. CID: ${cid}`);
console.log(`   (saved to .cid)\n`);

if (SKIP_VERIFY) {
  console.log(`Gate skipped (SKIP_VERIFY=1). Check it yourself before setting ENS: ${subdomainPreview}`);
} else {
  console.log('Checking that the site sits at the ROOT of the CID…');
  // Evidence, not first-answer: a single gateway can serve an odd listing while another
  // has the site. Keep every complaint, confirm on any one success, and only call the pin
  // broken when nobody confirms after the retries.
  const complaints: string[] = [];
  let confirmed = false;
  for (let attempt = 1; attempt <= 8 && !confirmed; attempt++) {
    for (const base of probeBases(cid)) {
      const { verdict, detail } = await probe(base);
      if (verdict === 'ok') {
        console.log(`   gate passed — ${base}`);
        confirmed = true;
        break;
      }
      if (verdict === 'nested') complaints.push(`${base}: ${detail}`);
    }
    if (!confirmed) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 5_000);
      await promise;
    }
  }
  if (!confirmed && complaints.length > 0) {
    die(
      `The CID does not serve this site at its root.\n` +
        [...new Set(complaints)].map((line) => `   ${line}`).join('\n') +
        '\n   The content IS pinned, but do NOT set the ENS contenthash: fix the pin first.',
    );
  }
  if (!confirmed) {
    // Not a failure of the pin — a failure to observe it. No gateway ever served the CID.
    console.warn(
      '\n⚠ Could not confirm the layout: no gateway served the CID within the retry window.\n' +
        '   That is a propagation or gateway problem, not evidence about the pin. Open the\n' +
        '   preview URL below and confirm index.html renders at the CID root before setting\n' +
        '   the ENS contenthash.',
    );
  }
}

console.log('\nPreview (renders the app — serve from a domain root):');
console.log(`   ${subdomainPreview}`);
console.log('\nOther gateways (structure only; the paths in the HTML are root-absolute,');
console.log('so a /ipfs/<cid>/ URL shows the gateway root, not this site):');
for (const base of probeBases(cid)) console.log(`   ${base}`);
console.log(`\nThen set the ENS contenthash to ipfs://${cid} in the ENS app (app.ens.domains).`);
