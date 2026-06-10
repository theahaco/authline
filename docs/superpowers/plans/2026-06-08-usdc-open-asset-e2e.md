# USDC Open-Asset (CAP-73 `trust`) Onboarding + E2E Tests — Implementation Plan

> **Status:** SUPERSEDED by
> `docs/superpowers/plans/2026-06-09-onboard-router-runtime-discovery.md` —
> `buildTrustTx` and client-side `ASSET.capability` branching were replaced by
> the single 2-arg router `onboard(sac, holder)` with on-chain capability
> discovery. Retained as history; the e2e harness / registry / env work it
> describes survives.

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Authline dApp onboard the open asset USDC via CAP-73
`SAC.trust(holder)`, add testnet USDC to the pinned registry, and stand up
Vitest unit tests plus two real-testnet e2e layers (Node/SDK + Playwright).

**Architecture:** A new SDK builder `buildTrustTx` issues a one-signature
`SAC.trust(holder)` Soroban transaction for open assets (no authorizer), reusing
the dApp's existing RPC submit/poll path. `activate()` branches on
`ASSET.capability`. USDC-live on testnet is driven entirely by a new `.env.e2e`
(mainnet stays EURCV — no `config.ts` change). Tests: Vitest units (mocked, PR
gate) + opt-in real-testnet Node and Playwright e2e.

**Tech Stack:** TypeScript, React 19, Vite 7, `@stellar/stellar-sdk` 14.5.0,
`@creit.tech/stellar-wallets-kit`, Vitest, `@playwright/test`, Soroban testnet,
`stellar` CLI.

**Spec:**
`docs/superpowers/specs/2026-06-08-usdc-e2e-and-open-asset-onboarding-design.md`

**Concrete values determined during planning (validated):**

- Testnet USDC issuer:
  `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`
- Testnet USDC SAC: `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`
  (`Asset(...).contractId(TESTNET)`; method validated — the same derivation
  reproduces the pinned **mainnet** SAC exactly)
- Testnet USDC issuer flags (Horizon): `auth_required:false`,
  `auth_revocable:true`, `auth_clawback_enabled:false`, `home_domain:centre.io`

**Commit convention:** Every commit message ends with the trailer (omitted from
the `-m` snippets below for brevity — add it each time):

```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

Husky + lint-staged auto-runs `eslint --fix` + `prettier` on commit; let it
reformat.

---

## File Structure

**Create:**

- `vitest.config.ts` — Vitest config; aliases `@theaha/authline` → its TS source
  so unit tests need no SDK build.
- `playwright.config.ts` — Playwright config; `webServer` builds the e2e
  (testnet/USDC) bundle and serves it.
- `.env.e2e` — testnet network + `PUBLIC_ASSET_CODE=USDC` +
  `PUBLIC_ASSET_ISSUER` (+ `PUBLIC_SAC`). Drives USDC-live for dev/e2e only.
- `packages/authline-sdk/src/registry.test.ts` — registry unit tests.
- `packages/authline-sdk/src/onboard.test.ts` — `buildTrustTx` unit tests.
- `src/config.test.ts` — config resolution unit test.
- `scripts/deploy-testnet-usdc-sac.mjs` — idempotent testnet USDC SAC
  deploy/verify helper.
- `tests/e2e/testnet-usdc.e2e.test.ts` — Node/SDK real-testnet e2e (Vitest,
  opt-in).
- `tests/e2e/usdc-activation.spec.ts` — Playwright browser real-testnet e2e
  (opt-in).

**Modify:**

- `packages/authline-sdk/src/onboard.ts` — add `buildTrustTx` +
  `BuildTrustOptions`.
- `packages/authline-sdk/src/index.ts` — export `buildTrustTx`.
- `packages/authline-sdk/src/registry.ts` — add the testnet USDC
  `OfficialAsset`.
- `packages/authline-sdk/tsconfig.json` — exclude `*.test.ts` from the build.
- `src/authline.tsx` — import `buildTrustTx`; capability branch in `activate()`;
  `window.__AUTHLINE_E2E__` wallet seam.
- `tsconfig.app.json` — exclude `src/**/*.test.ts` from the production build.
- `eslint.config.js` — node globals for tests/scripts/config files.
- `package.json` — `vitest` + `@playwright/test` devDeps; `test`, `test:e2e`,
  `test:e2e:testnet`, `build:e2e` scripts.
- `.gitignore` — ignore Playwright/Vitest output + e2e auth artifacts.
- `.github/workflows/build.yml` — add the unit-test gate; add an opt-in e2e job.

---

## Task 1: Vitest tooling + smoke test

**Files:**

- Create: `vitest.config.ts`
- Modify: `package.json`
- Modify: `eslint.config.js`
- Test: `packages/authline-sdk/src/registry.test.ts` (smoke only this task)

- [ ] **Step 1: Install Vitest**

Run: `npm install --save-dev vitest@^2` Expected: adds `vitest` to root
`devDependencies`, no peer errors.

- [ ] **Step 2: Create `vitest.config.ts`**

```ts
import { resolve } from "path"
import { defineConfig } from "vitest/config"

