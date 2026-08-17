# Onboard Router with On-Chain Capability Discovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two client-side onboarding paths (open → `SAC.trust`,
permissioned → `onboard(sac, authorizer, holder)`) with a single router contract
method `onboard(sac, holder)` that discovers the asset's capability on-chain
(CAP-68 `get_address_executable` + `SAC.admin()`), and rewire the SDK, dApp,
e2e, and SEP draft around it.

**Architecture:** A stateless singleton router per network. It verifies `sac` is
a built-in SAC, runs CAP-73 `trust(holder)` (idempotent), and — when the
trustline is still unauthorized — probes whether `sac.admin()` is a wasm
contract exporting `authorize_trustline`. Typed contract errors from the probe
mean _rejected_ (revert everything); untyped aborts mean _no one-step interface_
(`TrustlineOnly`). The SDK builds one transaction shape; the registry pins
SACs + router ids.

**Tech Stack:** soroban-sdk 26 (Rust, `wasm32v1-none`), `@stellar/stellar-sdk`
14.5, Vite 7 + React 19, Vitest 3, Playwright, stellar CLI.

**Spec:**
`docs/superpowers/specs/2026-06-09-onboard-router-runtime-discovery-design.md`
**Branch:** `feat/usdc-open-asset-e2e` (PR #16, pivoted in place)

**Conventions for every task:** run commands from the repo root
`/home/willem/c/s/stellar_trustline`. Commits run lint-staged (eslint +
prettier) automatically — if a commit rewrites files, that is expected. Testnet
ids used throughout:

| Thing                                 | Id                                                         |
| ------------------------------------- | ---------------------------------------------------------- |
| Testnet USDC issuer                   | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` |
| Testnet USDC SAC                      | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |
| TLO issuer (AUTH_REQUIRED test asset) | `GATBENNAFELDD6XLFPIMT3GBYAGWT4A7XY45P4YCFVPK2HHRNC2HQJ4U` |
| TLO SAC                               | `CDVVAQAQ4FKQ4DCPPIIOIAOPRJJBO6HVOXRQX3PXONJVJNNK432O6HW3` |
| TLO authorizer (= TLO SAC admin)      | `CD7K7S43HSIR2DLGDT5OWSHDJQIQWFAJWZOIO66T2OVMLNYFL74OK2KU` |

---

### Task 1: Spike — verify try-call classification + `executable()` semantics in the native test env

The router's design rests on four mechanical assumptions about the soroban-sdk
26 **native** test environment. Verify them FIRST, as permanent tests, before
building on them. If any assertion fails, STOP and report (the router's match
arms depend on the answers).

**Files:**

- Modify: `contracts/trustline-onboard/src/test.rs` (append a new module; do not
  touch existing tests yet)

- [ ] **Step 1: Append the spike module to
      `contracts/trustline-onboard/src/test.rs`**

Append at the end of the file:

```rust
// ── Environment-semantics spike ──────────────────────────────────────────
// The 2-arg discovery router depends on these soroban-sdk 26 behaviors. They
// are kept as permanent tests so an SDK upgrade that changes them fails HERE,
// not in production classification.
mod classification {
    use super::*;
    use soroban_sdk::xdr::ScErrorType;
    use soroban_sdk::{contract, contractimpl, Executable};

    // A contract that does NOT export `authorize_trustline`.
    #[contract]
    pub struct NoExportContract;

    #[contractimpl]
    impl NoExportContract {
        pub fn ping(_env: Env) {}
    }

    // An authorizer that panics (untyped) instead of returning a typed error.
    #[contract]
    pub struct PanickingAuthorizer;

    #[contractimpl]
    impl PanickingAuthorizer {
        pub fn authorize_trustline(_env: Env, _account: Address) {
            panic!("untyped failure");
        }
    }

    #[test]
    fn native_contracts_report_wasm_executable() {
        let env = Env::default();
        let c = env.register(NoExportContract, ());
        assert!(matches!(c.executable(), Some(Executable::Wasm(_))));
    }

    #[test]
    fn sac_reports_stellar_asset_executable() {
        let env = Env::default();
        let issuer = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(issuer);
        assert_eq!(sac.address().executable(), Some(Executable::StellarAsset));
    }

    #[test]
    fn generated_address_reports_none() {
        let env = Env::default();
        // Address::generate produces a contract id with NO deployed instance.
        assert_eq!(Address::generate(&env).executable(), None);
    }

    #[test]
    fn missing_export_is_recoverable_non_contract_error() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let holder = Address::generate(&env);
        let target = env.register(NoExportContract, ());
        let res = AuthorizerClient::new(&env, &target).try_authorize_trustline(&holder);
        // Recoverable (Err, not a test abort), and NOT a typed contract error.
        match res {
            Err(Ok(e)) => assert!(!e.is_type(ScErrorType::Contract)),
            Err(Err(_)) => {} // InvokeError::Abort — also "not typed": acceptable
            Ok(_) => panic!("call to a missing export must not succeed"),
        }
    }

    #[test]
    fn typed_error_is_contract_type() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let holder = Address::generate(&env);
        let target = env.register(FailingAuthorizer, ());
        let res = AuthorizerClient::new(&env, &target).try_authorize_trustline(&holder);
        match res {
            Err(Ok(e)) => assert!(e.is_type(ScErrorType::Contract)),
            other => panic!("expected a typed contract error, got {other:?}"),
        }
    }

    #[test]
    fn panic_is_recoverable_non_contract_error() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let holder = Address::generate(&env);
        let target = env.register(PanickingAuthorizer, ());
        let res = AuthorizerClient::new(&env, &target).try_authorize_trustline(&holder);
        match res {
            Err(Ok(e)) => assert!(!e.is_type(ScErrorType::Contract)),
            Err(Err(_)) => {}
            Ok(_) => panic!("a panicking authorizer must not report success"),
        }
    }
}
```

Note: `FailingAuthorizer` already exists in this test file (returns
`Err(Error::AuthorizationFailed)`); `AuthorizerClient` is generated in `lib.rs`.
`PanickingAuthorizer::authorize_trustline` deliberately matches the client's
arity, returning `()` — the panic fires before any return-type conversion
matters.

- [ ] **Step 2: Run the spike**

Run: `cargo test -p trustline-onboard classification -- --nocapture` Expected:
**6/6 PASS**. The panic test may print a captured panic backtrace — that is fine
as long as the test passes.

**If any test FAILS:** do not work around it silently. Report which assumption
broke (this changes the router's match arms / test strategy) and stop.

- [ ] **Step 3: Commit**

```bash
git add contracts/trustline-onboard/src/test.rs
git commit -m "test(onboard): spike — pin native-env try-call classification + CAP-68 executable semantics"
```

---

### Task 2: Router contract — `onboard(sac, holder)` with discovery

**Files:**

- Modify: `contracts/trustline-onboard/src/lib.rs` (full replacement below)
- Modify: `contracts/trustline-onboard/src/test.rs` (replace the existing 3-arg
  tests; keep stubs + the Task 1 `classification` module)

- [ ] **Step 1: Replace the existing scenario tests in `test.rs`**

Replace everything in `contracts/trustline-onboard/src/test.rs` ABOVE the
`mod classification` block (i.e. the old stubs + `setup` + the four old 3-arg
tests) with:

```rust
#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::testutils::{Address as _, IssuerFlags};
use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env};

