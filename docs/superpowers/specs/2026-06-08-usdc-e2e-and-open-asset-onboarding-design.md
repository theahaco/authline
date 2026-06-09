# USDC support, open-asset (CAP-73 `trust`) onboarding, and e2e testing

- **Date:** 2026-06-08
- **Status:** SUPERSEDED by
  `2026-06-09-onboard-router-runtime-discovery-design.md` — the two-path (open
  vs permissioned) client branching is replaced by a single router contract
  method with on-chain capability discovery. The e2e harness, testnet USDC
  registry entry, and env plumbing from this design survive.
- **Author:** Willem Wyndham (with Claude)
- **Branch:** `feat/usdc-open-asset-e2e`, based on `main` (the Authline SDK it
  builds on landed in `main` via #13 / #14)

## 1. Background

Authline (formerly `stellar_trustline`) is a Stellar/Soroban dApp + integrator
SDK (`@theaha/authline`) for establishing **authorized trustlines** with minimal
user friction. The dApp (`src/authline.tsx`) walks a user through
`directory → idle → ready → building → signing → submitting → success`, and the
SDK builds the underlying transactions.

Today the dApp's `activate()` is hard-wired to the **permissioned** CAP-73
one-signature path: `buildOnboardTx` invokes the
`onboard(sac, authorizer, holder)` wrapper contract, which requires an
`authorizer` contract. The SDK explicitly throws for open assets:

> "config.sac and config.authorizer are required for the one-signature CAP-73
> path (regulated / AUTH_REQUIRED assets). An open asset has no authorizer — use
> buildSponsoredOnboardTx instead."

**USDC is an open (non-`AUTH_REQUIRED`) asset.** So "using USDC" through the
dApp is not currently possible. There is also **no frontend test
infrastructure** — CI's `npm test --if-present` is a no-op; no
Vitest/Playwright/Jest exists.

### Current state of "the asset list"

- `packages/authline-sdk/src/registry.ts` → `OFFICIAL_ASSETS` already pins
  **mainnet USDC** (issuer
  `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`, SAC
  `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`,
  `capability: "open"`).
- The registry has **PUBLIC-only** entries — **no TESTNET USDC**.
- The UI directory (`src/config.ts` → `ASSETS`) shows USDC only as a **"soon"**
  roadmap tile. The "live" tile is whatever `PUBLIC_ASSET_CODE` resolves to
  (default `EURCV`).

## 2. Goals

1. Add **testnet USDC** (Circle, issuer
   `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`) to the pinned
   registry.
2. Make **USDC the live, activatable asset on testnet** (mainnet production
   stays **EURCV** — unchanged).
3. Teach the dApp to onboard **open assets via CAP-73 `SAC.trust(holder)`** (the
   "new trust API") — one holder signature, no authorizer, reusing the existing
   Soroban-RPC submit path.
4. Stand up **e2e testing** at two layers, both exercising the same `trust`
   path:
   - **Node/SDK e2e on real testnet** — create a real USDC trustline via the
     SDK.
   - **Playwright browser e2e on real testnet** — drive the real dApp UI with an
     injected (no-extension) keypair signer.
5. Add modest **unit tests** for the new/registry/config logic.

## 3. Non-goals

- Minting/receiving Circle's testnet USDC (we don't control the issuer; the e2e
  proves an _authorized trustline exists_, which is the meaningful result for an
  open asset).
- **Flipping the mainnet production default to USDC** — mainnet stays EURCV.
  Only the testnet env makes USDC the live asset.
- Multiple simultaneous "live" tiles — we keep the single-asset-per-deployment
  model; on testnet USDC is the live tile and EURC/EURCV/BENJI remain "soon".
- Changing the permissioned (EURCV) onboarding path — it stays exactly as is.
- Offline/mocked Playwright — the browser layer runs against real testnet by
  choice (CAP-73 `simulateTransaction` responses are too brittle to fake).

## 4. Decisions (resolved during brainstorming)

| Decision                        | Choice                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Open-asset onboarding mechanism | **CAP-73 `SAC.trust(holder)`** via Soroban RPC (not classic `ChangeTrust`)                             |
| Where USDC is live              | **Testnet only** (mainnet production stays EURCV; USDC-live is driven by the testnet env)              |
| Browser e2e fidelity            | **Real testnet**, injected funded keypair (no brittle mocks)                                           |
| e2e in CI                       | Unit tests gate PRs; **testnet e2e is opt-in** (separate job / `workflow_dispatch`, network-dependent) |

## 5. Design

