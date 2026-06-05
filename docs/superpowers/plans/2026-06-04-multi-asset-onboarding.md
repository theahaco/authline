# Multi-asset Stellar Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-asset EURCV authorization page into a
capability-driven, curated multi-asset Stellar onboarding tool.

**Architecture:** A curated, issuer-pinned in-repo asset registry
(`src/contracts/assets.ts`) drives an `AssetSelector` and a `useOnboard` hook.
Each asset declares a capability (`open` → changeTrust only;
`permissionedOneStep` → trust+authorize; `permissionedManual` → issuer
authorizes off-platform). The existing `trustline-onboard` contract — already
generic in its parameters — is renamed to drop EURCV-specific names and gains a
post-condition assert (`require sac.authorized(holder)`).

**Tech Stack:** Soroban (Rust, soroban-sdk 26.0.0, CAP-73), Vite + React +
TypeScript, `@stellar/stellar-sdk`, `@stellar/design-system`.

**Spec:** `docs/superpowers/specs/2026-06-04-multi-asset-onboarding-design.md`

**Note on TDD:** The Rust contract has a real test suite — those tasks are
strict TDD (write failing test → run → implement → pass). The frontend has **no
test runner** (per the approved spec); frontend tasks use `npm run typecheck`
(and a one-off node check for the registry validator) as the verification gate.
Adding a frontend test harness is out of scope.

**Note on scope:** This is the _feature_ PR. The ~43 orthogonal review findings
(deploy-script WASM bug, config footguns, script guards, FE Low/Nits) go in a
**separate stacked PR**. Only changes intrinsic to this feature (the rename, the
post-condition hardening, SAC pinning) live here.

---

## File Structure

**Rust (contracts):**

- `contracts/trustline-onboard/src/lib.rs` — rename authorizer interface to
  generic; add `NotAuthorized` error + post-condition assert.
- `contracts/trustline-onboard/src/test.rs` — update for rename; add
  error-path + post-condition tests.
- `contracts/eurcv-auth-stub/` → `contracts/authorizer-stub/` — rename crate
  (dir, Cargo.toml, struct).
- `Cargo.toml` (workspace) — update member path.
- `scripts/issue-test-asset.sh` — update the stub WASM filename + echo text.

**Frontend (src):**

- `src/contracts/assets.ts` — **new**: registry types, verified seed,
  `assetsForNetwork()`, strkey validation guard.
- `eslint.config.js` — un-ignore `src/contracts/assets.ts`.
- `src/hooks/useOnboard.ts` — **new**: the three flows + account status,
  parameterized by selected asset.
- `src/components/AssetSelector.tsx` — **new**: renders the network's official
  assets as a selectable list with capability/warning badges.
- `src/components/AuthorizeTrustline.tsx` — rewrite to compose `AssetSelector` +
  `useOnboard`; render per capability. (Keep the filename to avoid `App.tsx`
  churn.)
- `src/contracts/util.ts` — remove the single-asset singletons the component
  used (`assetCode`/`assetIssuer`/`assetSacContractId`); keep
  network/rpc/onboard config and `eurcvAuthContractId` (still consumed by the
  generated `eurcv_auth.ts` binding).

---

## Task 1: Rename authorizer interface + post-condition hardening (contract)

**Files:**

- Modify: `contracts/trustline-onboard/src/lib.rs`
- Test: `contracts/trustline-onboard/src/test.rs`

- [ ] **Step 1: Rewrite the test file with the renamed trait + new error-path
      tests (failing)**

Replace the entire contents of `contracts/trustline-onboard/src/test.rs` with:

```rust
#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::testutils::{Address as _, IssuerFlags};
use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env};

// A correct authorizer: it is the SAC admin and authorizes the account.
#[contract]
pub struct StubAuthorizer;

#[contractimpl]
impl StubAuthorizer {
    pub fn __constructor(env: Env, sac: Address) {
        env.storage().instance().set(&symbol_short!("SAC"), &sac);
    }
}

#[contractimpl]
impl Authorizer for StubAuthorizer {
    fn authorize_trustline(env: Env, account: Address) -> Result<(), soroban_sdk::Error> {
        let sac: Address = env
            .storage()
            .instance()
            .get(&symbol_short!("SAC"))
            .expect("SAC not set");
        StellarAssetClient::new(&env, &sac).set_authorized(&account, &true);
        Ok(())
    }
}

// An authorizer that always returns an error (never authorizes).
#[contract]
pub struct FailingAuthorizer;

#[contractimpl]
impl FailingAuthorizer {
    pub fn authorize_trustline(_env: Env, _account: Address) -> Result<(), Error> {
        Err(Error::AuthorizationFailed)
    }
}

// An authorizer that returns Ok but does NOT actually authorize the account.
#[contract]
pub struct NoopAuthorizer;

#[contractimpl]
impl NoopAuthorizer {
    pub fn authorize_trustline(_env: Env, _account: Address) -> Result<(), Error> {
        Ok(())
    }
}

fn setup(env: &Env) -> (Address, Address) {
    let issuer = Address::generate(env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let sac_addr = sac.address();
    sac.issuer().set_flag(IssuerFlags::RequiredFlag);
    let onboard_addr = env.register(TrustlineOnboard, ());
    (sac_addr, onboard_addr)
}

#[test]
fn onboard_creates_trustline_and_authorizes() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let holder = Address::generate(&env);
    let (sac_addr, onboard_addr) = setup(&env);

    let authorizer = env.register(StubAuthorizer, (sac_addr.clone(),));
    StellarAssetClient::new(&env, &sac_addr).set_admin(&authorizer);

    let client = TrustlineOnboardClient::new(&env, &onboard_addr);
    client.onboard(&sac_addr, &authorizer, &holder);

    assert!(StellarAssetClient::new(&env, &sac_addr).authorized(&holder));
}

#[test]
fn onboard_surfaces_authorization_failure() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let holder = Address::generate(&env);
    let (sac_addr, onboard_addr) = setup(&env);

    let authorizer = env.register(FailingAuthorizer, ());
    let client = TrustlineOnboardClient::new(&env, &onboard_addr);

    assert_eq!(
        client.try_onboard(&sac_addr, &authorizer, &holder),
        Err(Ok(Error::AuthorizationFailed))
    );
}

#[test]
fn onboard_rejects_when_post_condition_unmet() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let holder = Address::generate(&env);
    let (sac_addr, onboard_addr) = setup(&env);

    // Noop authorizer returns Ok but never sets the authorized flag, so the
    // post-condition `sac.authorized(holder)` is false.
    let authorizer = env.register(NoopAuthorizer, ());
    let client = TrustlineOnboardClient::new(&env, &onboard_addr);

    assert_eq!(
        client.try_onboard(&sac_addr, &authorizer, &holder),
        Err(Ok(Error::NotAuthorized))
    );
}
```

- [ ] **Step 2: Run the tests to verify they fail to compile/pass**

Run: `cargo test -p trustline-onboard` Expected: FAIL — `Authorizer` trait /
`Error::NotAuthorized` not yet defined in `lib.rs` (compile error).

- [ ] **Step 3: Rewrite `lib.rs` with the renamed interface, new error, and
      post-condition**

Replace the entire contents of `contracts/trustline-onboard/src/lib.rs` with:

```rust
#![no_std]
use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::{contract, contractclient, contracterror, contractimpl, Address, Env};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    TrustFailed = 1,
    AuthorizationFailed = 2,
    NotAuthorized = 3,
}

/// Generic trustline authorizer: any SAC-admin contract exposing
/// `authorize_trustline(account)` (e.g. EURCV's authorizer wraps `set_authorized`).
#[contractclient(name = "AuthorizerClient")]
pub trait Authorizer {
    fn authorize_trustline(env: Env, account: Address) -> Result<(), soroban_sdk::Error>;
}

#[contract]
pub struct TrustlineOnboard;

#[contractimpl]
impl TrustlineOnboard {
    /// Create the holder's trustline (CAP-73 `SAC.trust`) and authorize it via the
    /// asset's authorizer contract, in a single holder-signed transaction.
    pub fn onboard(
        env: Env,
        sac: Address,
        authorizer: Address,
        holder: Address,
    ) -> Result<(), Error> {
        holder.require_auth();
        let sac_client = StellarAssetClient::new(&env, &sac);
        sac_client
            .try_trust(&holder)
            .map_err(|_| Error::TrustFailed)?
            .map_err(|_| Error::TrustFailed)?;
        AuthorizerClient::new(&env, &authorizer)
            .try_authorize_trustline(&holder)
            .map_err(|_| Error::AuthorizationFailed)?
            .map_err(|_| Error::AuthorizationFailed)?;
        // Post-condition: confirm the holder is actually authorized on THIS sac.
        // Guards against a wrong/divergent SAC or an authorizer that no-ops.
        if !sac_client.authorized(&holder) {
            return Err(Error::NotAuthorized);
        }
        Ok(())
    }
}

mod test;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p trustline-onboard` Expected: PASS — 3 tests
(`onboard_creates_trustline_and_authorizes`,
`onboard_surfaces_authorization_failure`,
`onboard_rejects_when_post_condition_unmet`).

- [ ] **Step 5: Commit**

```bash
git add contracts/trustline-onboard/src/lib.rs contracts/trustline-onboard/src/test.rs
git commit -m "feat(onboard): rename authorizer interface + post-condition hardening"
```

---

## Task 2: Rename `eurcv-auth-stub` crate → `authorizer-stub`

**Files:**

- Rename: `contracts/eurcv-auth-stub/` → `contracts/authorizer-stub/`
- Modify: `contracts/authorizer-stub/Cargo.toml`,
  `contracts/authorizer-stub/src/lib.rs`,
  `contracts/authorizer-stub/src/test.rs`
- Modify: `Cargo.toml` (workspace member)
- Modify: `scripts/issue-test-asset.sh`

- [ ] **Step 1: Move the crate directory (preserves history + snapshots)**

```bash
git mv contracts/eurcv-auth-stub contracts/authorizer-stub
```

- [ ] **Step 2: Update the workspace member path**