// A correct authorizer: installed as the SAC admin, authorizes the account.
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

// An authorizer that always REJECTS with a typed contract error.
#[contract]
pub struct FailingAuthorizer;

#[contractimpl]
impl FailingAuthorizer {
    pub fn authorize_trustline(_env: Env, _account: Address) -> Result<(), Error> {
        Err(Error::AuthorizationRefused)
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

/// Register a SAC (optionally AUTH_REQUIRED) + the router. The SAC's initial
/// admin is a generated (instance-less) contract address; tests that need a
/// specific admin call `set_admin` themselves.
fn setup(env: &Env, auth_required: bool) -> (Address, Address) {
    let initial_admin = Address::generate(env);
    let sac = env.register_stellar_asset_contract_v2(initial_admin);
    if auth_required {
        sac.issuer().set_flag(IssuerFlags::RequiredFlag);
    }
    let router = env.register(TrustlineOnboard, ());
    (sac.address(), router)
}

#[test]
fn open_asset_onboards_to_authorized() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let holder = Address::generate(&env);
    let (sac, router) = setup(&env, false);

    let status = TrustlineOnboardClient::new(&env, &router).onboard(&sac, &holder);

    assert_eq!(status, OnboardStatus::Authorized);
    assert!(StellarAssetClient::new(&env, &sac).authorized(&holder));
}

#[test]
fn onboard_is_idempotent() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let holder = Address::generate(&env);
    let (sac, router) = setup(&env, false);
    let client = TrustlineOnboardClient::new(&env, &router);

    assert_eq!(client.onboard(&sac, &holder), OnboardStatus::Authorized);
    // Re-running is a no-op that still reports the truthful state.
    assert_eq!(client.onboard(&sac, &holder), OnboardStatus::Authorized);
}

#[test]
fn discovers_and_authorizes_via_admin_contract() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let holder = Address::generate(&env);
    let (sac, router) = setup(&env, true);

    let authorizer = env.register(StubAuthorizer, (sac.clone(),));
    StellarAssetClient::new(&env, &sac).set_admin(&authorizer);

    let status = TrustlineOnboardClient::new(&env, &router).onboard(&sac, &holder);

    assert_eq!(status, OnboardStatus::Authorized);
    assert!(StellarAssetClient::new(&env, &sac).authorized(&holder));
}

#[test]
fn typed_rejection_reverts_everything() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let holder = Address::generate(&env);
    let (sac, router) = setup(&env, true);

    let authorizer = env.register(FailingAuthorizer, ());
    StellarAssetClient::new(&env, &sac).set_admin(&authorizer);

    assert_eq!(
        TrustlineOnboardClient::new(&env, &router).try_onboard(&sac, &holder),
        Err(Ok(Error::AuthorizationRefused))
    );
    // The whole call (including trust) rolled back.
    assert!(!StellarAssetClient::new(&env, &sac).authorized(&holder));
}

#[test]
fn admin_without_export_yields_trustline_only() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let holder = Address::generate(&env);
    let (sac, router) = setup(&env, true);

    let admin = env.register(classification::NoExportContract, ());
    StellarAssetClient::new(&env, &sac).set_admin(&admin);

    let status = TrustlineOnboardClient::new(&env, &router).onboard(&sac, &holder);

    assert_eq!(status, OnboardStatus::TrustlineOnly);
    assert!(!StellarAssetClient::new(&env, &sac).authorized(&holder));
}

#[test]
fn panicking_authorizer_yields_trustline_only() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let holder = Address::generate(&env);
    let (sac, router) = setup(&env, true);

    let admin = env.register(classification::PanickingAuthorizer, ());
    StellarAssetClient::new(&env, &sac).set_admin(&admin);

    let status = TrustlineOnboardClient::new(&env, &router).onboard(&sac, &holder);

    assert_eq!(status, OnboardStatus::TrustlineOnly);
}

#[test]
fn noop_authorizer_fails_post_condition() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let holder = Address::generate(&env);
    let (sac, router) = setup(&env, true);

    let admin = env.register(NoopAuthorizer, ());
    StellarAssetClient::new(&env, &sac).set_admin(&admin);

    assert_eq!(
        TrustlineOnboardClient::new(&env, &router).try_onboard(&sac, &holder),
        Err(Ok(Error::NotAuthorized))
    );
}

#[test]
fn non_wasm_admin_yields_trustline_only() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let holder = Address::generate(&env);
    // Default admin from setup() is a generated, instance-less contract
    // address: executable() == None → same match arm as a G-account admin.
    let (sac, router) = setup(&env, true);

    let status = TrustlineOnboardClient::new(&env, &router).onboard(&sac, &holder);

    assert_eq!(status, OnboardStatus::TrustlineOnly);
}