// Alias the workspace SDK to its TS source so unit tests run without a build.
// (Vite resolves the SDK's internal `./x.js` specifiers to the `.ts` sources.)
export default defineConfig({
	resolve: {
		alias: {
			"@theaha/authline": resolve(
				__dirname,
				"packages/authline-sdk/src/index.ts",
			),
		},
	},
	test: {
		environment: "node",
		include: ["src/**/*.test.ts", "packages/**/src/**/*.test.ts"],
		exclude: ["tests/e2e/**", "node_modules/**", "dist/**"],
	},
})
```

- [ ] **Step 3: Add the `test` script to `package.json`**

In the `"scripts"` block, add:

```json
"test": "vitest run",
```

- [ ] **Step 4: Add node globals for tests/scripts/configs in
      `eslint.config.js`**

Append a new config object to the exported array (after the existing
`{ files: ["**/*.{ts,tsx}"], ... }` block):

```js
	{
		files: [
			"**/*.test.ts",
			"tests/**/*.{ts,tsx}",
			"scripts/**/*.mjs",
			"vitest.config.ts",
			"playwright.config.ts",
		],
		languageOptions: {
			globals: { ...globals.node },
		},
	},
```

- [ ] **Step 5: Write a smoke test**
      (`packages/authline-sdk/src/registry.test.ts`)

```ts
import { describe, expect, it } from "vitest"
import { OFFICIAL_ASSETS } from "./registry.js"

describe("registry smoke", () => {
	it("exposes the pinned assets array", () => {
		expect(Array.isArray(OFFICIAL_ASSETS)).toBe(true)
		expect(OFFICIAL_ASSETS.length).toBeGreaterThan(0)
	})
})
```

- [ ] **Step 6: Run the smoke test**

Run: `npm test` Expected: PASS (1 file, 1 test). Confirms the runner +
SDK-source alias resolve correctly.

- [ ] **Step 7: Verify lint still passes**

Run: `npm run lint` Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add vitest.config.ts package.json package-lock.json eslint.config.js packages/authline-sdk/src/registry.test.ts
git commit -m "test: add Vitest tooling + registry smoke test"
```

---

## Task 2: Add testnet USDC to the pinned registry (TDD)

**Files:**

- Modify: `packages/authline-sdk/src/registry.ts:50-88` (the `OFFICIAL_ASSETS`
  array)
- Modify: `packages/authline-sdk/tsconfig.json`
- Test: `packages/authline-sdk/src/registry.test.ts`

- [ ] **Step 1: Replace the smoke test with real registry tests**

Overwrite `packages/authline-sdk/src/registry.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import {
	OFFICIAL_ASSETS,
	reconcileWithRegistry,
	resolveOfficialAsset,
	validateOfficialAsset,
} from "./registry.js"

const TESTNET_USDC_ISSUER =
	"GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
const TESTNET_USDC_SAC =
	"CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
const MAINNET_USDC_ISSUER =
	"GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"

describe("registry", () => {
	it("every pinned entry is valid", () => {
		expect(() => OFFICIAL_ASSETS.forEach(validateOfficialAsset)).not.toThrow()
	})

	it("resolves testnet USDC by (code, network) as an open asset", () => {
		const a = resolveOfficialAsset("USDC", "TESTNET")
		expect(a).not.toBeNull()
		expect(a?.issuer).toBe(TESTNET_USDC_ISSUER)
		expect(a?.sac).toBe(TESTNET_USDC_SAC)
		expect(a?.capability).toBe("open")
		expect(a?.authorizer).toBeUndefined()
	})

	it("keeps mainnet USDC distinct from testnet USDC", () => {
		expect(resolveOfficialAsset("USDC", "PUBLIC")?.issuer).toBe(
			MAINNET_USDC_ISSUER,
		)
	})

	it("rejects a spoofed issuer for a curated testnet code", () => {
		expect(() =>
			reconcileWithRegistry(
				{
					assetCode: "USDC",
					assetIssuer: MAINNET_USDC_ISSUER, // wrong issuer for TESTNET
					sac: TESTNET_USDC_SAC,
				},
				"TESTNET",
			),
		).toThrow(/does not match the pinned value/)
	})
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- registry` Expected: FAIL —
`resolveOfficialAsset("USDC", "TESTNET")` returns `null` (no testnet entry yet).

- [ ] **Step 3: Add the testnet USDC entry to `OFFICIAL_ASSETS`**

In `packages/authline-sdk/src/registry.ts`, append this object inside the
`OFFICIAL_ASSETS` array (after the `EURCV` entry, before the closing `]` on line
88):

```ts
	{
		// Testnet entry: issuer + flags verified via Horizon (2026-06-08); the SAC
		// is the deterministic `Asset.contractId(TESTNET)` id (same derivation that
		// reproduces every pinned mainnet SAC), deployed on testnet. Testnet has no
		// scam-issuer risk, so a derived+deployed SAC is acceptable here.
		code: "USDC",
		issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
		sac: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
		capability: "open",
		name: "USD Coin",
		network: "TESTNET",
		homeDomain: "centre.io",
		authRevocable: true,
		authClawback: false,
		verifiedAt: "2026-06-08",
	},
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- registry` Expected: PASS (4 tests).

- [ ] **Step 5: Exclude test files from the SDK build**

In `packages/authline-sdk/tsconfig.json`, add an `exclude` key after
`"include": ["src"]`:

```json
	"include": ["src"],
	"exclude": ["src/**/*.test.ts"]
```

- [ ] **Step 6: Verify the SDK still builds cleanly (no test files emitted)**

Run:
`npm run build -w @theaha/authline && ls packages/authline-sdk/dist | grep -c "test" || echo "0 test files emitted"`
Expected: prints `0 test files emitted` (build succeeds; `dist` contains no
`*.test.*`).

- [ ] **Step 7: Commit**