### 5.1 SDK — new builder `buildTrustTx` (`packages/authline-sdk/src/onboard.ts`)

A sibling of `buildOnboardTx`, for the **open** path:

```ts
export interface BuildTrustOptions {
	rpcUrl: string
	networkPassphrase: string
	/** The holder (G…), who signs the single resulting transaction. */
	holder: string
	/** Resolved config; must include `sac`. `authorizer`/`onboard` not required. */
	config: OnboarderConfig
	allowHttp?: boolean
}

export async function buildTrustTx(opts: BuildTrustOptions): Promise<string> {
	if (!opts.config.sac)
		throw new Error("config.sac is required for the CAP-73 trust path")
	const server = new rpc.Server(opts.rpcUrl, {
		allowHttp: opts.allowHttp ?? defaultAllowHttp(opts.rpcUrl),
	})
	const source = await server.getAccount(opts.holder)
	const sac = new Contract(opts.config.sac)
	// SAC `trust(to: Address)` — confirmed single-arg from trustline-onboard's
	// `StellarAssetClient::try_trust(&holder)`. For a non-AUTH_REQUIRED asset the
	// resulting trustline is immediately authorized.
	const op = sac.call("trust", new Address(opts.holder).toScVal())
	const tx = new TransactionBuilder(source, {
		fee: BASE_FEE,
		networkPassphrase: opts.networkPassphrase,
	})
		.addOperation(op)
		.setTimeout(180)
		.build()
	const prepared = await server.prepareTransaction(tx)
	return prepared.toXDR()
}
```

- Exported from `packages/authline-sdk/src/index.ts`.
- **ABI note (verify during implementation):** the exact `trust` entrypoint
  arity/param names must be confirmed against the deployed SAC. The in-repo
  `trustline-onboard` contract calls `sac_client.try_trust(&holder)` (one
  `Address` arg), which is authoritative for the SAC interface we target.

### 5.2 Registry — add testnet USDC (`packages/authline-sdk/src/registry.ts`)

Append a `TESTNET` entry to `OFFICIAL_ASSETS`:

```ts
{
  code: "USDC",
  issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  sac: "<computed via Asset('USDC', issuer).contractId(Networks.TESTNET); deployed + verified on-chain>",
  capability: "open",
  name: "USD Coin",
  network: "TESTNET",
  homeDomain: "circle.com",
  authRevocable: false,   // confirm against testnet issuer flags during impl
  authClawback: false,
  verifiedAt: "2026-06-08",
}
```

- The `sac` is the **deterministic** SAC id, **deployed on testnet** by the
  setup helper (§5.5) and **verified** to exist on-chain before pinning. (Add a
  short code comment that testnet SACs are derived+deployed rather than
  independently audited like mainnet.)
- `validateOfficialAsset` already enforces a valid C-address; the derived id
  passes.
- `resolveOfficialAsset("USDC", "TESTNET")` then returns this entry, so config
  and `reconcileWithRegistry` work on testnet.

### 5.3 Config — USDC live on testnet, env-driven (`src/config.ts` — no code change)

Mainnet stays EURCV, so **`config.ts` needs no code change** and the committed
mainnet `.env` is untouched. `config.ts` already resolves the live asset by
`(code, network)` against the registry, so once §5.2 adds the testnet USDC
entry, USDC-live on testnet is driven **entirely by the testnet env**:

- Testnet env (`.env.e2e` / the e2e build env — see §6): set
  `PUBLIC_ASSET_CODE=USDC` + testnet `PUBLIC_STELLAR_*`
  (RPC/Horizon/passphrase).
- `config.ts` then computes `resolveOfficialAsset("USDC", "TESTNET")` → the new
  entry, so `ASSET` becomes testnet USDC (`capability: "open"`, no `authorizer`,
  `sac` from the pinned entry), and the directory lists USDC as the live tile
  with EURC/EURCV/BENJI as "soon" (USDC deduped from the roadmap by existing
  logic).
- Mainnet (committed `.env`, no `PUBLIC_ASSET_CODE`) → `CODE` defaults to
  `EURCV` exactly as today. The deployed production site is unchanged.