#[test]
fn impostor_sac_is_rejected() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let holder = Address::generate(&env);
    let (_real_sac, router) = setup(&env, false);
    let client = TrustlineOnboardClient::new(&env, &router);

    // A wasm contract masquerading as a SAC…
    let impostor = env.register(classification::NoExportContract, ());
    assert_eq!(client.try_onboard(&impostor, &holder), Err(Ok(Error::NotSac)));
    // …and a nonexistent contract id.
    let ghost = Address::generate(&env);
    assert_eq!(client.try_onboard(&ghost, &holder), Err(Ok(Error::NotSac)));
}
```

Keep the `mod classification { … }` block from Task 1 below this, unchanged
except: make its two stub contracts reachable from the scenario tests by
declaring them `pub` (they already are in the Task 1 code).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p trustline-onboard 2>&1 | tail -20` Expected: **compile
error** — `OnboardStatus` does not exist and `onboard` still takes 3 args.

- [ ] **Step 3: Replace `contracts/trustline-onboard/src/lib.rs`**

Full new content:

```rust
#![no_std]
use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::xdr::ScErrorType;
use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, Address, Env, Executable,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// `sac` is not a built-in Stellar Asset Contract (CAP-68 check).
    NotSac = 1,
    /// CAP-73 `trust()` failed (reserve, missing account, native asset, …).
    TrustFailed = 2,
    /// The asset's authorizer (SAC admin) REJECTED the holder (typed error).
    AuthorizationRefused = 3,
    /// The authorizer reported success but the holder is not authorized.
    NotAuthorized = 4,
}

/// Outcome of `onboard`, reported truthfully from on-chain state.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum OnboardStatus {
    /// Trustline exists and is authorized — the holder can receive the asset.
    Authorized,
    /// Trustline exists but is not authorized: the asset is AUTH_REQUIRED and
    /// its SAC admin offers no one-step `authorize_trustline` interface — the
    /// issuer authorizes off-platform (manual path).
    TrustlineOnly,
}

/// SEP interface: a one-step authorizer is the SAC admin exposing this.
/// Rejections MUST be typed contract errors — an untyped abort is read as
/// "interface absent", never as a rejection.
#[contractclient(name = "AuthorizerClient")]
pub trait Authorizer {
    fn authorize_trustline(env: Env, account: Address) -> Result<(), soroban_sdk::Error>;
}

#[contract]
pub struct TrustlineOnboard;

#[contractimpl]
impl TrustlineOnboard {
    /// Create the holder's trustline and, when the asset's SAC admin is a
    /// contract exposing `authorize_trustline`, authorize it — all under one
    /// holder signature. The asset's capability is DISCOVERED on-chain
    /// (CAP-68 `get_address_executable` + `SAC.admin()`), not configured.
    ///
    /// Returns `Authorized` when the trustline is usable, `TrustlineOnly`
    /// when the asset is AUTH_REQUIRED with no one-step authorizer (the
    /// trustline is kept; the issuer authorizes off-platform).
    ///
    /// **Atomic on rejection:** if the discovered authorizer rejects the
    /// holder with a typed contract error, the WHOLE transaction (including
    /// the trustline creation) is rolled back.
    ///
    /// **Immutable by design:** no admin or upgrade entrypoint; fixing a bug
    /// means deploying a new instance and updating the pinned router id.
    pub fn onboard(env: Env, sac: Address, holder: Address) -> Result<OnboardStatus, Error> {
        holder.require_auth();

        // Anti-copycat, on-chain: only a built-in SAC has classic trustlines.
        if !matches!(sac.executable(), Some(Executable::StellarAsset)) {
            return Err(Error::NotSac);
        }
        let sac_client = StellarAssetClient::new(&env, &sac);

        // CAP-73: create the trustline if needed (silent no-op when it
        // already exists; created UNauthorized for an AUTH_REQUIRED issuer).
        sac_client
            .try_trust(&holder)
            .map_err(|_| Error::TrustFailed)?
            .map_err(|_| Error::TrustFailed)?;

        // Open asset, or already authorized: done.
        if sac_client.authorized(&holder) {
            return Ok(OnboardStatus::Authorized);
        }

        // Discover the one-step capability from the only address the
        // protocol allows to authorize: the SAC admin. A non-wasm admin
        // (G-account, SAC, nonexistent) cannot expose the interface.
        let admin = sac_client.admin();
        if !matches!(admin.executable(), Some(Executable::Wasm(_))) {
            return Ok(OnboardStatus::TrustlineOnly);
        }
        match AuthorizerClient::new(&env, &admin).try_authorize_trustline(&holder) {
            // Post-condition: the authorizer must have authorized the holder
            // on THIS sac — guards a no-op or divergent authorizer.
            Ok(_) => {
                if sac_client.authorized(&holder) {
                    Ok(OnboardStatus::Authorized)
                } else {
                    Err(Error::NotAuthorized)
                }
            }
            // A typed contract error is a REJECTION (SEP rule) — revert
            // everything, including the trustline.
            Err(Ok(e)) if e.is_type(ScErrorType::Contract) => Err(Error::AuthorizationRefused),
            Err(Err(soroban_sdk::InvokeError::Contract(_))) => Err(Error::AuthorizationRefused),
            // Anything else (squashed Context/InvalidAction abort: missing
            // export or an untyped panic) means "no authorize_trustline
            // interface": keep the trustline and report it truthfully.
            Err(_) => Ok(OnboardStatus::TrustlineOnly),
        }
    }
}

mod test;
```

- [ ] **Step 4: Run the contract tests**

Run: `cargo test -p trustline-onboard` Expected: **15/15 PASS** (9 scenario + 6
classification).

- [ ] **Step 5: Verify the wasm build**

Run: `cargo build --release --target wasm32v1-none -p trustline-onboard`
Expected: success; artifact at
`target/wasm32v1-none/release/trustline_onboard.wasm`.

- [ ] **Step 6: Commit**

```bash
git add contracts/trustline-onboard/src/lib.rs contracts/trustline-onboard/src/test.rs
git commit -m "feat(onboard)!: 2-arg onboard(sac, holder) router with on-chain capability discovery"
```

---

### Task 3: SDK — one builder, `router` config field, old paths deleted

**Files:**

- Modify: `packages/authline-sdk/src/index.ts` (OnboarderConfig + exports +
  selectBackend)
- Modify: `packages/authline-sdk/src/onboard.ts` (rewrite; delete
  `buildTrustTx`)
- Modify: `packages/authline-sdk/src/onboard.test.ts` (rewrite)
- Modify: `packages/authline-sdk/src/discovery.ts` (`ONBOARD_WRAPPER` →
  `router`)