```bash
git add packages/authline-sdk/src/registry.ts packages/authline-sdk/src/registry.test.ts packages/authline-sdk/tsconfig.json
git commit -m "feat(sdk): pin testnet USDC in the official asset registry"
```

---

## Task 3: SDK `buildTrustTx` for the open (CAP-73 `trust`) path (TDD)

**Files:**

- Modify: `packages/authline-sdk/src/onboard.ts` (add export at end of file)
- Modify: `packages/authline-sdk/src/index.ts:53`
- Test: `packages/authline-sdk/src/onboard.test.ts`

- [ ] **Step 1: Write the failing test**
      (`packages/authline-sdk/src/onboard.test.ts`)

```ts
import { Address, Networks, TransactionBuilder } from "@stellar/stellar-sdk"
import { afterEach, describe, expect, it, vi } from "vitest"

const HOLDER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
const SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"

// Mock only the RPC server; keep the real builders/codecs.
vi.mock("@stellar/stellar-sdk", async (importActual) => {
	const actual = await importActual<typeof import("@stellar/stellar-sdk")>()
	class FakeServer {
		async getAccount(id: string) {
			return new actual.Account(id, "0")
		}
		// Skip real simulation; the op is already on the tx.
		async prepareTransaction(tx: unknown) {
			return tx
		}
	}
	return { ...actual, rpc: { ...actual.rpc, Server: FakeServer } }
})

const opts = {
	rpcUrl: "https://soroban-testnet.stellar.org",
	networkPassphrase: Networks.TESTNET,
	holder: HOLDER,
	config: {
		assetCode: "USDC",
		assetIssuer: HOLDER,
		sac: SAC,
		authorizer: "",
		backends: [] as const,
	},
}

describe("buildTrustTx", () => {
	afterEach(() => vi.clearAllMocks())

	it("builds a single SAC.trust(holder) invocation", async () => {
		const { buildTrustTx } = await import("./onboard.js")
		const xdr = await buildTrustTx({ ...opts, allowHttp: false })
		const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET)
		expect(tx.operations).toHaveLength(1)
		const op = tx.operations[0] as { type: string; func: any }
		expect(op.type).toBe("invokeHostFunction")
		const call = op.func.invokeContract()
		expect(Address.fromScAddress(call.contractAddress()).toString()).toBe(SAC)
		expect(call.functionName().toString()).toBe("trust")
		expect(call.args()).toHaveLength(1)
		expect(Address.fromScVal(call.args()[0]).toString()).toBe(HOLDER)
	})

	it("throws when config.sac is missing", async () => {
		const { buildTrustTx } = await import("./onboard.js")
		await expect(
			buildTrustTx({ ...opts, config: { ...opts.config, sac: "" } }),
		).rejects.toThrow(/config.sac is required/)
	})
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- onboard` Expected: FAIL — `buildTrustTx` is not exported from
`./onboard.js`.

- [ ] **Step 3: Implement `buildTrustTx`**

In `packages/authline-sdk/src/onboard.ts`, append at the end of the file (the
`Address`, `BASE_FEE`, `Contract`, `TransactionBuilder`, `rpc` imports already
exist at the top):

```ts
export interface BuildTrustOptions {
	/** Soroban RPC URL. */
	rpcUrl: string
	/** Network passphrase (mainnet / testnet). */
	networkPassphrase: string
	/** The holder (G…), who signs the single resulting transaction. */
	holder: string
	/** Resolved config; must include `sac`. `authorizer`/`onboard` not required. */
	config: OnboarderConfig
	allowHttp?: boolean
}

/**
 * Build the **one-signature** CAP-73 trust transaction for an OPEN asset.
 * Invokes `SAC.trust(holder)` directly (no authorizer, no onboard wrapper):
 * for a non-`AUTH_REQUIRED` asset the trustline is created already authorized
 * under the holder's single signature. The returned base64 XDR is unsigned —
 * hand it to the wallet to sign, then submit via Soroban RPC.
 *
 * Like CAP-73 `trust()`, this has no sponsorship: the holder must control a
 * funded account that can cover the 0.5 XLM trustline reserve. For a regulated
 * (`AUTH_REQUIRED`) asset use {@link buildOnboardTx} instead.
 */
export async function buildTrustTx(opts: BuildTrustOptions): Promise<string> {
	if (!opts.config.sac) {
		throw new Error(
			"config.sac is required for the CAP-73 trust path (open asset)",
		)
	}
	const server = new rpc.Server(opts.rpcUrl, {
		allowHttp: opts.allowHttp ?? defaultAllowHttp(opts.rpcUrl),
	})
	const source = await server.getAccount(opts.holder)

	const sac = new Contract(opts.config.sac)
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

- [ ] **Step 4: Export it from the SDK entry**

In `packages/authline-sdk/src/index.ts`, change line 53 from:

```ts
export { buildOnboardTx, type BuildOnboardOptions } from "./onboard.js"
```

to:

```ts
export {
	buildOnboardTx,
	buildTrustTx,
	type BuildOnboardOptions,
	type BuildTrustOptions,
} from "./onboard.js"
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- onboard` Expected: PASS (2 tests).

- [ ] **Step 6: Build the SDK + typecheck**

Run: `npm run build -w @theaha/authline` Expected: succeeds (emits
`buildTrustTx` into `dist`).

- [ ] **Step 7: Commit**

```bash
git add packages/authline-sdk/src/onboard.ts packages/authline-sdk/src/index.ts packages/authline-sdk/src/onboard.test.ts
git commit -m "feat(sdk): add buildTrustTx — one-signature CAP-73 SAC.trust for open assets"
```

---

## Task 4: Config resolution unit test (no `config.ts` change)

**Files:**

- Test: `src/config.test.ts`

> `config.ts` needs no change. This test pins the resolution behavior the
> `.env.e2e` (Task 9) relies on: with `PUBLIC_ASSET_CODE=USDC` + testnet
> passphrase + `PUBLIC_ASSET_ISSUER` set (the issuer fallback is a hardcoded
> EURCV value, so it MUST be provided), `ASSET` resolves to open USDC and the
> directory marks USDC live. The SAC is left unset to prove it falls back to the
> pinned testnet registry value.

- [ ] **Step 1: Write the test** (`src/config.test.ts`)

```ts
import { beforeEach, describe, expect, it, vi } from "vitest"