In `Cargo.toml`, change the member line:

```toml
    "contracts/eurcv-auth-stub",
```

to:

```toml
    "contracts/authorizer-stub",
```

- [ ] **Step 3: Update the crate name + description**

In `contracts/authorizer-stub/Cargo.toml`, change:

```toml
name = "eurcv-auth-stub"
description = "Testnet stub for the eurcv_auth admin contract — permissionless authorize, no ban list"
```

to:

```toml
name = "authorizer-stub"
description = "Testnet stub authorizer — permissionless authorize_trustline, no ban list. Test/dev only."
```

- [ ] **Step 4: Rename the struct in `lib.rs`**

In `contracts/authorizer-stub/src/lib.rs`, rename the type `EurcvAuthStub` →
`AuthorizerStub` (both the `#[contract] pub struct EurcvAuthStub;` and its two
`impl` blocks). Leave the methods (`__constructor`, `authorize_trustline`,
`sac`) and the `Error`/`SAC_KEY` unchanged.

- [ ] **Step 5: Update the test client name in `test.rs`**

In `contracts/authorizer-stub/src/test.rs`, replace `EurcvAuthStub` →
`AuthorizerStub` and `EurcvAuthStubClient` → `AuthorizerStubClient`.

- [ ] **Step 6: Update the script's WASM filename + echo**

In `scripts/issue-test-asset.sh`, change:

```bash
WASM="target/wasm32v1-none/release/eurcv_auth_stub.wasm"
```

to:

```bash
WASM="target/wasm32v1-none/release/authorizer_stub.wasm"
```

and the echo line:

```bash
echo ">> deploying eurcv-auth-stub"
```

to:

```bash
echo ">> deploying authorizer-stub"
```

- [ ] **Step 7: Verify the workspace still builds and all contract tests pass**

Run: `cargo test` Expected: PASS — `trustline-onboard` (3 tests) +
`authorizer-stub` (1 test: `authorize_trustline_flips_authorized_flag`) +
`guess-the-number` all green.

- [ ] **Step 8: Commit**

```bash
git add -A contracts Cargo.toml scripts/issue-test-asset.sh
git commit -m "refactor: rename eurcv-auth-stub crate to authorizer-stub"
```

---

## Task 3: Create the curated asset registry

**Files:**

- Create: `src/contracts/assets.ts`
- Modify: `eslint.config.js`

- [ ] **Step 1: Create the registry module**

Create `src/contracts/assets.ts` with:

```ts
import { StrKey } from "@stellar/stellar-sdk"
import { stellarNetwork } from "./util"

export type AssetCapability =
	| "open"
	| "permissionedOneStep"
	| "permissionedManual"
export type StellarNet = "PUBLIC" | "TESTNET" | "FUTURENET" | "LOCAL"

export interface OfficialAsset {
	code: string
	/** PINNED issuer — scam-issuer mitigation; never resolve an asset by code alone. */
	issuer: string
	/** PINNED canonical Stellar Asset Contract id (verified), not derived at runtime. */
	sac: string
	/** Required iff capability === "permissionedOneStep": the authorize_trustline contract. */
	authorizer?: string
	capability: AssetCapability
	name: string
	network: StellarNet
	homeDomain?: string
	/** Issuer can freeze the trustline. */
	authRevocable?: boolean
	/** Issuer can claw back balances — surfaced as a UI warning. */
	authClawback?: boolean
	/** Date the on-chain facts were verified (source-of-truth marker). */
	verifiedAt?: string
}

// All addresses verified on-chain (Horizon /accounts flags + stellar.expert),
// strkeys checksum-valid, on 2026-06-04. See the design spec for sources.
export const OFFICIAL_ASSETS: OfficialAsset[] = [
	{
		code: "USDC",
		issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
		sac: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
		capability: "open",
		name: "USD Coin",
		network: "PUBLIC",
		homeDomain: "circle.com",
		authRevocable: true,
		authClawback: false,
		verifiedAt: "2026-06-04",
	},
	{
		code: "EURC",
		issuer: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2",
		sac: "CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV",
		capability: "open",
		name: "Euro Coin",
		network: "PUBLIC",
		homeDomain: "circle.com",
		authRevocable: true,
		authClawback: false,
		verifiedAt: "2026-06-04",
	},
	{
		code: "EURCV",
		issuer: "GCEYGIVOLAVBF2TG2RUSGTUJCIN75KEX3NGLMY4VPL4GFE5L355AXW3G",
		sac: "CANKBYNNAYKEZXLB655F2UPNTAZFK5HILZUXL7ZTFR3NF6LKDSVY7KFH",
		authorizer: "CB2DHZMQHQE3TGUMD6BRM7UCJZNIPKDRVEQOWBIRRS3G2FZOGDTRKSB3",
		capability: "permissionedOneStep",
		name: "EUR CoinVertible",
		network: "PUBLIC",
		homeDomain: "sgforge.com",
		authRevocable: true,
		authClawback: true,
		verifiedAt: "2026-06-04",
	},
]

// Optional per-deployment override from PUBLIC_TEST_* env vars, preserving the
// scripts/issue-test-asset.sh testnet workflow. Injected for the active network.
function envOverrideAsset(): OfficialAsset | null {
	const code = import.meta.env.PUBLIC_TEST_ASSET_CODE as string | undefined
	const issuer = import.meta.env.PUBLIC_TEST_ASSET_ISSUER as string | undefined
	const sac = import.meta.env.PUBLIC_TEST_SAC as string | undefined
	const authorizer = import.meta.env.PUBLIC_EURCV_AUTH_CONTRACT_ID as
		| string
		| undefined
	if (!code || !issuer || !sac) return null
	return {
		code,
		issuer,
		sac,
		authorizer,
		capability: authorizer ? "permissionedOneStep" : "open",
		name: `${code} (test)`,
		network: stellarNetwork as StellarNet,
		verifiedAt: undefined,
	}
}

function validate(a: OfficialAsset): void {
	if (!StrKey.isValidEd25519PublicKey(a.issuer))
		throw new Error(
			`assets.ts: ${a.code} issuer is not a valid G-address: ${a.issuer}`,
		)
	if (!StrKey.isValidContract(a.sac))
		throw new Error(
			`assets.ts: ${a.code} sac is not a valid C-address: ${a.sac}`,
		)
	if (a.authorizer && !StrKey.isValidContract(a.authorizer))
		throw new Error(
			`assets.ts: ${a.code} authorizer is not a valid C-address: ${a.authorizer}`,
		)
	if (a.capability === "permissionedOneStep" && !a.authorizer)
		throw new Error(
			`assets.ts: ${a.code} is permissionedOneStep but has no authorizer`,
		)
}

const override = envOverrideAsset()
const ALL: OfficialAsset[] = override
	? [...OFFICIAL_ASSETS, override]
	: [...OFFICIAL_ASSETS]
ALL.forEach(validate)

export function assetsForNetwork(
	net: StellarNet = stellarNetwork as StellarNet,
): OfficialAsset[] {
	return ALL.filter((a) => a.network === net)
}
```