- Modify: `packages/authline-sdk/src/exchange.ts` (guard for now-optional
  `authorizer`)
- Modify: `packages/authline-sdk/src/registry.ts` (add `ROUTERS` scaffold)

- [ ] **Step 1: Rewrite `packages/authline-sdk/src/onboard.test.ts`**

Replace the whole file with:

```ts
import {
	Address,
	Networks,
	type Operation,
	TransactionBuilder,
} from "@stellar/stellar-sdk"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { OnboarderConfig } from "./index.js"

const HOLDER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
const SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
// Any valid C-address works for the router in this offline test.
const ROUTER = "CD7K7S43HSIR2DLGDT5OWSHDJQIQWFAJWZOIO66T2OVMLNYFL74OK2KU"

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

const config: OnboarderConfig = {
	assetCode: "USDC",
	assetIssuer: HOLDER,
	sac: SAC,
	router: ROUTER,
	backends: ["cap73-one-signature"],
}
const opts = {
	rpcUrl: "https://soroban-testnet.stellar.org",
	networkPassphrase: Networks.TESTNET,
	holder: HOLDER,
	config,
}

describe("buildOnboardTx (router)", () => {
	afterEach(() => vi.clearAllMocks())

	it("builds a single router.onboard(sac, holder) invocation", async () => {
		const { buildOnboardTx } = await import("./onboard.js")
		const xdr = await buildOnboardTx({ ...opts, allowHttp: false })
		const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET)
		expect(tx.operations).toHaveLength(1)
		const op = tx.operations[0] as Operation.InvokeHostFunction
		expect(op.type).toBe("invokeHostFunction")
		const call = op.func.invokeContract()
		expect(Address.fromScAddress(call.contractAddress()).toString()).toBe(
			ROUTER,
		)
		expect(call.functionName().toString()).toBe("onboard")
		expect(call.args()).toHaveLength(2)
		expect(Address.fromScVal(call.args()[0]).toString()).toBe(SAC)
		expect(Address.fromScVal(call.args()[1]).toString()).toBe(HOLDER)
	})

	it("throws when config.router is missing", async () => {
		const { buildOnboardTx } = await import("./onboard.js")
		await expect(
			buildOnboardTx({ ...opts, config: { ...config, router: "" } }),
		).rejects.toThrow(/config.router is required/)
	})

	it("throws when config.sac is missing", async () => {
		const { buildOnboardTx } = await import("./onboard.js")
		await expect(
			buildOnboardTx({ ...opts, config: { ...config, sac: "" } }),
		).rejects.toThrow(/config.sac is required/)
	})
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/authline-sdk/src/onboard.test.ts` Expected: FAIL
(old `buildOnboardTx` requires `authorizer`/`onboard`; type errors on `router`).

- [ ] **Step 3: Update `OnboarderConfig` + `selectBackend` in
      `packages/authline-sdk/src/index.ts`**

Replace the `OnboarderConfig` interface with:

```ts
/** Resolved onboarder configuration for a single asset. */
export interface OnboarderConfig {
	/** Classic asset code, e.g. "EURCV". */
	assetCode: string
	/** Classic asset issuer (G...). */
	assetIssuer: string
	/** The asset's Stellar Asset Contract (C...). */
	sac: string
	/**
	 * The Authline onboard ROUTER contract (C...) — the single entry point
	 * `onboard(sac, holder)`. Required for the one-signature path; pinned per
	 * network in `ROUTERS`.
	 */
	router?: string
	/**
	 * The asset's authorizer — the SAC admin (C...). INFORMATIONAL for the
	 * one-signature path (the router discovers it on-chain from `SAC.admin()`);
	 * required only for the zero-signature Case-A `buildAuthorizeTx`.
	 */
	authorizer?: string
	/** Backends the issuer supports, in preference order. */
	backends: Backend[]
}
```

In the `export { … } from "./onboard.js"` block, delete `buildTrustTx` and
`type BuildTrustOptions`. Add `ROUTERS` to the `./registry.js` export block.
Replace `selectBackend` with:

```ts
/**
 * Pick the backend to use for a given holder. The CAP-73 one-signature path
 * is preferred when the router is known and the holder already has a funded,
 * on-ledger account (CAP-73 `trust()` has no sponsorship — the holder pays
 * the trustline reserve). Otherwise fall back to the CAP-33 sponsored path.
 */
export function selectBackend(
	config: { router?: string; backends: Backend[] },
	holder: { exists: boolean; fundedForReserve: boolean },
): Backend {
	const canOneSig =
		!!config.router &&
		config.backends.includes("cap73-one-signature") &&
		holder.exists &&
		holder.fundedForReserve
	if (canOneSig) return "cap73-one-signature"
	return "cap33-sponsored"
}
```

Also update the module doc comment's "build the right transaction for the asset
class" sentence to: "build the single router transaction —
`onboard(sac, holder)` discovers the asset class on-chain — and check activation
status."

- [ ] **Step 4: Rewrite `packages/authline-sdk/src/onboard.ts`**

Replace the whole file with:

```ts
import {
	Address,
	BASE_FEE,
	Contract,
	TransactionBuilder,
	rpc,
} from "@stellar/stellar-sdk"
import { type OnboarderConfig } from "./index.js"

/**
 * Allow cleartext http only for a local RPC (localhost / 127.0.0.1) unless the
 * caller explicitly overrides `allowHttp`. Keeps the secure default for remote
 * RPC while letting local/standalone dev (http RPC) work without a footgun.
 */
export function defaultAllowHttp(rpcUrl: string): boolean {
	try {
		const h = new URL(rpcUrl).hostname
		return h === "localhost" || h === "127.0.0.1"
	} catch {
		return false
	}
}

export interface BuildOnboardOptions {
	/** Soroban RPC URL. */
	rpcUrl: string
	/** Network passphrase (mainnet / testnet). */
	networkPassphrase: string
	/** The holder's account (G...), who signs the single resulting transaction. */
	holder: string
	/** Resolved onboarder config. Must include `sac` and `router`. */
	config: OnboarderConfig
	allowHttp?: boolean
}

/**
 * Build the **one-signature** onboarding transaction. The returned base64 XDR
 * is unsigned: hand it to the wallet (e.g. Stellar Wallets Kit) for the holder
 * to sign, then submit via Soroban RPC.
 *
 * On-chain this invokes the Authline router's `onboard(sac, holder)`, which
 * runs CAP-73 `SAC.trust(holder)` and then DISCOVERS the asset's capability
 * from `SAC.admin()` (CAP-68): an admin contract exposing
 * `authorize_trustline` authorizes the line in the same transaction; an asset
 * with no one-step authorizer keeps the trustline and reports `TrustlineOnly`.
 * There is no open-vs-regulated branching on the client.
 *
 * Note: CAP-73 `trust()` has no sponsorship — the holder must control a
 * funded, on-ledger account that can cover the 0.5 XLM trustline reserve. For
 * a brand-new or under-funded account, use the CAP-33 sponsored path instead.
 *
 * SECURITY: `config.sac` is the contract the holder's trustline is created
 * against, and `config.router` is what the holder authorizes in one
 * signature. If `config` originated from `discoverOnboarder` (an untrusted
 * stellar.toml), it MUST be reconciled against the pinned registry first —
 * pass `network` to `discoverOnboarder` or call `reconcileWithRegistry` —
 * and the router SHOULD be the pinned `ROUTERS` id, never an advertised one.
 */
export async function buildOnboardTx(
	opts: BuildOnboardOptions,
): Promise<string> {
	if (!opts.config.sac) {
		throw new Error("config.sac is required to build the onboard transaction")
	}
	if (!opts.config.router) {
		throw new Error(
			"config.router is required — the Authline onboard router id for this " +
				"network (pin it via ROUTERS or PUBLIC_ROUTER)",
		)
	}
	const server = new rpc.Server(opts.rpcUrl, {
		allowHttp: opts.allowHttp ?? defaultAllowHttp(opts.rpcUrl),
	})
	const source = await server.getAccount(opts.holder)

	const router = new Contract(opts.config.router)
	const op = router.call(
		"onboard",
		new Address(opts.config.sac).toScVal(),
		new Address(opts.holder).toScVal(),
	)

	const tx = new TransactionBuilder(source, {
		fee: BASE_FEE,
		networkPassphrase: opts.networkPassphrase,
	})
		.addOperation(op)
		.setTimeout(180)
		.build()

	// Simulate + assemble footprint/resource fees so the tx is submit-ready.
	const prepared = await server.prepareTransaction(tx)
	return prepared.toXDR()
}
```

- [ ] **Step 5: Update `packages/authline-sdk/src/discovery.ts`**

Three edits:

1. In `parseOnboarderToml`, rename the local binding and returned field
   (`ONBOARD_WRAPPER` stays the wire name; legacy `ONBOARD` alias kept):

```ts
// SEP §6 field is ONBOARD_WRAPPER (the onboard router); accept legacy
// ONBOARD as an alias.
const router = str(block, "ONBOARD_WRAPPER") || str(block, "ONBOARD")
```

and in the validation block:

```ts
if (router && !StrKey.isValidContract(router))
	throw new Error(
		`[TRUSTLINE_ONBOARDER]: ONBOARD_WRAPPER is not a valid C-address: ${router}`,
	)
```

and in the returned object replace `onboard: onboard || undefined,` with:

```ts
		router: router || undefined,
```

2. In the `discoverOnboarder` doc comment, change the example block's
   `ONBOARD_WRAPPER = "C..."     # one-signature CAP-73 wrapper` comment to
   `# the Authline onboard router` and the `AUTHORIZER` comment to
   `# informational (the router discovers the admin on-chain)`.

3. `authorizer` handling is unchanged (already optional in the parser).

- [ ] **Step 6: Guard the now-optional `authorizer` in
      `packages/authline-sdk/src/exchange.ts`**

Find `buildAuthorizeTx` (the `new Contract(opts.config.authorizer)` near line
46). Immediately before that line, add:

```ts
if (!opts.config.authorizer) {
	throw new Error(
		"config.authorizer is required for authorize-on-behalf (Case A) — " +
			"it is the asset's SAC admin",
	)
}
```

(If the surrounding function already validates other fields, put the guard
alongside them. The point is: `authorizer` is `string | undefined` now, and
`new Contract(undefined)` must be unreachable.)

- [ ] **Step 7: Add the `ROUTERS` scaffold to
      `packages/authline-sdk/src/registry.ts`**

After the `OFFICIAL_ASSETS.forEach(validateOfficialAsset)` line, add:

```ts
/**
 * Pinned Authline onboard-router ids per network — the deploy-once, stateless
 * singleton exposing `onboard(sac, holder)`. PINNED like the assets above
 * (never resolved from an advertised source). TESTNET is filled by the
 * deployment task; PUBLIC is added when the mainnet router ships. Future:
 * resolve via the on-chain stellar-registry instead.
 */
export const ROUTERS: Partial<Record<StellarNet, string>> = {}

// Fail fast at module load if a pinned router id is malformed.
Object.values(ROUTERS).forEach((id) => {
	if (!StrKey.isValidContract(id))
		throw new Error(`registry: pinned router is not a valid C-address: ${id}`)
})
```

- [ ] **Step 8: Run the SDK unit tests + gates**

Run: `npx vitest run packages/authline-sdk` Expected: PASS (onboard 3, registry
5, discovery/exchange tests if present). Run:
`npm run typecheck && npm run lint` Expected: clean — EXCEPT `src/authline.tsx`
and `src/config.ts` will now fail typecheck (they still import `buildTrustTx` /
use `onboard`). **If they fail for exactly those reasons, that is expected** —
fix lands in Task 5. To keep this task's commit green in isolation, run instead:
`npx tsc --noEmit -p packages/authline-sdk 2>/dev/null || npx vitest run packages/authline-sdk`
and rely on the Task 5 gate for the app. (If the repo has no per-package
tsconfig, just note the two expected app-side errors and proceed.)

- [ ] **Step 9: Commit**

```bash
git add packages/authline-sdk/src
git commit -m "feat(sdk)!: buildOnboardTx targets the discovery router; drop buildTrustTx; onboard->router"
```

---

### Task 4: Deploy the router to testnet; pin the id

Network access required (testnet RPC + friendbot + GitHub-independent). Run
commands outside the sandbox if it blocks them.

**Files:**