const TESTNET_USDC_ISSUER =
	"GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
const TESTNET_USDC_SAC =
	"CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"

describe("config — testnet USDC (env-driven)", () => {
	beforeEach(() => {
		vi.resetModules()
		vi.unstubAllEnvs()
	})

	it("resolves USDC as the live, open asset on testnet", async () => {
		vi.stubEnv("PUBLIC_ASSET_CODE", "USDC")
		vi.stubEnv("PUBLIC_ASSET_ISSUER", TESTNET_USDC_ISSUER)
		vi.stubEnv(
			"PUBLIC_STELLAR_NETWORK_PASSPHRASE",
			"Test SDF Network ; September 2015",
		)
		// PUBLIC_SAC intentionally unset — must fall back to the pinned registry SAC.

		const { ASSET, ASSETS } = await import("./config")

		expect(ASSET.assetCode).toBe("USDC")
		expect(ASSET.assetIssuer).toBe(TESTNET_USDC_ISSUER)
		expect(ASSET.sac).toBe(TESTNET_USDC_SAC) // from the pinned registry entry
		expect(ASSET.capability).toBe("open")
		expect(ASSET.authorizer).toBe("")
		expect(ASSETS[0]).toMatchObject({ code: "USDC", status: "live" })
	})
})
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npm test -- config` Expected: PASS. (Depends on Task 2's registry entry;
uses the SDK-source alias.)

- [ ] **Step 3: Commit**

```bash
git add src/config.test.ts
git commit -m "test(app): pin testnet USDC config resolution"
```

---

## Task 5: dApp — open-asset `activate()` branch + e2e wallet seam

**Files:**

- Modify: `src/authline.tsx:12-16` (imports), `:55-59` (after kit init),
  `:781-799` (`connect`), `:816-859` (`activate`), `:900` (Connect button)
- Verify: `npm run typecheck`, `npm run build`

> No unit test here — this is React wiring verified by typecheck/build now and
> by the Playwright e2e (Task 9). Keep the diff minimal.

- [ ] **Step 1: Import `buildTrustTx`**

In `src/authline.tsx`, change the `@theaha/authline` import (lines 12-16) to add
`buildTrustTx`:

```ts
import {
	buildOnboardTx,
	buildTrustTx,
	getActivationStatus,
	isValidIssuer,
} from "@theaha/authline"
```

- [ ] **Step 2: Add the e2e signer seam + `signTx` helper**

In `src/authline.tsx`, immediately after the `kit` constant (after line 59),
add:

```ts
/**
 * Optional test seam: an injected signer used by the e2e browser tests so the
 * real dApp can run without a wallet extension. Inert in production (the
 * `window` hook is never set there).
 */
interface E2ESigner {
	address: string
	signTransaction(xdr: string): Promise<{ signedTxXdr: string }>
}
const e2eSigner = (): E2ESigner | undefined =>
	typeof window !== "undefined"
		? (window as unknown as { __AUTHLINE_E2E__?: E2ESigner }).__AUTHLINE_E2E__
		: undefined