- [ ] **Step 2: Un-ignore the registry in eslint**

In `eslint.config.js`, find the ignore block containing `"src/contracts/*"` and
`"!src/contracts/util.ts"`, and add a third line so `assets.ts` is linted:

```js
		"src/contracts/*",
		"!src/contracts/util.ts",
		"!src/contracts/assets.ts",
```

- [ ] **Step 3: Verify typecheck passes**

Run: `npm run typecheck` Expected: PASS (no errors).

- [ ] **Step 4: Verify the strkey validator catches a bad address (manual)**

Run:

```bash
node -e "const {StrKey}=require('@stellar/stellar-sdk'); console.log(StrKey.isValidEd25519PublicKey('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'), StrKey.isValidContract('CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'), StrKey.isValidEd25519PublicKey('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN_BAD'))"
```

Expected: `true true false` — confirms the validators discriminate good vs. bad
strkeys.

- [ ] **Step 5: Commit**

```bash
git add src/contracts/assets.ts eslint.config.js
git commit -m "feat(assets): curated issuer-pinned asset registry with strkey validation"
```

---

## Task 4: Create the `useOnboard` hook

**Files:**

- Create: `src/hooks/useOnboard.ts`

- [ ] **Step 1: Create the hook**

Create `src/hooks/useOnboard.ts` with:

```ts
import {
	Address,
	Asset,
	BASE_FEE,
	Contract,
	Horizon,
	nativeToScVal,
	Operation,
	rpc,
	TransactionBuilder,
} from "@stellar/stellar-sdk"
import { useCallback, useEffect, useState } from "react"
import type { OfficialAsset } from "../contracts/assets"
import {
	horizonUrl,
	networkPassphrase,
	rpcUrl,
	trustlineOnboardContractId,
} from "../contracts/util"

export type Status = "idle" | "loading" | "success" | "error"

type SignFn = (
	xdr: string,
	opts: { networkPassphrase: string; address?: string },
) => Promise<{ signedTxXdr: string }>

const PASSPHRASE = networkPassphrase as string

async function pollForSuccess(server: rpc.Server, hash: string): Promise<void> {
	let res = await server.getTransaction(hash)
	const deadline = Date.now() + 60_000
	while (res.status === "NOT_FOUND" && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 1000))
		res = await server.getTransaction(hash)
	}
	if (res.status !== "SUCCESS") throw new Error(`Transaction ${res.status}`)
}

export function useOnboard(
	asset: OfficialAsset | null,
	address: string | null,
	signTransaction: SignFn,
) {
	const [hasTrustline, setHasTrustline] = useState(false)
	const [isAuthorized, setIsAuthorized] = useState(false)
	const [checking, setChecking] = useState(false)
	const [classic, setClassic] = useState<{ status: Status; error: string }>({
		status: "idle",
		error: "",
	})
	const [authorize, setAuthorize] = useState<{ status: Status; error: string }>(
		{ status: "idle", error: "" },
	)
	const [oneStep, setOneStep] = useState<{ status: Status; error: string }>({
		status: "idle",
		error: "",
	})

	const refresh = useCallback(
		async (account: string) => {
			if (!asset || !account.trim()) return
			setChecking(true)
			try {
				const horizon = new Horizon.Server(horizonUrl)
				const acc = await horizon.loadAccount(account.trim())
				const tl = acc.balances.find(
					(b) =>
						b.asset_type !== "native" &&
						b.asset_type !== "liquidity_pool_shares" &&
						(b as Horizon.HorizonApi.BalanceLineAsset).asset_code ===
							asset.code &&
						(b as Horizon.HorizonApi.BalanceLineAsset).asset_issuer ===
							asset.issuer,
				) as Horizon.HorizonApi.BalanceLineAsset | undefined
				setHasTrustline(!!tl)
				setIsAuthorized(!!tl?.is_authorized)
			} catch {
				setHasTrustline(false)
				setIsAuthorized(false)
			} finally {
				setChecking(false)
			}
		},
		[asset],
	)

	// Reset per-asset state when the selected asset changes.
	useEffect(() => {
		setHasTrustline(false)
		setIsAuthorized(false)
		setClassic({ status: "idle", error: "" })
		setAuthorize({ status: "idle", error: "" })
		setOneStep({ status: "idle", error: "" })
	}, [asset])

	const runClassic = useCallback(async () => {
		if (!asset || !address) return
		setClassic({ status: "loading", error: "" })
		try {
			const horizon = new Horizon.Server(horizonUrl)
			const source = await horizon.loadAccount(address)
			const tx = new TransactionBuilder(source, {
				fee: BASE_FEE,
				networkPassphrase: PASSPHRASE,
			})
				.addOperation(
					Operation.changeTrust({ asset: new Asset(asset.code, asset.issuer) }),
				)
				.setTimeout(180)
				.build()
			const { signedTxXdr } = await signTransaction(tx.toXDR(), {
				networkPassphrase: PASSPHRASE,
				address,
			})
			const result = await horizon.submitTransaction(
				TransactionBuilder.fromXDR(signedTxXdr, PASSPHRASE),
			)
			if ((result as unknown as { successful: boolean }).successful) {
				setClassic({ status: "success", error: "" })
				await refresh(address)
			} else {
				setClassic({ status: "error", error: "Transaction failed" })
			}
		} catch (e: unknown) {
			const ex = e as {
				response?: {
					data?: {
						extras?: {
							result_codes?: { operations?: string[]; transaction?: string }
							result_xdr?: string
						}
					}
				}
			}
			const codes = ex?.response?.data?.extras?.result_codes
			const msg =
				codes?.operations?.[0] ||
				codes?.transaction ||
				ex?.response?.data?.extras?.result_xdr ||
				(e instanceof Error ? e.message : String(e))
			setClassic({ status: "error", error: String(msg) })
		}
	}, [asset, address, signTransaction, refresh])

	const runAuthorize = useCallback(
		async (account: string) => {
			if (!asset?.authorizer || !address || !account.trim()) return
			setAuthorize({ status: "loading", error: "" })
			try {
				const server = new rpc.Server(rpcUrl, { allowHttp: true })
				const source = await server.getAccount(address)
				const contract = new Contract(asset.authorizer)
				const tx = new TransactionBuilder(source, {
					fee: BASE_FEE,
					networkPassphrase: PASSPHRASE,
				})
					.addOperation(
						contract.call(
							"authorize_trustline",
							nativeToScVal(Address.fromString(account.trim()), {
								type: "address",
							}),
						),
					)
					.setTimeout(180)
					.build()
				const prepared = await server.prepareTransaction(tx)
				const { signedTxXdr } = await signTransaction(prepared.toXDR(), {
					networkPassphrase: PASSPHRASE,
					address,
				})
				const send = await server.sendTransaction(
					TransactionBuilder.fromXDR(signedTxXdr, PASSPHRASE),
				)
				if (send.status === "ERROR") {
					throw new Error(
						send.errorResult?.result().toString() ??
							"sendTransaction returned ERROR",
					)
				}
				await pollForSuccess(server, send.hash)
				setAuthorize({ status: "success", error: "" })
				await refresh(account.trim())
			} catch (e) {
				setAuthorize({
					status: "error",
					error: e instanceof Error ? e.message : String(e),
				})
			}
		},
		[asset, address, signTransaction, refresh],
	)

	const runOneStep = useCallback(async () => {
		if (!asset?.authorizer || !address || !trustlineOnboardContractId) return
		setOneStep({ status: "loading", error: "" })
		try {
			const server = new rpc.Server(rpcUrl, { allowHttp: true })
			const source = await server.getAccount(address)
			const contract = new Contract(trustlineOnboardContractId)
			const tx = new TransactionBuilder(source, {
				fee: BASE_FEE,
				networkPassphrase: PASSPHRASE,
			})
				.addOperation(
					contract.call(
						"onboard",
						nativeToScVal(Address.fromString(asset.sac), { type: "address" }),
						nativeToScVal(Address.fromString(asset.authorizer), {
							type: "address",
						}),
						nativeToScVal(Address.fromString(address), { type: "address" }),
					),
				)
				.setTimeout(180)
				.build()
			const prepared = await server.prepareTransaction(tx)
			const { signedTxXdr } = await signTransaction(prepared.toXDR(), {
				networkPassphrase: PASSPHRASE,
				address,
			})
			const send = await server.sendTransaction(
				TransactionBuilder.fromXDR(signedTxXdr, PASSPHRASE),
			)
			if (send.status === "ERROR") {
				throw new Error(
					send.errorResult?.result().toString() ??
						"sendTransaction returned ERROR",
				)
			}
			await pollForSuccess(server, send.hash)
			setOneStep({ status: "success", error: "" })
			await refresh(address)
		} catch (e) {
			setOneStep({
				status: "error",
				error: e instanceof Error ? e.message : String(e),
			})
		}
	}, [asset, address, signTransaction, refresh])

	return {
		hasTrustline,
		isAuthorized,
		checking,
		classic,
		authorize,
		oneStep,
		runClassic,
		runAuthorize,
		runOneStep,
		refresh,
	}
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck` Expected: PASS (the hook is additive; nothing imports
it yet).

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useOnboard.ts
git commit -m "feat(hooks): add useOnboard — asset-parameterized trust/authorize/one-step flows"
```

---

## Task 5: Create the `AssetSelector` component

**Files:**

- Create: `src/components/AssetSelector.tsx`

- [ ] **Step 1: Create the component**

Create `src/components/AssetSelector.tsx` with:

```tsx
import { Badge, Card, Icon, Text } from "@stellar/design-system"
import type { OfficialAsset } from "../contracts/assets"