- Modify: `packages/authline-sdk/src/registry.ts` (fill `ROUTERS.TESTNET`)
- Modify: `packages/authline-sdk/src/registry.test.ts` (router assertions)
- Modify: `.env.e2e` (add `PUBLIC_ROUTER`)

- [ ] **Step 1: Build the wasm**

Run: `cargo build --release --target wasm32v1-none -p trustline-onboard`
Expected: `target/wasm32v1-none/release/trustline_onboard.wasm` exists.

- [ ] **Step 2: Create + fund a deployer key, deploy**

```bash
stellar keys generate router-deployer --network testnet --fund 2>/dev/null || true
stellar contract deploy \
  --wasm target/wasm32v1-none/release/trustline_onboard.wasm \
  --source-account router-deployer \
  --network testnet
```

Expected: prints a `C…` contract id. Call it `<ROUTER_ID>` below. (If `--fund`
is unsupported by the installed CLI version, fund via
`curl "https://friendbot.stellar.org/?addr=$(stellar keys address router-deployer)"`.)

- [ ] **Step 3: Pin the id**

In `packages/authline-sdk/src/registry.ts`, change the `ROUTERS` initializer:

```ts
export const ROUTERS: Partial<Record<StellarNet, string>> = {
	// Deployed from contracts/trustline-onboard @ <git SHA of Task 2 commit>,
	// verified on-chain <today's date>.
	TESTNET: "<ROUTER_ID>",
}
```

In `.env.e2e`, append:

```
PUBLIC_ROUTER="<ROUTER_ID>"
```

- [ ] **Step 4: Add registry tests**

Append to `packages/authline-sdk/src/registry.test.ts` (inside the existing
`describe("registry", …)`), importing `ROUTERS` in the import block:

```ts
it("pins a valid testnet router id", () => {
	expect(ROUTERS.TESTNET).toMatch(/^C[A-Z2-7]{55}$/)
})
```

- [ ] **Step 5: Smoke-verify on-chain (read-only)**

```bash
stellar contract info interface --id <ROUTER_ID> --network testnet | head -30
```

Expected: the interface lists `onboard` with `sac: address, holder: address`
returning `result<OnboardStatus, Error>`-shaped types.

- [ ] **Step 6: Run tests + commit**

Run: `npx vitest run packages/authline-sdk/src/registry.test.ts` Expected: PASS.

```bash
git add packages/authline-sdk/src/registry.ts packages/authline-sdk/src/registry.test.ts .env.e2e
git commit -m "chore(registry): pin testnet onboard-router id + wire PUBLIC_ROUTER for e2e"
```

---

### Task 5: Frontend — single-path `activate()`, router wiring

**Files:**

- Modify: `src/config.ts`
- Modify: `src/config.test.ts`
- Modify: `src/authline.tsx`

- [ ] **Step 1: Extend `src/config.test.ts` (failing first)**

In the existing test `resolves USDC as the live, open asset on testnet`, add
after the `ASSET.authorizer` assertion:

```ts
// Router comes from the pinned registry when PUBLIC_ROUTER is unset.
const { ROUTERS } = await import("@theahaco/authline")
expect(ASSET.router).toBe(ROUTERS.TESTNET)
```

And add a second test in the same describe:

```ts
it("prefers PUBLIC_ROUTER over the pinned router", async () => {
	vi.stubEnv("PUBLIC_ASSET_CODE", "USDC")
	vi.stubEnv("PUBLIC_ASSET_ISSUER", TESTNET_USDC_ISSUER)
	vi.stubEnv(
		"PUBLIC_STELLAR_NETWORK_PASSPHRASE",
		"Test SDF Network ; September 2015",
	)
	vi.stubEnv(
		"PUBLIC_ROUTER",
		"CD7K7S43HSIR2DLGDT5OWSHDJQIQWFAJWZOIO66T2OVMLNYFL74OK2KU",
	)
	const { ASSET } = await import("./config")
	expect(ASSET.router).toBe(
		"CD7K7S43HSIR2DLGDT5OWSHDJQIQWFAJWZOIO66T2OVMLNYFL74OK2KU",
	)
})
```

Run: `npx vitest run src/config.test.ts` — Expected: FAIL (no `router` on
`ASSET`).

- [ ] **Step 2: Update `src/config.ts`**

1. Import `ROUTERS` from `@theahaco/authline` (add to the existing import).
2. Hoist the network tag so both the registry lookup and routers use it (replace
   the inline `netFromPassphrase(...)` arg):

```ts
const NET_TAG = netFromPassphrase(NETWORK.passphrase)
const pinned = resolveOfficialAsset(CODE, NET_TAG)
```

3. In the `ASSET` literal, replace `onboard: import.meta.env.PUBLIC_ONBOARD,`
   with:

```ts
	router: import.meta.env.PUBLIC_ROUTER ?? ROUTERS[NET_TAG] ?? "",
```

4. Replace the `warnIfInvalid("ONBOARD", import.meta.env.PUBLIC_ONBOARD, "C")`
   line with:

```ts
warnIfInvalid("ROUTER", import.meta.env.PUBLIC_ROUTER, "C")
```

5. Replace the whole `permissionedOneStep`-missing-ids `console.error` block
   (the `if (ASSET.capability === "permissionedOneStep" && …)` statement) with:

```ts
// Every activation flows through the router (which discovers the asset's
// capability on-chain) — a missing router id means activation cannot build
// transactions at all. Surface that loudly here instead of failing deep
// inside transaction building.
if (!ASSET.router)
	console.error(
		`[config] no onboard router configured for ${NETWORK_LABEL} — ` +
			"set PUBLIC_ROUTER or pin it in the SDK's ROUTERS.",
	)
```

6. `authorizer` wiring stays as-is (display/Case-A only).

- [ ] **Step 3: Update `src/authline.tsx`**

1. Remove `buildTrustTx` from the `@theahaco/authline` import.
2. Replace the `IS_OPEN` line with (capability is now authoritative — authorizer
   presence no longer implies anything):

```ts
// Capability-aware copy: an OPEN asset only needs its trustline CREATED. The
// transaction shape is identical either way (the router discovers capability
// on-chain); this drives COPY only.
const IS_OPEN = ASSET.capability === "open"
```