- The existing `permissionedOneStep` misconfiguration warning is unaffected
  (USDC is open, so it won't trigger).

### 5.4 dApp — branch `activate()` on capability (`src/authline.tsx`)

Minimal change — pick the builder; **reuse the existing sign → RPC
`sendTransaction` → 180s poll path unchanged**:

```ts
const xdr =
	ASSET.capability === "open" || !ASSET.authorizer
		? await buildTrustTx({
				rpcUrl,
				networkPassphrase,
				holder: address,
				config: ASSET,
				allowHttp,
			})
		: await buildOnboardTx({
				rpcUrl,
				networkPassphrase,
				holder: address,
				config: ASSET,
				allowHttp,
			})
```

- `getActivationStatus`, the "already authorized", "preview", success, and error
  screens already work for open assets (an open trustline reports
  `is_authorized: true`). No copy/flow changes required beyond the builder
  branch.

### 5.5 Testnet USDC SAC deployment helper (`scripts/`)

CAP-73 `trust()` is a real contract call, so the SAC must exist on-chain.

- New idempotent script (e.g. `scripts/deploy-testnet-usdc-sac.sh` or a small
  `.mjs`): compute the deterministic SAC id for testnet USDC; if it is not yet
  deployed, deploy it
  (`stellar contract asset deploy --asset USDC:<issuer> --network testnet --source <funded>`);
  print + verify the id.
- Output id is what gets pinned in §5.2. The Node testnet e2e runs/asserts this
  before attempting `trust`.
- Mainnet USDC SAC is already pinned and deployed — no action.

### 5.6 dApp test seam for the injected wallet (`src/authline.tsx`)

To drive the real dApp in a browser without a wallet extension:

- Add a tiny indirection over the two wallet calls used in the flow
  (`getAddress`, `signTransaction`). If `window.__AUTHLINE_E2E__` is present,
  use it instead of the `StellarWalletsKit` (`kit`). Shape:
  `{ address: string, signTransaction(xdr): Promise<{ signedTxXdr: string }> }`.
- In E2E mode the "Connect wallet" action resolves the injected address directly
  (modal can be skipped). The injected signer's secret **stays in Node**
  (Playwright side) — see §6.3.
- This is the only test-affordance added to production code; it is inert unless
  the `window` hook is set.

## 6. Testing strategy

### 6.1 Tooling (new)

- Add dev deps: **`vitest`** (unit + node testnet e2e) and
  **`@playwright/test`** (browser e2e).
- Config: `vitest.config.ts` (reuse Vite plugins where helpful);
  `playwright.config.ts` with a `webServer` that runs `vite preview` and a
  `baseURL` pointing at `app.html`.
- Scripts in root `package.json`:
  - `test` → `vitest run` (unit only; fast, no network) — **PR gate**.
  - `test:e2e` → `playwright test` (real testnet) — **opt-in**.
  - `test:e2e:testnet` → `vitest run tests/e2e` with `RUN_TESTNET_E2E=1` —
    **opt-in**.

### 6.2 Layer A — unit tests (Vitest, mocked, fast)

- `registry.test.ts`: testnet USDC resolves via
  `resolveOfficialAsset("USDC", "TESTNET")`; mainnet USDC unchanged; every
  `OFFICIAL_ASSETS` entry passes `validateOfficialAsset`;
  `reconcileWithRegistry` **throws** on a spoofed issuer/SAC for a curated code.
- `config.test.ts`: with `PUBLIC_ASSET_CODE` unset + testnet passphrase (stub
  `import.meta.env` via `vi.stubEnv`), `ASSET` resolves to USDC,
  `capability: "open"`, no `authorizer`; directory has USDC as the single live
  tile.
- `buildTrustTx.test.ts`: with a stubbed `rpc.Server` (mock `getAccount` +
  `prepareTransaction`), the built tx contains exactly one operation invoking
  `trust` on the configured SAC with the holder address.

### 6.3 Layer B — Playwright browser e2e on real testnet (opt-in)

- `playwright.config.ts`: `webServer` builds + serves the app (`vite preview`);
  single chromium project; generous timeouts (real network).
- `tests/e2e/setup` (global setup): generate a fresh testnet `Keypair`, fund via
  friendbot (`https://friendbot.stellar.org/?addr=`), ensure the testnet USDC
  SAC is deployed (§5.5). Export the public key + a Node-side signer.
- `tests/e2e/usdc-activation.spec.ts`:
  - `page.exposeFunction("__authlineSign", xdr => signWithKeypair(xdr))` —
    signing happens in **Node** with the secret key (never shipped to the page).
  - `page.addInitScript` sets
    `window.__AUTHLINE_E2E__ = { address, signTransaction: xdr => window.__authlineSign(xdr) }`.
  - Navigate to `app.html`, pick USDC from the directory, Connect, click
    `Activate USDC · 1 signature`, and assert the UI reaches **success** with a
    `USDC trustline authorized` heading and a tx hash link.
  - A second assertion (re-run / revisit) hits the **"already authorized"**
    path.
- Because each run funds a fresh keypair, the create-flow is exercised cleanly;
  the trustline is real and visible on stellar.expert.

### 6.4 Layer C — Node/SDK e2e on real testnet (opt-in)

- `tests/e2e/testnet-usdc.e2e.test.ts` (Vitest, guarded by `RUN_TESTNET_E2E=1`,
  long timeout):
  - Ensure testnet USDC SAC deployed (§5.5).
  - Generate + friendbot-fund a holder `Keypair`.
  - `buildTrustTx({ rpcUrl, networkPassphrase, holder, config: <testnet USDC> })`.
  - Sign with the holder keypair; submit via `rpc.Server.sendTransaction`; poll
    `getTransaction` to `SUCCESS`.
  - Assert `getActivationStatus` → `{ hasTrustline: true, isAuthorized: true }`.
- This uses the **identical** `buildTrustTx` + RPC submit path as the dApp, so
  it is the on-chain truth backstop for the browser layer.

### 6.5 CI (`.github/workflows/build.yml`)

- Add `npm test` (Vitest unit) to the existing PR pipeline (first real test
  gate).
- Add a **separate, non-blocking** job/workflow (`workflow_dispatch` and/or
  scheduled) for `test:e2e` + `test:e2e:testnet` so testnet flakiness never
  blocks PRs. Document this in the workflow.

## 7. File-by-file change summary

**SDK (`packages/authline-sdk/`)**

- `src/onboard.ts` — add `buildTrustTx` + `BuildTrustOptions`.
- `src/index.ts` — export `buildTrustTx`.
- `src/registry.ts` — add testnet USDC `OfficialAsset`.
- `src/*.test.ts` — unit tests (registry, builder).

**Frontend (`src/`)**

- `config.ts` — **no code change** (USDC-live is testnet-env-driven; mainnet
  stays EURCV). A `config.test.ts` still pins the resolution behavior.
- `authline.tsx` — capability branch in `activate()`; `window.__AUTHLINE_E2E__`
  wallet seam.

**Infra / scripts / CI**

- `scripts/deploy-testnet-usdc-sac.*` — idempotent SAC deploy/verify helper.
- `vitest.config.ts`, `playwright.config.ts` — new.
- `tests/e2e/` — global setup, `usdc-activation.spec.ts`,
  `testnet-usdc.e2e.test.ts`.
- `package.json` — `vitest`, `@playwright/test` dev deps; `test`, `test:e2e`,
  `test:e2e:testnet` scripts.
- `.github/workflows/build.yml` — add unit-test gate; add opt-in e2e job.
- `.env.e2e` (new) — testnet + `PUBLIC_ASSET_CODE=USDC` for dev/e2e. The
  committed mainnet `.env` and the Pages deploy env are **unchanged** (stay
  EURCV).

## 8. Risks & verification

- **SAC `trust` ABI**: confirm arity/param names against the deployed SAC before
  finalizing `buildTrustTx` (authoritative reference: `try_trust(&holder)` in
  `contracts/trustline-onboard/src/lib.rs`).
- **Protocol 26 on testnet**: CAP-73 `trust()` requires Protocol 26. Verify
  testnet is on ≥26 (mainnet EURCV entry is `verifiedAt: 2026-06-04`, so mainnet
  is live).
- **`@stellar/stellar-sdk` v14**: building a generic `Contract.call("trust", …)`
  is version-agnostic; verify simulate/submit succeed against testnet.
- **Mainnet unchanged**: the production live asset stays EURCV; no mainnet
  behavior change ships. (Activating USDC on mainnet via `trust` is a possible
  future follow-up — see §9 — and would require verifying the mainnet USDC SAC
  `CCW67…MI75` supports self-onboarding `trust`.)
- **Testnet flakiness**: friendbot + testnet resets can break e2e — hence
  opt-in, fresh keypair per run, non-blocking CI.
- **Testnet issuer flags**: confirm Circle testnet USDC
  `auth_revocable`/`clawback` flags via Horizon and set the registry entry
  truthfully.

## 9. Out of scope / follow-ups

- Making USDC the **mainnet** live asset (would require verifying the mainnet
  USDC SAC supports self-onboarding `trust`; the open-asset code path added here
  makes it a config-only change later).
- Receiving real testnet USDC into the trustline.
- Reworking the directory to show multiple live assets at once.
- Offline/mocked Playwright fixtures.
