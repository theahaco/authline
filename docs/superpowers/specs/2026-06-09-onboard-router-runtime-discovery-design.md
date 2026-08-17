# Onboard Router with On-Chain Capability Discovery — Design

**Date:** 2026-06-09 **Status:** Approved (pivot of PR #16) **Supersedes:**
`2026-06-08-usdc-e2e-and-open-asset-onboarding-design.md` (the two-path,
client-branching design — its e2e harness and registry work survive; its
transaction-shape branching is replaced)

## Problem

Today the SDK and dApp pick between two transaction shapes using client-side
metadata:

- **open** asset → `buildTrustTx` → `SAC.trust(holder)`
- **permissionedOneStep** → `buildOnboardTx` →
  `TrustlineOnboard.onboard(sac, authorizer, holder)`

The `capability` and `authorizer` fields live in the pinned registry, `PUBLIC_*`
env, and `stellar.toml` discovery. They can rot, diverge from chain truth, and
the advertised `authorizer` is an attack surface that `reconcileWithRegistry`
must actively defend (a spoofed toml could redirect the authorize call).

## Decision

**One router contract method. Capability is discovered on-chain at execution
time, from the only source the protocol lets matter: the SAC's admin.**

```rust
#[contracttype]
pub enum OnboardStatus {
    /// Trustline exists and is authorized (open asset, or one-step authorized).
    Authorized,
    /// Trustline exists but the asset is AUTH_REQUIRED and has no one-step
    /// authorizer — the issuer authorizes off-platform (manual path).
    TrustlineOnly,
}

/// Single entry point: create the holder's trustline and, when the asset's
/// SAC admin is a contract exposing `authorize_trustline`, authorize it — all
/// under one holder signature. Asset class is DISCOVERED, not configured.
pub fn onboard(env: Env, sac: Address, holder: Address) -> Result<OnboardStatus, Error> {
    holder.require_auth();

    // 0. Anti-copycat, on-chain: refuse anything that is not a built-in SAC.
    //    (CAP-68 `get_address_executable`; soroban-sdk: `Address::executable()`.)
    //    A wasm contract masquerading as a SAC is rejected by the router itself.
    if sac.executable() != Some(Executable::StellarAsset) {
        return Err(Error::NotSac);
    }
    let sac_client = StellarAssetClient::new(&env, &sac);

    // 1. CAP-73: create the trustline. Idempotent (silent no-op if it exists);
    //    created UNauthorized when the issuer is AUTH_REQUIRED.
    sac_client.try_trust(&holder).map_err(|_| Error::TrustFailed)?...;

    // 2. Already usable? (Open asset, or previously authorized.)
    if sac_client.authorized(&holder) {
        return Ok(OnboardStatus::Authorized);
    }

    // 3. Discover the one-step capability from the SAC admin.
    let admin = sac_client.admin();
    match admin.executable() {
        // Admin is a wasm contract — probe the authorizer interface.
        Some(Executable::Wasm(_)) => {
            match AuthorizerClient::new(&env, &admin).try_authorize_trustline(&holder) {
                // Typed contract error = the authorizer REJECTED the holder.
                // Revert everything (incl. the trustline) — fail loudly.
                Err(typed_contract_error) => Err(Error::AuthorizationRefused),
                // Abort (missing export, or a non-typed panic) = no one-step
                // interface. The trustline stands; report it truthfully.
                Err(abort) => Ok(OnboardStatus::TrustlineOnly),
                // Post-condition: the authorizer must have actually authorized
                // the holder ON THIS SAC (guards no-op / divergent authorizers).
                Ok(_) if sac_client.authorized(&holder) => Ok(OnboardStatus::Authorized),
                Ok(_) => Err(Error::NotAuthorized),
            }
        }
        // Admin is a G-account / a SAC / nonexistent: no one-step interface.
        _ => Ok(OnboardStatus::TrustlineOnly),
    }
}
```

(Sketch is illustrative: the `try_` client returns nested `Result`s — the outer
`Err(Ok(contract_error))` vs `Err(Err(InvokeError::Abort))` distinction carries
the rejected-vs-absent split. Exact pattern is settled in the implementation
plan, TDD'd against stubs.)

### Decisions locked in (2026-06-09)

1. **Abort policy A:** an opaque abort from the admin probe maps to
   `Ok(TrustlineOnly)`. The SEP gains a normative rule: _authorizers MUST signal
   rejection with typed contract errors_ (the SEP's §3 error table already
   defines them; this makes them load-bearing). A sloppy, panicking authorizer
   yields a truthfully-reported unauthorized trustline — never a false
   "authorized".
2. **Return shape:** the `OnboardStatus` enum above (not a bare bool). The UI
   can simulate `onboard()` pre-signature and read the would-be status.
3. **Old paths deleted outright:** `buildTrustTx`, `BuildTrustOptions`, and the
   3-arg `onboard(sac, authorizer, holder)` are removed, not deprecated
   (pre-1.0; the contract is immutable-by-design so a new deployment happens
   regardless).
4. **PR #16 pivots in place** (same branch, new title + description) rather than
   stacking a new PR.

## Why admin discovery is protocol-sound

`SAC.set_authorized` requires the **admin's** auth — nothing else can flip the
authorized flag. So any _working_ one-step authorizer must already be the SAC
admin, which makes "the admin is a contract exporting `authorize_trustline`" the
protocol-enforced **definition** of one-step capable, not a heuristic. The
registry/toml `authorizer` field was always a redundant copy of `sac.admin()`;
this design reads the original.

## Verified protocol facts (sources read 2026-06-09)

| Fact                                                     | Result                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CAP-68 `get_address_executable` (protocol 23, **Final**) | `Address::executable()` in soroban-sdk (workspace is on 26.0.0) returns `None` (no ledger entry) \| `Wasm(hash)` \| `StellarAsset` \| `Account` — contract-vs-account-vs-SAC test **without invoking**                                                                            |
| `try_invoke` on a **G-address**                          | **Unconditional trap** (host rejects "not a contract address" _before_ try-call recovery) — hence the CAP-68 check must gate the probe                                                                                                                                            |
| `try_invoke`, missing contract / missing export          | Recoverable, but squashed to `Context/InvalidAction` → SDK `InvokeError::Abort`. Only **typed contract errors** (`ScErrorType::Contract`) pass through with their code — the basis of the rejected-vs-absent split                                                                |
| `sac.admin()`, `sac.authorized(id)`                      | Permissionless reads (verified in rs-soroban-env builtin SAC source)                                                                                                                                                                                                              |
| CAP-73 `trust(to)` (protocol 26)                         | Idempotent (silent no-op if trustline exists / C-address); requires `to`'s auth only when creating; created **authorized iff not AUTH_REQUIRED**; limit `i64::MAX`; **no sponsorship**. Live on mainnet since the Protocol 26 "Yardstick" upgrade (2026-05-06, per the SEP draft) |
| EURCV admin == pinned authorizer                         | Documented (SEP §Reference: `eurcv_auth` `CB2DHZ…KSB3` is the **live** EURCV SAC admin). Re-verify on-chain before any mainnet router flip                                                                                                                                        |

## Contract

- **Crate:** keep `contracts/trustline-onboard` (same workspace, same name); the
  3-arg `onboard` is replaced by the 2-arg discovery version. New testnet
  deployment (immutable-by-design: no upgrade path, new id).
- **Errors:** `NotSac`, `TrustFailed`, `AuthorizationRefused`, `NotAuthorized`.
- **Auth:** `holder.require_auth()` unconditionally. The zero-signature Case A
  (authorize-on-behalf for an existing trustline) is **not** the router's job —
  it stays on `buildAuthorizeTx` → `authorize_trustline` directly. The router is
  the ≤1-signature Backend-1 entry point, with predictable auth semantics.
- **No router events** (YAGNI): the SAC and authorizer already emit; the status
  is the return value.

### Outcome matrix

| Asset / admin state                                                                 | Result                                                              |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Open asset (not AUTH_REQUIRED)                                                      | `Ok(Authorized)` — trust alone suffices                             |
| Already-authorized trustline (re-run)                                               | `Ok(Authorized)` — idempotent                                       |
| AUTH_REQUIRED, admin = G-account                                                    | `Ok(TrustlineOnly)`                                                 |
| AUTH_REQUIRED, admin = wasm contract **with** `authorize_trustline`, policy passes  | `Ok(Authorized)`                                                    |
| AUTH_REQUIRED, admin contract rejects (typed error, e.g. `AccountBanned`)           | `Err(AuthorizationRefused)` — **whole tx reverts**, incl. trustline |
| AUTH_REQUIRED, admin contract **without** `authorize_trustline` (or panics untyped) | `Ok(TrustlineOnly)`                                                 |
| AUTH_REQUIRED, admin authorizer returns Ok but doesn't authorize (no-op/divergent)  | `Err(NotAuthorized)` — post-condition                               |
| `sac` is not a built-in SAC (wasm impostor, account, nonexistent)                   | `Err(NotSac)`                                                       |

### Unit-test matrix (cargo test, mocked auth — extends the existing stubs)

Existing stubs (`StubAuthorizer`, `FailingAuthorizer`, `NoopAuthorizer`) carry
over; the stubs now get installed **as the SAC admin** (`set_admin`), since
that's where discovery looks. New stubs: a contract with **no**
`authorize_trustline` export; a **panicking** authorizer. New scenarios: open
asset → `Authorized`; G-account admin → `TrustlineOnly`; impostor SAC →
`NotSac`; idempotent re-run. One early **spike test** verifies the native test
env reproduces the wasm-host try-call classification (missing export / panic →
Abort; typed error → contract error) — this is the design's one mechanical
assumption that unit tests must confirm before building on it.

## SDK changes (`@theahaco/authline`)

- `onboard.ts`: delete `buildTrustTx` + `BuildTrustOptions`; rewrite
  `buildOnboardTx` to invoke `router.onboard(sac, holder)`. Still returns
  unsigned base64 XDR (simulated + assembled).
- `OnboarderConfig`: `authorizer` becomes **optional** (used only by the
  unchanged Case-A `buildAuthorizeTx`); the `onboard` field (wrapper id) is
  renamed **`router`** and is what `buildOnboardTx` requires. `selectBackend`
  follows the rename (`config.router` gates the one-signature backend).
- `registry.ts`: new pinned `ROUTERS: Partial<Record<StellarNet, string>>`
  (testnet now; mainnet when deployed). `OfficialAsset.authorizer` stays as an
  optional informational pin; `capability` stays as **display-only** metadata
  (it no longer selects the transaction shape). `validateOfficialAsset`'s
  permissionedOneStep⇒authorizer rule is kept (it validates display coherence)
  but is no longer load-bearing.
- `reconcileWithRegistry`: unchanged shape; the authorizer assert now only fires
  when both sides carry the field. The class of attack it defended (spoofed
  authorizer) is structurally gone from the one-signature path.
- Unchanged: `buildSponsoredOnboardTx` (CAP-33 backend), `buildAuthorizeTx`
  (Case A), discovery/toml parsing, `getActivationStatus`.

## Frontend changes

- `src/config.ts`: wire `router` from `PUBLIC_ROUTER` ?? pinned `ROUTERS[net]`;
  the permissionedOneStep misconfiguration warning becomes a missing-router
  warning. `authorizer` drops out of the required wiring.
- `src/authline.tsx`: `activate()` collapses to a single `buildOnboardTx` call —
  the `IS_OPEN ? buildTrustTx : buildOnboardTx` branch disappears.
  Capability-aware **copy** stays (display-only, from registry metadata).
- e2e (both opt-in, real testnet): the Node/SDK e2e drives `router.onboard` for
  **USDC (open → `Authorized`)** and adds the discovery path against the
  already-deployed **TLO test asset** (`AUTH_REQUIRED`, SAC `CDVVAQ…6HW3`,
  asset-agnostic authorizer `CD7K7S…K2KU` as admin → `Authorized`). Playwright
  keeps the existing USDC browser flow (UI is unchanged from the user's
  perspective).

## Deployment

1. Deploy the new router to **testnet** (stellar CLI; idempotent script in the
   spirit of `scripts/deploy-testnet-usdc-sac.mjs`), pin the id in
   `ROUTERS.TESTNET` and `.env.e2e` (`PUBLIC_ROUTER`).
2. Mainnet deployment is a follow-up; flipping EURCV to the router happens only
   after a fresh on-chain `sac.admin()` read confirms the pinned `CB2DHZ…KSB3`.

## SEP draft changes (`sep/SEP-XXXX-trustline-onboarder.md`, v0.2 → v0.3)

- **§4:** `onboard(sac, holder)` — the wrapper no longer takes `authorizer`; add
  the discovery algorithm, `OnboardStatus`, and the outcome matrix.
- **§3:** new normative rule — `authorize_trustline` rejections **MUST** be
  typed contract errors (the §3 error table); callers MUST interpret an untyped
  abort as interface-absent (`TrustlineOnly`), never as rejection.
- **§6 toml:** `AUTHORIZER` becomes optional/informational (Case A only);
  `ONBOARD_WRAPPER` is the router. Integrators MAY skip `auth_required`
  pre-classification entirely and simulate `onboard()` instead.
- Changelog 0.3 entry.

## What survives from PR #16's first iteration

The e2e harness (vitest + Playwright + opt-in CI job), `.env.e2e`, the testnet
USDC registry entry + SAC deploy script, and the capability-aware copy all
stand. Replaced: `buildTrustTx`, the two-path `activate()`, the 3-arg contract
method and its client plumbing.

## Risks

- **Abort ambiguity** (missing export vs untyped panic): accepted by policy A;
  bounded by the truthful return value and the SEP typed-error rule. Worst case
  is an unauthorized trustline truthfully reported, costing the holder the 0.5
  XLM reserve.
- **Native-test fidelity** of try-call error classification: covered by the
  spike test; the wasm-level testnet e2e is the backstop.
- **Protocol floors:** CAP-68 = P23 (Final, live), CAP-73 = P26 (live on mainnet
  since 2026-05-06). Unchanged from the current design.
- Discovery adds ~3 cross-contract reads + 1 probe per onboard — negligible.

## Out of scope

- **stellar-registry resolution** of SACs and the router id (future; the
  pinned-registry seam — `resolveOfficialAsset` / `ROUTERS` — is where it plugs
  in).
- CAP-33 sponsored backend, Case-A `buildAuthorizeTx`, toml discovery internals:
  unchanged.
- Authorizer contract changes: none (the interface is already admin-installed).