3. In `activate()`, replace the
   `const xdr = IS_OPEN ? await buildTrustTx({…}) : await buildOnboardTx({…})`
   ternary with the single call:

```ts
const xdr = await buildOnboardTx({
	rpcUrl: NETWORK.rpcUrl,
	networkPassphrase: NETWORK.passphrase,
	holder: address,
	config: ASSET,
	allowHttp: NETWORK.allowHttp,
})
```

Nothing else changes — `Activate {ASSET.assetCode} · 1 signature` and
`{ASSET.assetCode} trustline authorized` are e2e-asserted strings; keep them.

- [ ] **Step 4: Sweep stale `PUBLIC_ONBOARD` references**

Run:
`grep -rn "PUBLIC_ONBOARD" --include="*.ts" --include="*.tsx" --include="*.yml" --include="*.example" src .github .env* 2>/dev/null`
Expected after the config.ts edit: no hits (if `.env.example` or a workflow sets
it, rename to `PUBLIC_ROUTER`).

- [ ] **Step 5: Run the gates**

Run: `npm run typecheck && npm run lint && npx vitest run && npm run build`
Expected: all clean, all tests pass (the Task 3 app-side typecheck failures are
now gone).

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/config.test.ts src/authline.tsx
git commit -m "feat(app)!: single-path activate() via the discovery router; PUBLIC_ROUTER wiring"
```

---

### Task 6: e2e — USDC through the router + TLO discovery path

**Files:**

- Modify: `tests/e2e/testnet-usdc.e2e.test.ts`
- Create: `tests/e2e/testnet-tlo.e2e.test.ts`

- [ ] **Step 1: Rewrite `tests/e2e/testnet-usdc.e2e.test.ts` to the router
      path**

Apply these edits (the file otherwise stays as-is — friendbot funding, SAC
deploy guard, polling loop, status assertion all survive):

1. Import change: `buildTrustTx` → `buildOnboardTx`, and add `ROUTERS`:

```ts
import {
	ROUTERS,
	buildOnboardTx,
	getActivationStatus,
	type OnboarderConfig,
} from "@theahaco/authline"
```

2. `CONFIG` gains the router (env override first, pinned fallback):

```ts
const CONFIG: OnboarderConfig = {
	assetCode: "USDC",
	assetIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
	sac: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
	router: process.env.PUBLIC_ROUTER ?? ROUTERS.TESTNET,
	backends: ["cap73-one-signature"],
}
```

3. Rename the describe to `"testnet USDC onboard via router (real chain)"`, the
   test to `"creates an authorized USDC trustline via router.onboard"`, and the
   build call to `buildOnboardTx({ … })` (same args object).

- [ ] **Step 2: Create `tests/e2e/testnet-tlo.e2e.test.ts` (the discovery
      path)**

```ts
import {
	Keypair,
	Networks,
	TransactionBuilder,
	rpc,
} from "@stellar/stellar-sdk"
import {
	ROUTERS,
	buildOnboardTx,
	getActivationStatus,
	type OnboarderConfig,
} from "@theahaco/authline"
import { beforeAll, describe, expect, it } from "vitest"