/** Sign via the injected e2e signer when present, otherwise the wallet kit. */
async function signTx(xdr: string, address: string): Promise<string> {
	const e2e = e2eSigner()
	if (e2e) return (await e2e.signTransaction(xdr)).signedTxXdr
	const { signedTxXdr } = await kit.signTransaction(xdr, {
		networkPassphrase: NETWORK.passphrase,
		address,
	})
	return signedTxXdr
}
```

- [ ] **Step 3: Branch `connect()` on the e2e signer**

In `src/authline.tsx`, replace the body start of `connect` (lines 782-786) — the
`try { kit.setWallet(id) … setAddress(addr)` part — so it reads:

```ts
const connect = useCallback(async (id: string) => {
	try {
		const e2e = e2eSigner()
		let addr: string
		if (e2e) {
			addr = e2e.address
		} else {
			kit.setWallet(id)
			addr = (await kit.getAddress()).address
		}
		setShowModal(false)
		setAddress(addr)
		const st = await getActivationStatus({
			horizonUrl: NETWORK.horizonUrl,
			account: addr,
			assetCode: ASSET.assetCode,
			assetIssuer: ASSET.assetIssuer,
		})
		setPhase(st.isAuthorized ? "already" : "ready")
	} catch (e) {
		setShowModal(false)
		setErrMsg(e instanceof Error ? e.message : String(e))
		setPhase("error")
	}
}, [])
```

- [ ] **Step 4: Branch the builder + use `signTx` in `activate()`**

In `src/authline.tsx`, replace the `buildOnboardTx` call (lines 820-826) with
the capability branch:

```ts
const xdr =
	ASSET.capability === "open" || !ASSET.authorizer
		? await buildTrustTx({
				rpcUrl: NETWORK.rpcUrl,
				networkPassphrase: NETWORK.passphrase,
				holder: address,
				config: ASSET,
				allowHttp: NETWORK.allowHttp,
			})
		: await buildOnboardTx({
				rpcUrl: NETWORK.rpcUrl,
				networkPassphrase: NETWORK.passphrase,
				holder: address,
				config: ASSET,
				allowHttp: NETWORK.allowHttp,
			})
```

Then replace the signing line (lines 828-831):

```ts
const { signedTxXdr } = await kit.signTransaction(xdr, {
	networkPassphrase: NETWORK.passphrase,
	address,
})
```

with:

```ts
const signedTxXdr = await signTx(xdr, address)
```

- [ ] **Step 5: Let the Connect button skip the modal under e2e**

In `src/authline.tsx`, change the idle-phase Connect button (line 900) from:

```ts
				<Primary onClick={() => setShowModal(true)}>
```

to:

```ts
				<Primary
					onClick={() => (e2eSigner() ? connect("e2e") : setShowModal(true))}
				>
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck` Expected: no errors.

- [ ] **Step 7: Build**

Run: `npm run build` Expected: succeeds.

- [ ] **Step 8: Commit**

```bash
git add src/authline.tsx
git commit -m "feat(app): onboard open assets via buildTrustTx; add e2e wallet seam"
```

---

## Task 6: Testnet USDC SAC deploy/verify helper

**Files:**

- Create: `scripts/deploy-testnet-usdc-sac.mjs`
- Modify: `package.json` (script)

> CAP-73 `trust()` is a real contract call, so the SAC must exist on-chain. This
> idempotent helper computes the deterministic id, verifies it equals the pinned
> value, deploys it via the `stellar` CLI if absent, and tolerates an
> already-deployed SAC. It mirrors the style of
> `examples/exchange-withdrawal/*.mjs`.

- [ ] **Step 1: Write the helper** (`scripts/deploy-testnet-usdc-sac.mjs`)

```js
/**
 * Idempotently ensure the testnet USDC Stellar Asset Contract (SAC) exists, so
 * the CAP-73 `SAC.trust(holder)` path can run on testnet.
 *
 * Requires the `stellar` CLI on PATH. A funded source is needed only if the SAC
 * is not yet deployed: pass SOURCE_SECRET=S... (a funded testnet secret), or the
 * script generates + friendbot-funds an ephemeral one.
 *
 * Run from the repo root:  node scripts/deploy-testnet-usdc-sac.mjs
 */
import { spawnSync } from "node:child_process"
import { Asset, Keypair, Networks, StrKey } from "@stellar/stellar-sdk"

const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
const EXPECTED_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
const ASSET_ARG = `USDC:${ISSUER}`

function sh(cmd, args) {
	return spawnSync(cmd, args, { encoding: "utf8" })
}

async function fund(pub) {
	const r = await fetch(`https://friendbot.stellar.org/?addr=${pub}`)
	if (!r.ok && r.status !== 400) throw new Error("friendbot failed for " + pub)
}

async function main() {
	const computed = new Asset("USDC", ISSUER).contractId(Networks.TESTNET)
	if (computed !== EXPECTED_SAC) {
		throw new Error(
			`derived SAC ${computed} != pinned ${EXPECTED_SAC} — registry/issuer mismatch`,
		)
	}
	if (!StrKey.isValidContract(computed)) throw new Error("invalid SAC id")

	if (sh("stellar", ["--version"]).status !== 0) {
		throw new Error("`stellar` CLI not found on PATH")
	}

	let source = process.env.SOURCE_SECRET
	if (!source) {
		const kp = Keypair.random()
		console.log("• funding ephemeral deploy source via friendbot…")
		await fund(kp.publicKey())
		source = kp.secret()
	}

	console.log(`• ensuring SAC for ${ASSET_ARG} on testnet…`)
	const res = sh("stellar", [
		"contract",
		"asset",
		"deploy",
		"--asset",
		ASSET_ARG,
		"--source-account",
		source,
		"--network",
		"testnet",
	])
	const out = `${res.stdout}\n${res.stderr}`
	if (res.status === 0) {
		console.log(`✓ deployed testnet USDC SAC: ${EXPECTED_SAC}`)
	} else if (/already.*exist|AlreadyExist|exists/i.test(out)) {
		console.log(`✓ testnet USDC SAC already deployed: ${EXPECTED_SAC}`)
	} else {
		throw new Error("SAC deploy failed:\n" + out)
	}
}

main().catch((e) => {
	console.error("deploy-testnet-usdc-sac failed:", e?.message || e)
	process.exit(1)
})
```

- [ ] **Step 2: Add the script to `package.json`**

In `"scripts"`, add:

```json
"deploy:testnet-sac": "node scripts/deploy-testnet-usdc-sac.mjs",
```

- [ ] **Step 3: Run it (requires network + `stellar` CLI)**

Run: `npm run deploy:testnet-sac` Expected: prints either
`✓ deployed testnet USDC SAC: CBIEL…AMA` or
`✓ testnet USDC SAC already deployed: CBIEL…AMA`. The derived-vs-pinned guard
must not fire.

- [ ] **Step 4: Verify lint passes**

Run: `npm run lint` Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy-testnet-usdc-sac.mjs package.json
git commit -m "chore(scripts): idempotent testnet USDC SAC deploy/verify helper"
```

---

## Task 7: Node/SDK real-testnet e2e (Layer C, opt-in)

**Files:**

- Create: `tests/e2e/testnet-usdc.e2e.test.ts`
- Modify: `package.json` (script), `vitest.config.ts` (include path),
  `.gitignore`

> Exercises the exact `buildTrustTx` + RPC submit path the dApp uses, against
> real testnet. Opt-in via `RUN_TESTNET_E2E=1` so it never runs in the fast unit
> suite.

- [ ] **Step 1: Add the e2e file to a dedicated Vitest path**

In `vitest.config.ts`, change `test.exclude` to NOT exclude the testnet e2e when
explicitly targeted, by adding a separate include guard — simplest: leave
`include` as-is for `npm test` (units only) and run the e2e by path. Update
`test.exclude` to keep excluding `tests/e2e/**` from `npm test`:

```ts
		exclude: ["tests/e2e/**", "node_modules/**", "dist/**"],
```

(no change needed if already present — the e2e is run by explicit path in Step
4).

- [ ] **Step 2: Write the e2e test** (`tests/e2e/testnet-usdc.e2e.test.ts`)

```ts
import { execFileSync } from "node:child_process"
import {
	Keypair,
	Networks,
	TransactionBuilder,
	rpc,
} from "@stellar/stellar-sdk"
import { buildTrustTx, getActivationStatus } from "@theaha/authline"
import { beforeAll, describe, expect, it } from "vitest"

const RUN = process.env.RUN_TESTNET_E2E === "1"
const NET = {
	rpcUrl: "https://soroban-testnet.stellar.org",
	horizonUrl: "https://horizon-testnet.stellar.org",
	passphrase: Networks.TESTNET,
}
const CONFIG = {
	assetCode: "USDC",
	assetIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
	sac: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
	authorizer: "",
	backends: ["cap73-one-signature"] as const,
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!RUN)("testnet USDC trust (real chain)", () => {
	const holder = Keypair.random()

	beforeAll(async () => {
		const r = await fetch(
			`https://friendbot.stellar.org/?addr=${holder.publicKey()}`,
		)
		if (!r.ok) throw new Error("friendbot failed")
		// Ensure the SAC exists (idempotent).
		execFileSync("node", ["scripts/deploy-testnet-usdc-sac.mjs"], {
			stdio: "inherit",
			env: { ...process.env, SOURCE_SECRET: holder.secret() },
		})
	}, 120_000)

	it("creates an authorized USDC trustline via SAC.trust(holder)", async () => {
		const xdr = await buildTrustTx({
			rpcUrl: NET.rpcUrl,
			networkPassphrase: NET.passphrase,
			holder: holder.publicKey(),
			config: CONFIG,
		})
		const tx = TransactionBuilder.fromXDR(xdr, NET.passphrase)
		tx.sign(holder)
		const server = new rpc.Server(NET.rpcUrl)
		const sent = await server.sendTransaction(tx)
		expect(sent.status).not.toBe("ERROR")

		const deadline = Date.now() + 60_000
		let got = await server.getTransaction(sent.hash)
		while (got.status === "NOT_FOUND" && Date.now() < deadline) {
			await sleep(1500)
			got = await server.getTransaction(sent.hash)
		}
		expect(got.status).toBe("SUCCESS")

		const st = await getActivationStatus({
			horizonUrl: NET.horizonUrl,
			account: holder.publicKey(),
			assetCode: CONFIG.assetCode,
			assetIssuer: CONFIG.assetIssuer,
		})
		expect(st).toEqual({ hasTrustline: true, isAuthorized: true })
	}, 180_000)
})
```

- [ ] **Step 3: Add the script + gitignore**

In `package.json` `"scripts"`, add:

```json
"test:e2e:testnet": "RUN_TESTNET_E2E=1 vitest run tests/e2e/testnet-usdc.e2e.test.ts",
```

Append to `.gitignore`:

```
# e2e
/test-results
/playwright-report
/tests/e2e/.auth
```

- [ ] **Step 4: Run it (real testnet, requires `stellar` CLI)**

Run: `npm run test:e2e:testnet` Expected: PASS — a real authorized USDC
trustline is created (visible on stellar.expert testnet). Confirms the `trust`
ABI and the whole open path on-chain.

- [ ] **Step 5: Confirm it is skipped in the fast suite**

Run: `npm test` Expected: the testnet e2e is NOT collected (units only); all
unit tests PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/testnet-usdc.e2e.test.ts package.json .gitignore vitest.config.ts
git commit -m "test(e2e): real-testnet Node SDK e2e for USDC trust (opt-in)"
```