const CAPABILITY_LABEL: Record<OfficialAsset["capability"], string> = {
	open: "Open",
	permissionedOneStep: "Permissioned · one-step",
	permissionedManual: "Permissioned · issuer-approved",
}

export const AssetSelector = ({
	assets,
	selected,
	onSelect,
}: {
	assets: OfficialAsset[]
	selected: OfficialAsset | null
	onSelect: (a: OfficialAsset) => void
}) => {
	if (assets.length === 0) {
		return (
			<Text as="p" size="sm">
				No official assets are configured for this network.
			</Text>
		)
	}
	return (
		<div className="AssetSelector">
			{assets.map((a) => {
				const isSelected =
					selected?.code === a.code && selected?.issuer === a.issuer
				return (
					<Card key={`${a.code}-${a.issuer}`}>
						<button
							type="button"
							onClick={() => onSelect(a)}
							aria-pressed={isSelected}
							style={{
								width: "100%",
								textAlign: "left",
								cursor: "pointer",
								border: isSelected
									? "2px solid var(--sds-clr-lilac-09, #6e56cf)"
									: "1px solid transparent",
								background: "transparent",
								padding: "0.5rem",
								borderRadius: "0.5rem",
							}}
						>
							<div
								style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
							>
								<Text as="span" size="md" weight="medium">
									{a.code}
								</Text>
								<Text as="span" size="sm" style={{ opacity: 0.7 }}>
									{a.name}
								</Text>
								<Badge
									variant={a.capability === "open" ? "secondary" : "primary"}
								>
									{CAPABILITY_LABEL[a.capability]}
								</Badge>
							</div>
							{a.authClawback && (
								<Text
									as="p"
									size="xs"
									style={{ marginTop: "0.25rem", opacity: 0.7 }}
								>
									<Icon.AlertTriangle /> Issuer can freeze or claw back this
									asset.
								</Text>
							)}
						</button>
					</Card>
				)
			})}
		</div>
	)
}
```

> If `Badge`/`Text` prop names (`variant`, `weight`, `size="xs"`) don't match
> the installed `@stellar/design-system` version, adjust to the nearest valid
> prop — the typecheck step will surface mismatches.

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck` Expected: PASS. If `Badge` variant values or `Text`
props error, adjust to valid values per the type errors, then re-run until PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/AssetSelector.tsx
git commit -m "feat(ui): add AssetSelector with capability badges + clawback warning"
```

---

## Task 6: Rewrite `AuthorizeTrustline` to drive multi-asset onboarding

**Files:**

- Modify: `src/components/AuthorizeTrustline.tsx` (full rewrite of the component
  body)

- [ ] **Step 1: Rewrite the component**

Replace the entire contents of `src/components/AuthorizeTrustline.tsx` with:

```tsx
import { Button, Card, Icon, Input, Text } from "@stellar/design-system"
import { useEffect, useMemo, useState } from "react"
import { assetsForNetwork, type OfficialAsset } from "../contracts/assets"
import {
	networkPassphrase,
	stellarNetwork,
	trustlineOnboardContractId,
} from "../contracts/util"
import { useOnboard } from "../hooks/useOnboard"
import { useWallet } from "../hooks/useWallet"
import { connectWallet } from "../util/wallet"
import { AssetSelector } from "./AssetSelector"

const EXPLORER_PATH: Record<string, string | null> = {
	PUBLIC: "public",
	TESTNET: "testnet",
	FUTURENET: null,
	LOCAL: null,
}