const RUN = process.env.RUN_TESTNET_E2E === "1"
const NET = {
	rpcUrl: "https://soroban-testnet.stellar.org",
	horizonUrl: "https://horizon-testnet.stellar.org",
	passphrase: Networks.TESTNET,
}
// TLO is the AUTH_REQUIRED test asset whose SAC admin IS the asset-agnostic
// authorizer contract (denylist, open-by-default) — see the SEP draft's
// Reference Implementation table. Onboarding it exercises the router's
// on-chain DISCOVERY path: trust → admin probe → authorize, one signature.
const CONFIG: OnboarderConfig = {
	assetCode: "TLO",
	assetIssuer: "GATBENNAFELDD6XLFPIMT3GBYAGWT4A7XY45P4YCFVPK2HHRNC2HQJ4U",
	sac: "CDVVAQAQ4FKQ4DCPPIIOIAOPRJJBO6HVOXRQX3PXONJVJNNK432O6HW3",
	router: process.env.PUBLIC_ROUTER ?? ROUTERS.TESTNET,
	backends: ["cap73-one-signature"],
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!RUN)("testnet TLO discovery onboard (real chain)", () => {
	const holder = Keypair.random()

	beforeAll(async () => {
		const r = await fetch(
			`https://friendbot.stellar.org/?addr=${holder.publicKey()}`,
		)
		if (!r.ok) throw new Error("friendbot failed")
	}, 120_000)

	it("creates AND authorizes an AUTH_REQUIRED trustline via admin discovery", async () => {
		const xdr = await buildOnboardTx({
			rpcUrl: NET.rpcUrl,
			networkPassphrase: NET.passphrase,
			holder: holder.publicKey(),
			config: CONFIG,
		})
		const tx = TransactionBuilder.fromXDR(xdr, NET.passphrase)
		tx.sign(holder)
		const server = new rpc.Server(NET.rpcUrl)
		const sent = await server.sendTransaction(tx)
		if (sent.status === "ERROR")
			throw new Error(
				`sendTransaction returned ERROR: ${sent.errorResult?.toXDR("base64") ?? "(no errorResult)"}`,
			)

		const deadline = Date.now() + 60_000
		let got = await server.getTransaction(sent.hash)
		while (got.status === "NOT_FOUND" && Date.now() < deadline) {
			await sleep(1500)
			got = await server.getTransaction(sent.hash)
		}
		if (got.status === "NOT_FOUND")
			throw new Error("onboard tx not confirmed within deadline")
		expect(got.status).toBe("SUCCESS")

		// AUTH_REQUIRED + authorized==true proves the DISCOVERED authorize step
		// ran — trust alone would leave isAuthorized false for TLO.
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

- [ ] **Step 3: Offline sanity — the suites are collected but skip**

Run: `npx vitest run tests/e2e` Expected: both files collected, all tests
**skipped** (RUN_TESTNET_E2E unset).

- [ ] **Step 4: Run the real-chain suites (network; outside sandbox if needed)**

Run: `npm run test:e2e:testnet` Expected: **2 files, 2 tests passed** — USDC
(open → trust suffices) and TLO (discovery → authorize via admin). If TLO fails
with the router returning `TrustlineOnly` (tx SUCCESS but
`isAuthorized: false`), the TLO SAC admin is not the authorizer anymore — verify
with
`stellar contract invoke --id CDVVAQ…6HW3 --network testnet --source-account router-deployer -- admin`
and report; do not paper over it.

- [ ] **Step 5: Playwright browser e2e (unchanged spec, new tx path
      underneath)**

Run: `lsof -ti tcp:4173 | xargs -r kill -9; npm run test:e2e` Expected: **1
passed** — the UI flow and asserted strings are unchanged; the underlying
transaction is now `router.onboard`.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e
git commit -m "test(e2e): route USDC through the router; add TLO discovery-path e2e"
```

---

### Task 7: SEP draft v0.3 + stale-docs sweep

**Files:**

- Modify: `sep/SEP-XXXX-trustline-onboarder.md`
- Modify: `packages/authline-sdk/README.md` (only if the grep below hits)

- [ ] **Step 1: Update §4 (the onboard composition)**

In `sep/SEP-XXXX-trustline-onboarder.md` §4, replace the
`fn onboard(env: Env, sac: Address, authorizer: Address, holder: Address)` code
block (and its explanatory `> The nested .map_err…` note) with the new 2-arg
discovery version — copy the `onboard` function body VERBATIM from
`contracts/trustline-onboard/src/lib.rs` (Task 2), preceded by:

```rust
/// One-signature onboarding with ON-CHAIN capability discovery.
/// `sac`    — Stellar Asset Contract address of the asset (any class).
/// `holder` — the G-account being onboarded.
```

Then update the prose around it:

- The intro sentence becomes: "The Trustline Onboard router composes trustline
  creation and authorization atomically, **discovering** the authorizer from
  `SAC.admin()` (CAP-68 `get_address_executable`) instead of taking it as a
  parameter."
- Add to the Properties list:
  - "`onboard` returns `OnboardStatus::Authorized` or
    `OnboardStatus::TrustlineOnly` — the caller learns the asset's class from
    the return value (or a simulation of it) rather than pre-classifying."
  - "A typed contract error from the discovered authorizer is a REJECTION and
    reverts the whole transaction, including the trustline. An untyped abort
    (missing export, panic) is read as _no one-step interface_ and yields
    `TrustlineOnly`."
- Update the §1 ASCII diagram's holder line from
  `Onboard.onboard(sac, authorizer, holder)` to `Onboard.onboard(sac, holder)`
  and add a `(discovers admin via CAP-68)` annotation under the Onboard box.

- [ ] **Step 2: Add the normative typed-error rule to §3**

In §3, after the "Semantics of `authorize_trustline`" bullet list, add:

```markdown
- It MUST signal every rejection with a **typed contract error** (the error
  table below). Callers — including the Onboard router — MUST interpret an
  untyped abort (missing export, panic, host error) as "no one-step authorizer
  interface" (`TrustlineOnly`), never as a rejection. An authorizer that panics
  instead of returning a typed error will therefore be treated as absent, and
  holders will be left with unauthorized trustlines.
```

- [ ] **Step 3: Update §6 (toml) and the changelog**

- In the §6 field table: change `AUTHORIZER`'s Req. column to `no` and its
  description to "Trustline Authorizer contract (the SAC admin). INFORMATIONAL
  for the one-signature path (the router discovers the admin on-chain); used by
  integrators for the zero-signature Case-A authorize-on-behalf."
- Change `ONBOARD_WRAPPER`'s description to "The Trustline Onboard **router**
  exposing `onboard(sac, holder)`. REQUIRED if `cap73-onesig` is in `BACKENDS`.
  Integrators SHOULD prefer a pinned/curated router id over an advertised one."
- In §1 "Asset-class detection", append: "Alternatively, an integrator MAY skip
  pre-classification entirely: simulate `onboard(sac, holder)` and read the
  would-be `OnboardStatus`."
- Preamble: bump `Version: 0.2` → `Version: 0.3`.
- Changelog table, new top row:

```markdown
| 0.3 | 2026-06-09 | `onboard` is now `onboard(sac, holder)` with on-chain
authorizer discovery (CAP-68 `get_address_executable` + `SAC.admin()`); added
`OnboardStatus` (`Authorized` / `TrustlineOnly`) and the typed-error rejection
rule (§3); `AUTHORIZER` in `[TRUSTLINE_ONBOARDER]` demoted to informational;
integrators MAY classify assets by simulating `onboard()`. |
```

- [ ] **Step 4: Sweep stale references**

Run:
`grep -rn "buildTrustTx\|onboard(sac, authorizer" --include="*.md" docs packages sep README.md 2>/dev/null | grep -v node_modules | grep -v superpowers`
Expected: only historical docs (`docs/authline-sdk.md` is a frozen PR
description — leave it). Fix any hit in `packages/authline-sdk/README.md` to the
new signature/API.

- [ ] **Step 5: Commit**

```bash
git add sep/SEP-XXXX-trustline-onboarder.md packages/authline-sdk/README.md
git commit -m "docs(sep): v0.3 — discovery router onboard(sac, holder), OnboardStatus, typed-error rule"
```

---

### Task 8: Full verification + PR bookkeeping

- [ ] **Step 1: Full offline gates**

Run:
`npm run lint && npm run typecheck && npx vitest run && npm run build && cargo test`
Expected: all green (vitest: unit tests pass, e2e files skip).

- [ ] **Step 2: Real-chain verification (network)**

Run: `npm run test:e2e:testnet` → Expected: 2 passed (USDC + TLO). Run:
`lsof -ti tcp:4173 | xargs -r kill -9; npm run test:e2e` → Expected: 1 passed.

- [ ] **Step 3: Push and update PR #16 checkboxes**

```bash
git push origin feat/usdc-open-asset-e2e
```

Then fetch the PR body
(`gh api repos/theahaco/stellar-assets/pulls/16 --jq .body`), check off every
completed `- [ ]` item in the Status/test-plan list, and PATCH it back
(`gh api -X PATCH repos/theahaco/stellar-assets/pulls/16 -F body=@…`). Note:
`gh pr edit` is broken in this repo (Projects-classic GraphQL error) — use
`gh api` directly.

- [ ] **Step 4: Report**

Summarize: contract test count, e2e results (with tx outcomes), and any
deviation from this plan.