---

## Task 8: `.env.e2e` + e2e build script (USDC-live on testnet)

**Files:**

- Create: `.env.e2e`
- Modify: `package.json` (script)

> The committed mainnet `.env` is untouched (stays EURCV). `.env.e2e` (Vite
> `--mode e2e`) overrides it for the e2e build only. `PUBLIC_ASSET_ISSUER` MUST
> be set because `config.ts`'s issuer fallback is a hardcoded EURCV value.

- [ ] **Step 1: Create `.env.e2e`**

```
PUBLIC_STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
PUBLIC_STELLAR_RPC_URL="https://soroban-testnet.stellar.org"
PUBLIC_STELLAR_HORIZON_URL="https://horizon-testnet.stellar.org"
PUBLIC_ASSET_CODE="USDC"
PUBLIC_ASSET_ISSUER="GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
PUBLIC_SAC="CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
```

- [ ] **Step 2: Add the `build:e2e` script to `package.json`**

In `"scripts"`, add:

```json
"build:e2e": "npm run build -w @theaha/authline && tsc -b && vite build --mode e2e",
```

- [ ] **Step 3: Build and confirm USDC is wired live**

Run:
`npm run build:e2e && grep -rl "USD Coin" dist/assets >/dev/null && echo "USDC bundled"`
Expected: build succeeds and prints `USDC bundled` (the USDC asset metadata is
in the bundle).