export const AuthorizeTrustline = () => {
	const {
		address,
		signTransaction,
		networkPassphrase: walletPassphrase,
	} = useWallet()
	const isWrongNetwork =
		address && walletPassphrase && walletPassphrase !== networkPassphrase

	const assets = useMemo(() => assetsForNetwork(), [])
	const [selected, setSelected] = useState<OfficialAsset | null>(
		assets[0] ?? null,
	)
	const [account, setAccount] = useState("")

	const ob = useOnboard(selected, address ?? null, signTransaction)

	useEffect(() => {
		if (address && !account) setAccount(address)
	}, [address, account])

	useEffect(() => {
		if (account.trim().length >= 56) void ob.refresh(account.trim())
	}, [account, selected]) // eslint-disable-line react-hooks/exhaustive-deps

	const isSelf = account.trim() === address
	const explorer = EXPLORER_PATH[stellarNetwork]
	const canOneStep =
		!!selected &&
		selected.capability === "permissionedOneStep" &&
		!!trustlineOnboardContractId &&
		isSelf &&
		!ob.hasTrustline &&
		!ob.isAuthorized
	const isPermissioned = selected?.capability !== "open"

	return (
		<div className="AuthorizeTrustline">
			<div className="AuthorizeTrustline__hero">
				<h1>Stellar Asset Onboarding</h1>
				<Text as="p" size="md">
					Add a trustline to an official Stellar asset — and authorize it in one
					step where required.
				</Text>
			</div>

			<div className="AuthorizeTrustline__card">
				<Card>
					{!address ? (
						<div className="AuthorizeTrustline__connect">
							<Text as="p" size="md">
								Connect your wallet to get started.
							</Text>
							<Button
								variant="primary"
								size="lg"
								onClick={() => void connectWallet()}
							>
								<Icon.Wallet02 />
								Connect Wallet
							</Button>
						</div>
					) : (
						<>
							{isWrongNetwork && (
								<div className="AuthorizeTrustline__result AuthorizeTrustline__result--error">
									<Icon.AlertTriangle />
									<Text as="p" size="md">
										Your wallet is on the wrong network. Switch it to match the
										app, then reconnect.
									</Text>
								</div>
							)}

							<AssetSelector
								assets={assets}
								selected={selected}
								onSelect={setSelected}
							/>

							{selected && (
								<>
									<Input
										id="account"
										fieldSize="lg"
										label="Account address"
										placeholder="G..."
										value={account}
										onChange={(e) => setAccount(e.target.value)}
									/>
									{account !== address && (
										<Button
											variant="tertiary"
											size="sm"
											onClick={() => setAccount(address)}
										>
											Use my address
										</Button>
									)}

									<div className="AuthorizeTrustline__actions">
										{canOneStep && (
											<Button
												variant="primary"
												size="lg"
												disabled={
													ob.oneStep.status === "loading" || ob.checking
												}
												onClick={() => void ob.runOneStep()}
											>
												{ob.oneStep.status === "loading"
													? "Onboarding..."
													: `Add & Authorize ${selected.code} (1 signature)`}
											</Button>
										)}
										<Button
											variant={canOneStep ? "secondary" : "primary"}
											size="lg"
											disabled={
												ob.classic.status === "loading" ||
												ob.hasTrustline ||
												ob.checking
											}
											onClick={() => void ob.runClassic()}
										>
											{ob.hasTrustline
												? "Trustline Added"
												: ob.classic.status === "loading"
													? "Adding..."
													: `Add ${selected.code} Trustline`}
										</Button>
										{isPermissioned && selected.authorizer && (
											<Button
												variant="secondary"
												size="lg"
												disabled={
													ob.authorize.status === "loading" ||
													!account.trim() ||
													ob.isAuthorized ||
													ob.checking
												}
												onClick={() => void ob.runAuthorize(account.trim())}
											>
												{ob.isAuthorized
													? "Already Authorized"
													: ob.authorize.status === "loading"
														? "Authorizing..."
														: "Authorize Trustline"}
											</Button>
										)}
									</div>

									{!ob.checking &&
									ob.hasTrustline &&
									(isPermissioned ? ob.isAuthorized : true) ? (
										<div className="AuthorizeTrustline__result AuthorizeTrustline__result--success">
											<Icon.CheckCircle />
											<div>
												<Text as="p" size="md">
													{isPermissioned
														? `This account has an authorized ${selected.code} trustline.`
														: `This account holds a ${selected.code} trustline.`}
												</Text>
												{explorer && (
													<a
														href={`https://stellar.expert/explorer/${explorer}/account/${account.trim()}`}
														target="_blank"
														rel="noopener noreferrer"
														style={{ fontSize: "0.875rem" }}
													>
														View on Stellar Expert
													</a>
												)}
											</div>
										</div>
									) : (
										<Text
											as="p"
											size="sm"
											style={{ marginTop: "0.75rem", opacity: 0.6 }}
										>
											{selected.capability === "open"
												? `Add the ${selected.code} trustline — it's usable immediately.`
												: selected.capability === "permissionedManual"
													? `Add the trustline, then the issuer must approve it before you can hold ${selected.code}.`
													: `One step adds & authorizes ${selected.code}; or add the trustline then authorize it.`}
										</Text>
									)}
								</>
							)}
						</>
					)}

					<FlowResult
						label={`${selected?.code ?? "Asset"} trustline added successfully.`}
						state={ob.classic}
					/>
					<FlowResult
						label="Trustline authorized successfully."
						state={ob.authorize}
					/>
					<FlowResult
						label="Trustline added and authorized in one step."
						state={ob.oneStep}
					/>
				</Card>
			</div>
		</div>
	)
}

const FlowResult = ({
	label,
	state,
}: {
	label: string
	state: { status: string; error: string }
}) => {
	if (state.status === "success") {
		return (
			<div className="AuthorizeTrustline__result AuthorizeTrustline__result--success">
				<Icon.CheckCircle />
				<Text as="p" size="md">
					{label}
				</Text>
			</div>
		)
	}
	if (state.status === "error") {
		return (
			<div className="AuthorizeTrustline__result AuthorizeTrustline__result--error">
				<Icon.XCircle />
				<Text as="p" size="md">
					{state.error}
				</Text>
			</div>
		)
	}
	return null
}
```

- [ ] **Step 2: Verify typecheck + lint pass**

Run: `npm run typecheck && npm run lint` Expected: PASS. Resolve any
`@stellar/design-system` prop mismatches surfaced by typecheck.

- [ ] **Step 3: Commit**

```bash
git add src/components/AuthorizeTrustline.tsx
git commit -m "feat(ui): drive onboarding from the asset registry, per-capability flows"
```

---

## Task 7: Remove single-asset singletons from `util.ts`

**Files:**

- Modify: `src/contracts/util.ts`

- [ ] **Step 1: Confirm nothing else imports the singletons being removed**

Run:

```bash
grep -rn "assetCode\|assetIssuer\|assetSacContractId" src --include='*.ts' --include='*.tsx'
```

Expected: no matches outside `src/contracts/util.ts` itself (the component now
uses the registry). If any remain, fix them before continuing.

- [ ] **Step 2: Remove the three singletons**

In `src/contracts/util.ts`, delete these exported lines (keep everything else —
`stellarNetwork`, `networkPassphrase`, `rpcUrl`, `horizonUrl`,
`trustlineOnboardContractId`, and `eurcvAuthContractId`, which the generated
`eurcv_auth.ts` binding still imports):

```ts
export const assetCode = env.PUBLIC_TEST_ASSET_CODE ?? "EURCV"
export const assetIssuer = env.PUBLIC_TEST_ASSET_ISSUER ?? MAINNET_EURCV_ISSUER
export const assetSacContractId = env.PUBLIC_TEST_SAC
```

Also remove the now-unused `MAINNET_EURCV_ISSUER` constant. Keep
`MAINNET_EURCV_AUTH` / `eurcvAuthContractId` (consumed by `eurcv_auth.ts`), and
add a one-line comment above them:
`// Source of truth for asset data is now src/contracts/assets.ts; these remain only for the legacy generated eurcv_auth binding.`

- [ ] **Step 3: Verify the whole app builds**

Run: `npm run typecheck && npm run build` Expected: PASS — production build
completes with no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/contracts/util.ts
git commit -m "refactor(util): registry is now source of truth for asset data"
```

---

## Task 8: Final verification + commit the design docs

**Files:**

- (verification only) + commit `docs/superpowers/specs/...` and this plan.

- [ ] **Step 1: Full contract test suite**

Run: `cargo test` Expected: PASS — all crates green (trustline-onboard 3 tests,
authorizer-stub 1 test, guess-the-number).

- [ ] **Step 2: Full frontend gate**

Run: `npm run typecheck && npm run lint && npm run build` Expected: PASS on all
three.

- [ ] **Step 3: Manual smoke (local/testnet)**

Start the dev server (`npm run dev`), connect a wallet, and confirm: the asset
list renders USDC/EURC/EURCV (on PUBLIC) or the test asset (on TESTNET);
selecting an `open` asset shows only "Add trustline"; selecting EURCV shows the
one-step + classic + authorize buttons and the clawback warning. (Document the
result; do not submit a real mainnet tx unless intended.)

- [ ] **Step 4: Commit the design docs**

```bash
git add docs/superpowers/specs/2026-06-04-multi-asset-onboarding-design.md docs/superpowers/plans/2026-06-04-multi-asset-onboarding.md
git commit -m "docs: multi-asset onboarding spec + implementation plan"
```

---

## Done criteria

- `cargo test` and `npm run typecheck && npm run lint && npm run build` all
  pass.
- Asset list is registry-driven, issuer-pinned, with strkey validation at load.
- `open` assets do changeTrust only; EURCV (`permissionedOneStep`) does
  one-step + classic + authorize, with a clawback warning.
- The `onboard` contract is renamed (generic) and reverts `NotAuthorized` if the
  holder isn't authorized on the trusted SAC after the authorize call.
- The ~43 orthogonal review findings remain for the stacked cleanup PR.

```

```