- [ ] **Step 4: Exclude test files from the production build**

In `tsconfig.app.json`, add an `exclude` so `tsc -b` never compiles tests into
the app build:

```json
{
	"extends": "@theahaco/ts-config/typescript",
	"include": ["src", "reset.d.ts"],
	"exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 5: Re-run the production build to confirm it is clean**

Run: `npm run build` Expected: succeeds (no attempt to compile `*.test.ts`).

- [ ] **Step 6: Commit**

```bash
git add .env.e2e package.json tsconfig.app.json
git commit -m "chore(app): add .env.e2e + build:e2e for testnet USDC-live builds"
```

---

## Task 9: Playwright browser real-testnet e2e (Layer B, opt-in)

**Files:**

- Create: `playwright.config.ts`, `tests/e2e/usdc-activation.spec.ts`
- Modify: `package.json` (script)

> Drives the real built dApp (USDC/testnet) in Chromium, injecting a
> friendbot-funded keypair as the signer (no extension). Signing happens in Node
> via `exposeFunction` (the secret never reaches the page). Opt-in: run with
> `npm run test:e2e`.

- [ ] **Step 1: Install Playwright**

Run:
`npm install --save-dev @playwright/test@^1 && npx playwright install chromium`
Expected: installs the test runner and the Chromium browser.

- [ ] **Step 2: Create `playwright.config.ts`**

```ts
import { defineConfig } from "@playwright/test"

const PORT = 4173
export default defineConfig({
	testDir: "tests/e2e",
	testMatch: "**/*.spec.ts",
	timeout: 240_000,
	expect: { timeout: 30_000 },
	fullyParallel: false,
	workers: 1,
	reporter: "list",
	use: {
		baseURL: `http://localhost:${PORT}`,
		actionTimeout: 30_000,
	},
	webServer: {
		command: `npm run build:e2e && npx vite preview --port ${PORT} --strictPort`,
		url: `http://localhost:${PORT}/app.html`,
		timeout: 240_000,
		reuseExistingServer: !process.env.CI,
	},
})
```

- [ ] **Step 3: Write the spec** (`tests/e2e/usdc-activation.spec.ts`)

```ts
import { execFileSync } from "node:child_process"
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk"
import { expect, test } from "@playwright/test"

const PASSPHRASE = Networks.TESTNET
const holder = Keypair.random()

test.beforeAll(async () => {
	const r = await fetch(
		`https://friendbot.stellar.org/?addr=${holder.publicKey()}`,
	)
	if (!r.ok) throw new Error("friendbot failed")
	execFileSync("node", ["scripts/deploy-testnet-usdc-sac.mjs"], {
		stdio: "inherit",
		env: { ...process.env, SOURCE_SECRET: holder.secret() },
	})
})

test("activate a USDC trustline through the dApp", async ({ page }) => {
	// Node-side signer: the secret never enters the page.
	await page.exposeFunction("__authlineSign", (xdr: string) => {
		const tx = TransactionBuilder.fromXDR(xdr, PASSPHRASE)
		tx.sign(holder)
		return tx.toXDR()
	})
	await page.addInitScript((address) => {
		;(window as unknown as { __AUTHLINE_E2E__: unknown }).__AUTHLINE_E2E__ = {
			address,
			async signTransaction(xdr: string) {
				const signedTxXdr = await (
					window as unknown as {
						__authlineSign: (x: string) => Promise<string>
					}
				).__authlineSign(xdr)
				return { signedTxXdr }
			},
		}
	}, holder.publicKey())

	await page.goto("/app.html")

	// Directory → pick USDC (the live tile)
	await page.getByRole("button", { name: /USDC/ }).first().click()
	// Idle → Connect (e2e seam connects directly)
	await page.getByRole("button", { name: /Connect wallet/i }).click()
	// Ready → Activate
	await page
		.getByRole("button", { name: /Activate USDC · 1 signature/ })
		.click()

	// Success
	await expect(page.getByText(/USDC trustline authorized/i)).toBeVisible({
		timeout: 180_000,
	})
})
```

- [ ] **Step 4: Add the script to `package.json`**

In `"scripts"`, add:

```json
"test:e2e": "playwright test",
```

- [ ] **Step 5: Run it (real testnet)**

Run: `npm run test:e2e` Expected: PASS — the browser walks directory → connect →
activate → "USDC trustline authorized". A real trustline is created on testnet.

- [ ] **Step 6: Commit**

```bash
git add playwright.config.ts tests/e2e/usdc-activation.spec.ts package.json package-lock.json
git commit -m "test(e2e): Playwright browser e2e for USDC activation on testnet (opt-in)"
```

---

## Task 10: CI — unit gate + opt-in e2e job

**Files:**

- Modify: `.github/workflows/build.yml`

> Add the Vitest unit run to the existing PR pipeline (the first real test
> gate). Add a separate `workflow_dispatch` job for the testnet e2e so its
> network flakiness never blocks PRs.

- [ ] **Step 1: Read the current workflow**

Run: `sed -n '1,80p' .github/workflows/build.yml` Expected: shows the existing
job that runs `npm ci`, lint, prettier, build, and `npm test --if-present`.

- [ ] **Step 2: Replace the no-op test step with the real unit run**

In `.github/workflows/build.yml`, find the step running `npm test --if-present`
and change its `run:` to:

```yaml
- name: Unit tests
  run: npm test
```

(If there is no such step, add the `Unit tests` step immediately after the build
step, within the same job.)

- [ ] **Step 3: Add an opt-in testnet e2e job**

Append a new job at the end of `.github/workflows/build.yml` (sibling of the
existing job; ensure `on:` includes `workflow_dispatch`):

```yaml
e2e-testnet:
  if: github.event_name == 'workflow_dispatch'
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: 20
    - run: npm ci
    - name: Install Stellar CLI
      run: |
        curl -sSfL https://github.com/stellar/stellar-cli/releases/latest/download/stellar-cli-installer.sh | sh || \
        cargo install --locked stellar-cli
    - run: npx playwright install --with-deps chromium
    - name: Node SDK testnet e2e
      run: npm run test:e2e:testnet
    - name: Playwright browser testnet e2e
      run: npm run test:e2e
```

Also ensure the top-level `on:` block contains `workflow_dispatch:` (add it if
missing).

- [ ] **Step 4: Validate the workflow YAML**

Run:
`npx --yes js-yaml .github/workflows/build.yml >/dev/null && echo "valid YAML"`
Expected: prints `valid YAML`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/build.yml
git commit -m "ci: gate PRs on unit tests; add opt-in testnet e2e job"
```

---

## Task 11 (optional, flagged): capability-aware copy polish

> **Spec deviation:** the approved spec §5.4 said "no copy/flow changes." But
> the idle/ready screens show an `Auth req.` pill and say "create **and**
> authorize," which is inaccurate for an open asset like USDC (no authorize
> step). This task makes that copy capability-aware. It is **optional** — drop
> it to stay strictly within the approved scope. It touches no logic and no test
> asserts the affected strings.

**Files:**

- Modify: `src/authline.tsx` (idle/ready `AssetRow` status pill + the "create
  and authorize" sentence)

- [ ] **Step 1: Define a copy helper**

Near the other module-scope helpers in `src/authline.tsx` (e.g. after `short`),
add:

```ts
const IS_OPEN = ASSET.capability === "open" || !ASSET.authorizer
const TRUST_VERB = IS_OPEN ? "create" : "create and authorize"
const STATUS_PILL_LABEL = IS_OPEN ? "Trustline" : "Auth req."
```

- [ ] **Step 2: Use them in the idle copy**

In the idle paragraph (around line 897), replace
`create <b …>and</b> authorize your {ASSET.assetCode} trustline` with a single
expression using `TRUST_VERB`:

```ts
						{TRUST_VERB} your {ASSET.assetCode} trustline in a single signature.
```

And replace the idle `AssetRow` status (line 886)
`<Pill accent>Auth req.</Pill>` with:

```ts
					<AssetRow status={<Pill accent>{STATUS_PILL_LABEL}</Pill>} />
```

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck && npm run build` Expected: succeeds.

- [ ] **Step 4: Re-run the Playwright e2e (copy change must not break it)**

Run: `npm run test:e2e` Expected: PASS (the e2e asserts the Activate button +
success heading, which are unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/authline.tsx
git commit -m "polish(app): capability-aware onboarding copy for open assets"
```

---

## Self-Review

**Spec coverage:**

- §5.1 `buildTrustTx` → Task 3. ✔
- §5.2 testnet USDC registry entry → Task 2. ✔
- §5.3 USDC-live testnet env-driven, no `config.ts` change, mainnet untouched →
  Tasks 4 + 8. ✔
- §5.4 `activate()` capability branch → Task 5. ✔
- §5.5 SAC deploy helper → Task 6. ✔
- §5.6 `window.__AUTHLINE_E2E__` wallet seam → Task 5. ✔
- §6.1 tooling (Vitest + Playwright, scripts) → Tasks 1, 7, 8, 9. ✔
- §6.2 unit tests (registry/config/builder) → Tasks 2, 3, 4. ✔
- §6.3 Playwright real-testnet e2e → Task 9. ✔
- §6.4 Node/SDK real-testnet e2e → Task 7. ✔
- §6.5 CI unit gate + opt-in e2e → Task 10. ✔
- §5.4 copy note → addressed as flagged optional Task 11. ✔

**Placeholder scan:** No TBD/TODO; every code/command step is concrete (SAC id,
issuer, flags, file paths, expected outputs all filled).

**Type consistency:** `buildTrustTx`/`BuildTrustOptions` defined in Task 3 and
used identically in Tasks 5/7. `E2ESigner` shape (`address`,
`signTransaction(xdr) → { signedTxXdr }`) defined in Task 5 and matched by the
Playwright injection in Task 9. `OnboarderConfig` fields (`assetCode`,
`assetIssuer`, `sac`, `authorizer`, `backends`) used consistently. Registry
constants (testnet issuer/SAC) identical across Tasks 2, 4, 6, 7, 8, 9.

**Known contingencies (not blockers):**

- Vitest SDK-source alias relies on Vite resolving the SDK's internal `./x.js`
  imports to `.ts`. If it fails, build the SDK first
  (`npm run build -w @theaha/authline`) and remove the alias so
  `@theaha/authline` resolves to `dist`.
- The exact `stellar contract asset deploy` "already exists" message may vary;
  Task 6 matches it case-insensitively and the testnet e2e (Task 7) is the
  on-chain proof either way.
