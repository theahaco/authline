## Preamble

<!-- TODO before submitting to stellar/stellar-protocol: replace the
     `Discussion:` [placeholder] with the URL of the pre-SEP discussion thread.
     `SEP: To Be Assigned` and `Version: v0.0.1` are the values the submission
     process requires (ecosystem/README.md); a maintainer assigns the number. -->

```
SEP: To Be Assigned
Title: Trustline Onboarder
Author: The Aha Company, Willem Wyndham <@willemneal>, Enzo Soyer, Pamphile Roy <@tupui>
Track: Standard
Status: Draft
Created: 2026-06-04
Discussion: https://github.com/stellar/stellar-protocol/discussions/[placeholder]
Version: v0.0.1
```

## Simple Summary

A standard that lets a **third party** — an exchange, broker, or wallet —
onboard a user into a classic Stellar asset on the user's behalf, so that
receiving or withdrawing the asset no longer requires the user to face a
context-free "create a trustline" prompt. The standard defines an on-chain
authorization-delegation interface, a `stellar.toml` discovery block, and an
integrator interface that together reduce the user to **at most one in-flow
signature, and often zero**. It is asset-agnostic: it serves the majority of
**open** classic assets (USDC, EURC — not `AUTH_REQUIRED`) and **regulated**
`AUTH_REQUIRED` assets (EURCV) under one interface. It builds on the
[Contract Admin SEP](https://github.com/theahaco/admin-sep) (`admin-sep`) and
references
[CAP-73](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0073.md)
(Protocol 26).

## Abstract

Holding a classic issued asset on Stellar requires a `CHANGE_TRUST` operation
that creates a trustline subentry (+0.5 XLM reserve). For an `AUTH_REQUIRED`
asset, the trustline is then unusable until the issuer authorizes it via
`SetTrustLineFlags(authorized)` — or, when authorization is delegated to a
Stellar Asset Contract (SAC), via the SAC admin function
`set_authorized(id, true)`. Today this is a multi-step, multi-signature,
off-band process, and it is most acute in a centralized-exchange (CEX)
withdrawal, where a user withdrawing an asset to a self-custody wallet is
stopped at a "create a trustline" prompt with no context.

**The invariant, stated openly as a strength:** creating a trustline (classic
`CHANGE_TRUST`, or CAP-73 `SAC.trust()`) _always_ requires the trustline owner's
own signature. No third party can create a trustline on a non-custodial user's
account. "Onboarding a user into an asset," therefore, does not mean signing for
the user; it means the third party does **everything else** — pays the reserve
via CAP-33 sponsorship, authorizes on the issuer's behalf via a permissionless
on-chain contract, and orchestrates the transaction — so the user is reduced to
**at most one** in-flow signature, and for an already-existing unauthorized
trustline, **zero**.

This SEP normatively defines:

1. The **roles** in a third-party onboarding flow, and the two **asset classes**
   (open vs. regulated `AUTH_REQUIRED`) the standard serves under one interface.
2. A **Trustline Authorizer** contract, installed as the asset's SAC admin (via
   `admin-sep`'s `Administratable` trait), exposing an asset-agnostic,
   **permissionless** `authorize_trustline` interface gated by a configurable
   **denylist** (open-by-default) or **allowlist** (gated) policy. Required only
   for regulated `AUTH_REQUIRED` assets.
3. A **Trustline Onboard** wrapper that composes CAP-73's `SAC.trust()` with the
   Authorizer's `authorize_trustline` so that creating and authorizing a
   trustline happen **atomically under one holder signature**.
4. **Two reserve backends** an integrator selects between — the CAP-73
   one-signature path (funded holder) and a CAP-33 sponsored-reserve path
   (brand-new, zero-XLM user) — and the rules for choosing.
5. The **three onboarding cases** (A: zero-signature authorize-on-behalf; B:
   sponsored one-tap; C: CAP-73 one-transaction) that arise across both asset
   classes and account states.
6. A **`stellar.toml` `[TRUSTLINE_ONBOARDER]` discovery block** so any
   integrator can auto-discover an issuer's onboarder from one config —
   universal interop, no bilateral deals.
7. The **integrator interface** (handoffs: SEP-7 URI, wallet deep-link, hosted
   redirect) and a structured **audit-event** trail suitable for MiCA-style
   compliance reporting.

This SEP does **not** propose a new CAP. The single-signature primitive it
relies on (`SAC.trust()`) already exists in Protocol 26 via CAP-73.

## Motivation

### The third-party reframe

The friction the standard removes is not, fundamentally, an end-user-page
problem. It is a **third-party integration** problem: an exchange, broker, or
wallet wants to deliver an asset to a user and is blocked because the user does
not yet hold an authorized trustline. Today the third party can only hand the
user a raw `CHANGE_TRUST` prompt and hope they complete it. This SEP defines the
standard, on-chain delegation and the discovery metadata that let the third
party do everything except the one signature that the protocol reserves for the
trustline owner — and, in the common case of a pre-existing unauthorized
trustline, removes even that.

### Withdrawal-flow friction

A regulated classic asset with `AUTH_REQUIRED` (e.g., a MiCA stablecoin) cannot
be received by a self-custody account until that account holds an _authorized_
trustline. In a CEX withdrawal this produces a poor UX: the user signs
`ChangeTrust` (and funds a 0.5 XLM reserve they may not have), the issuer
authorizes out of band, and only then can the withdrawal land. Each hop is a
place to lose the user. The objective is to collapse the "create + authorize"
sequence into a **single, predictable, self-service interaction** a third party
can drive, while keeping authorization under the issuer's on-chain policy
control.

### Two asset classes — do not assume the regulated model for all assets

The standard explicitly serves two classes. The discovery router (§4) detects
which applies **on-chain** — it runs the SAC admin's `authorize_trustline` for a
regulated asset and skips it for an open one — so an integrator driving
`onboard()` never branches on the class. On the classic sponsored path (§5, Case
B) an integrator can read the issuer's `auth_required` flag directly, or
simulate `onboard()` and read the would-be `OnboardStatus`, to decide whether a
separate authorize step applies:

- **Open classic assets (the majority — USDC, EURC):** not `AUTH_REQUIRED`.
  Onboarding is simply a reserve-free, sponsored `ChangeTrust` — the third party
  sponsors the reserve, the user signs once (a sponsored `CreateAccount` covers
  a brand-new zero-XLM account). There is **no** authorize step and **no**
  Authorizer contract needed.
- **Regulated `AUTH_REQUIRED` assets (EURCV):** `ChangeTrust` (user, once)
  **plus** authorize-on-behalf (third party, permissionless, no user or issuer
  signature) via the Trustline Authorizer.

The Authorizer / authorize-on-behalf is the _regulated-asset value_. For most
assets the value is reserve-free, one-tap (or zero-touch) trustline
establishment plus the handoff.

### Classic-asset compliance (MiCA)

Issuers of regulated classic assets need `AUTH_REQUIRED` (gate who may hold),
`AUTH_REVOCABLE` (freeze), and `AUTH_CLAWBACK_ENABLED` (clawback), plus an
auditable record of who was authorized, when, and under what policy. Performing
authorization off-chain with the issuer's keys provides no standard, reviewable
trail and cannot be composed atomically with trustline creation. Delegating
authorization to a **policy contract** set as the SAC admin makes the policy
on-chain, deterministic, and auditable, and lets the issuer retain
`SetTrustLineFlags`-equivalent freeze/clawback controls. (This is a compliance
_design and controls_ mapping, not legal advice.)

### Why now: CAP-73

Before Protocol 26, a Soroban contract could not create a classic trustline:
classic and Soroban operations cannot be mixed in a single transaction, so
"create trustline" (classic `CHANGE_TRUST`) and "authorize via SAC" (Soroban
`set_authorized`) could not be composed atomically. [CAP-73] — _"Allow SAC to
create G-account balances,"_ live on mainnet since the Protocol 26 _"Yardstick"_
upgrade (vote 2026-05-06) — adds a SAC host function:

```rust
// CAP-73 (Protocol 26)
fn trust(env: Env, address: Address);
// Creates an UNLIMITED trustline for `address` if none exists.
// Requires require_auth(address). No-op for C-addresses and existing trustlines.
// DOES NOT support sponsorship: the trustline owner pays the 0.5 XLM reserve.
// DOES NOT authorize an AUTH_REQUIRED trustline — authorization remains a
// separate set_authorized call.
```

Because `trust()` is a Soroban host function, a contract can call it _and_ call
the SAC admin's `set_authorized` in **one Soroban transaction under one holder
auth**. This SEP defines the contract interface and discovery metadata that turn
that primitive into an interoperable onboarding standard.

### Why delegate authorization once, on-chain

Today an `AUTH_REQUIRED` issuer either approves trustlines by hand or runs a
SEP-8 approval server that co-signs **every** transaction. This SEP delegates
authorization **once** to a permissionless on-chain contract: after the issuer
transfers SAC admin to the Authorizer, authorization is a contract call subject
to an on-chain policy, with no issuer signature at authorize time and no
per-transaction co-signing server.

### Why build on admin-sep

The [Contract Admin SEP](https://github.com/theahaco/admin-sep) (Track:
Standard, Status: Draft; SDF discussion #1670) standardizes the SAC/contract
admin surface via an `Administratable` trait (`admin` / `set_admin`) plus
`Upgradable`. The Trustline Authorizer is an `Administratable` contract: the
issuer transfers SAC admin to it, and the Authorizer's own admin governs policy
changes (ban/unban, freeze, clawback, upgrade). Reusing `admin-sep` keeps the
admin surface uniform across the Stellar contract ecosystem rather than
inventing a new one.

## Specification

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD",
"SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be
interpreted as described in [RFC 2119](https://www.ietf.org/rfc/rfc2119.txt).

### 1. Roles and asset classes

| Role                          | Description                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Issuer**                    | The classic asset issuer (`G…`). For a regulated asset, sets `AUTH_REQUIRED` (and optionally `AUTH_REVOCABLE`, `AUTH_CLAWBACK_ENABLED`), wraps the asset as a SAC, and transfers SAC admin to the Trustline Authorizer. Publishes `[TRUSTLINE_ONBOARDER]` in its `stellar.toml`.                                |
| **Trustline Authorizer**      | A Soroban contract installed as the asset's **SAC admin**. Implements the authorization-delegation interface (§3). Is `Administratable` + `Upgradable` per `admin-sep`. Holds policy state (denylist or allowlist) and emits audit events (§8). **Required only for `AUTH_REQUIRED` assets.**                   |
| **Trustline Onboard wrapper** | A stateless, immutable, asset-agnostic Soroban ROUTER whose `onboard(sac, holder)` (§4) composes CAP-73 `SAC.trust()` with the authorizer **discovered on-chain** from `SAC.admin()` (CAP-68). Deployed once per network; integrators SHOULD use a pinned/curated router id (§6) rather than an advertised one. |
| **Integrator (third party)**  | A wallet, exchange, or broker that reads the issuer's `stellar.toml`, detects the asset class, builds the activation transaction, and presents the at-most-one-signature flow to the user.                                                                                                                      |
| **Sponsor**                   | (Backend 2 only.) An account (issuer or platform) that pays the holder's reserve(s) via CAP-33 future-reserves sponsorship and co-signs the classic activation transaction.                                                                                                                                     |
| **Holder (user)**             | The end user (`G…`). Signs **at most once** — and **zero** times when only authorization is needed (Case A).                                                                                                                                                                                                    |

```
   Issuer  ──set_admin(Authorizer)──►  SAC (classic asset)
     │                                    ▲
     │ publishes stellar.toml             │ set_authorized(holder,true)
     │ [TRUSTLINE_ONBOARDER]              │  (regulated assets only)
     ▼                                    │
 Integrator ──reads toml──► detects class, builds tx ─┐
   (3rd party)                                        │ require_auth(holder)
 Holder ──≤1 signature──► Onboard.onboard(sac, holder)
                                    (discovers admin via CAP-68)
                                                      │
                                       ┌──────────────┴───────────────┐
                                       ▼                              ▼
                              SAC.trust(holder)        Authorizer.authorize_trustline(holder)
                              (CAP-73: create TL)       (policy check → SAC.set_authorized)
```

#### Asset-class detection (normative)

An integrator MUST determine the asset class before building a transaction, by
reading the issuer account's `auth_required` flag:

| Asset class                                 | `auth_required` | Trustline                                                                         | Authorize step                                              | Authorizer contract        |
| ------------------------------------------- | :-------------: | --------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------- |
| **Open** (USDC, EURC — majority)            |      false      | sponsored `ChangeTrust` (user signs once; sponsored `CreateAccount` if brand-new) | none                                                        | not used                   |
| **Regulated** (`AUTH_REQUIRED`, e.g. EURCV) |      true       | `ChangeTrust` (user, once)                                                        | authorize-on-behalf (third party, no user/issuer signature) | required, set as SAC admin |

For an open asset, the entire `[TRUSTLINE_ONBOARDER]` Authorizer/onboard-wrapper
machinery is unnecessary: the flow reduces to a sponsored, reserve-free
`ChangeTrust`. The standard MUST NOT require an Authorizer for assets that are
not `AUTH_REQUIRED`. Alternatively, an integrator MAY skip pre-classification
entirely: simulate `onboard(sac, holder)` and read the would-be `OnboardStatus`.

### 2. The three onboarding cases

Across both asset classes and the holder's account state, three cases arise.
Integrators MUST select among them by reading the holder's account and trustline
state and the asset class:

| Case                             | Precondition                                                                    | What the third party does                                                                                                                                                    | Holder signatures |
| -------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------: |
| **A — zero-signature authorize** | Holder already has an **unauthorized** trustline (common with `AUTH_REQUIRED`). | Authorizer `authorize_trustline(holder)` on-behalf. No trustline creation needed.                                                                                            |       **0**       |
| **B — sponsored one-tap**        | Holder has **no** trustline / zero XLM.                                         | Build a CAP-33 sponsored `ChangeTrust` (pays the 0.5 XLM reserve; sponsored `CreateAccount` if brand-new). Holder signs once; then, if `AUTH_REQUIRED`, authorize on-behalf. |       **1**       |
| **C — CAP-73 one-tx**            | Holder has a **funded** account.                                                | One CAP-73 Soroban tx (`onboard()` wrapper) creates **and** authorizes in a single holder signature.                                                                         |       **1**       |

Case A is the zero-signature path the protocol allows because the trustline
already exists — only authorization remains, and authorization is permissionless
and on-behalf. Cases B and C both reduce the holder to one signature; they
differ in who pays the reserve (B: sponsor; C: holder) and in transaction shape
(B: classic sponsorship sandwich; C: single Soroban tx). The mapping to backends
(§5) is: Case A and C use **Backend 1** (CAP-73 / Soroban); Case B uses
**Backend 2** (CAP-33 / classic sponsored).

### 3. Authorization-delegation interface and policy model (regulated assets)

The Trustline Authorizer MUST be set as the SAC admin of the asset
(`SAC.set_admin(authorizer)`), so that it — and only it — may call
`set_authorized` on the SAC. The Authorizer MUST implement `admin-sep`'s
`Administratable` (`admin`, `set_admin`) and SHOULD implement `Upgradable`.

The Authorizer MUST expose:

```rust
/// Authorize the trustline of `account` on the managed asset, on the account's behalf,
/// subject to the configured policy. Calls SAC.set_authorized(account, true) on success.
/// Permissionless: requires no issuer signature at call time.
fn authorize_trustline(env: Env, account: Address) -> Result<(), Error>;
```

Semantics of `authorize_trustline`:

- It performs **on-behalf** authorization: it does **not** require the _issuer_
  (or the _holder_) to sign at call time. Authorization authority comes from the
  Authorizer being the SAC admin. This is what enables **Case A's zero holder
  signatures**.
- It MUST evaluate the configured **policy** (below) on **every** call. The
  policy decision MUST NOT be cached or short-circuited by a prior authorization
  or a prior trustline: a banned, disallowed, or frozen account MUST NOT obtain
  authorization, even on a repeated or retried call (see §4 idempotency and the
  freeze lifecycle below).
- On success it MUST call the SAC admin function `set_authorized(account, true)`
  and SHOULD record `account` as authorized in contract storage.
- It MUST return `NoTrustline` if `account` has no trustline for the asset
  (callers compose `SAC.trust()` first; see §4).
- It MUST NOT authorize the Authorizer contract itself
  (`CannotAuthorizeAdminContract`).
- It MUST return `ContractPaused` when the contract is paused.
- It MUST signal every rejection with a **typed contract error** (the error
  table below). Callers — including the Onboard router — MUST interpret an
  untyped abort (missing export, panic, host error) as "no one-step authorizer
  interface" (`TrustlineOnly`), never as a rejection. An authorizer that panics
  instead of returning a typed error will therefore be treated as absent, and
  holders will be left with unauthorized trustlines.

#### Policy model

The Authorizer MUST support one of two policies, fixed at deployment or set by
the admin:

| Policy        | Default            | `authorize_trustline(account)` succeeds when…                          | Use case                                              |
| ------------- | ------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| **Denylist**  | ✅ open-by-default | `account` is **not** in the banned set (permissionless / self-service) | Frictionless stablecoins (e.g., the live EURCV model) |
| **Allowlist** | gated              | `account` **is** in the allowed set (per-user KYC gate set by issuer)  | Securities / RWA, per-holder KYC                      |

The denylist policy makes `authorize_trustline` **permissionless and
self-service**: any account not banned authorizes itself (or is authorized
on-behalf by a third party). The allowlist policy makes it **gated**: the issuer
(Authorizer admin) MUST `allow(account)` first, typically after off-band KYC
(which MAY be fronted by a SEP-10–authenticated endpoint; §7).

#### Freeze / deauthorize lifecycle (normative)

To prevent a previously-frozen account from re-authorizing itself by replaying
`onboard()` or calling `authorize_trustline` again, the freeze and deauthorize
lifecycle MUST interact with policy as follows:

- **`freeze_accounts` MUST set the banned/disallowed bit AND deauthorize.**
  Under the **denylist** policy, `freeze_accounts(a)` MUST add `a` to the banned
  set **and** call `set_authorized(a, false)`. Under the **allowlist** policy,
  it MUST remove `a` from the allowed set **and** call
  `set_authorized(a, false)`. Freeze is precisely _ban/disallow + deauthorize_
  so the subsequent policy check blocks re-authorization.
- A **frozen-but-not-banned** state MUST NOT be representable: because denylist
  `authorize_trustline` only checks the banned set, an account that was
  deauthorized but not banned would be re-authorizable by a retried `onboard()`.
  Implementations MUST NOT expose any path that deauthorizes without also
  updating policy when the intent is to freeze. `deauthorize_trustline` is
  provided for transient, policy-consistent deauthorization and MUST NOT be used
  as a standalone freeze; callers needing a durable freeze MUST use
  `freeze_accounts`.
- `unfreeze_accounts` MUST reverse both effects: remove from the banned set
  (denylist) or re-add to the allowed set (allowlist), **and** re-authorize via
  `set_authorized(a, true)`.

This closes the lifecycle hole where a retried `onboard()` could re-authorize a
frozen holder: the policy check in `authorize_trustline` runs on every call, and
freeze guarantees the policy now rejects the account.

Required admin / lifecycle entry points (generalizing the live `eurcv_auth`
interface):

```rust
// Denylist policy
fn add_banned_accounts(env: Env, accounts: Vec<Address>);      // max 50 per call
fn remove_banned_accounts(env: Env, accounts: Vec<Address>);   // max 50 per call

// Allowlist policy
fn allow(env: Env, accounts: Vec<Address>);
fn disallow(env: Env, accounts: Vec<Address>);

// Lifecycle controls (require SetTrustLineFlags-equivalent asset flags)
fn freeze_accounts(env: Env, accounts: Vec<Address>);   // ban/disallow + de-authorize
fn unfreeze_accounts(env: Env, accounts: Vec<Address>); // un-ban/re-allow + re-authorize
fn deauthorize_trustline(env: Env, account: Address, reason: Reason); // set_authorized(account, false), policy-consistent
fn clawback(env: Env, from: Address, amount: i128);     // requires AUTH_CLAWBACK_ENABLED
fn mint_to_account(env: Env, to: Address, amount: i128);
fn pause(env: Env);
fn unpause(env: Env);

// From admin-sep
fn admin(env: Env) -> Address;
fn set_admin(env: Env, new_admin: Address);
fn upgrade(env: Env, wasm_hash: BytesN<32>);
```

`freeze_accounts`/`unfreeze_accounts` require `AUTH_REVOCABLE`; `clawback`
requires `AUTH_CLAWBACK_ENABLED`. Implementations MUST gate all admin entry
points on `admin().require_auth()`. `Reason` is the enumerated deauthorization
code carried into the audit event (§8); implementations SHOULD offer at least
`Sanctions`, `KycExpired`, `IssuerRequest` and `Unspecified`.

`pause` MUST stop `authorize_trustline`; implementations SHOULD also stop every
other state-changing entry point, leaving only `unpause`, `set_admin` and
`upgrade` callable so a paused contract stays recoverable.

#### Error codes (normative minimum)

| Error                          | Condition                                |
| ------------------------------ | ---------------------------------------- |
| `AccountBanned`                | denylist policy, `account` is banned     |
| `AccountNotAllowed`            | allowlist policy, `account` not allowed  |
| `NoTrustline`                  | `account` has no trustline for the asset |
| `ContractPaused`               | contract is paused                       |
| `CannotAuthorizeAdminContract` | `account == authorizer contract address` |

### 4. One-signature onboard composition (over CAP-73)

The Trustline Onboard router composes trustline creation and authorization
atomically, **discovering** the authorizer from `SAC.admin()` (CAP-68
`get_address_executable`) instead of taking it as a parameter.

```rust
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

/// One-signature onboarding with ON-CHAIN capability discovery.
/// `sac`    — Stellar Asset Contract address of the asset (any class).
/// `holder` — the G-account being onboarded.
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
///
/// # Security
///
/// The discovered admin is a contract CHOSEN BY THE ASSET, executed under
/// the holder's signed authorization tree: in recording-mode simulation,
/// any nested `holder.require_auth()` the admin triggers is folded into
/// the single root auth entry the holder signs. The router cannot prevent
/// a malicious admin from abusing this — only onboard SACs from a
/// trusted/pinned source, and wallets SHOULD render the full auth tree.
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
        // on THIS sac — guards a no-op or divergent authorizer. Also
        // covers a wrong-return-shape success (Ok(Err(ConversionError))):
        // the post-condition resolves it either way.
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
        // Statically unreachable for E = soroban_sdk::Error (its error
        // conversion is infallible, so typed rejections always surface
        // as Err(Ok(_)) above); kept as defense-in-depth.
        Err(Err(soroban_sdk::InvokeError::Contract(_))) => Err(Error::AuthorizationRefused),
        // Anything else (squashed Context/InvalidAction abort: missing
        // export or an untyped panic) means "no authorize_trustline
        // interface": keep the trustline and report it truthfully.
        Err(_) => Ok(OnboardStatus::TrustlineOnly),
    }
}
```

Properties:

- The **only** required authorization is `holder.require_auth()` — one signature
  on a single Soroban transaction (Case C).
- `onboard` returns `OnboardStatus::Authorized` or
  `OnboardStatus::TrustlineOnly` — the caller learns the asset's class from the
  return value (or a simulation of it) rather than pre-classifying.
- A typed contract error from the discovered authorizer is a REJECTION and
  reverts the whole transaction, including the trustline. An untyped abort
  (missing export, panic) is read as _no one-step interface_ and yields
  `TrustlineOnly`.
- `try_trust` is a no-op if the trustline already exists, so `onboard()` is
  **idempotent with respect to trustline creation** and MAY be retried safely.
  Idempotency is scoped to trustline creation only: it does **not** bypass
  policy. Because `authorize_trustline` re-evaluates policy on every call (§3),
  a retried `onboard()` against a banned, disallowed, or frozen holder MUST fail
  at the authorization step rather than re-authorize the account.
- Because `trust()` and `set_authorized` are both Soroban operations, they
  execute in one transaction; partial states (trustline created but not
  authorized) do not persist on success. On failure the whole Soroban invocation
  reverts.
- Integrators MUST treat `onboard()` as the canonical single-signature entry
  point and MUST NOT require the holder to sign `authorize_trustline`
  separately.

This is **Option A** of the RFP — _authorize trustlines on behalf of users via a
standard interface_. See Design Rationale for why (a) is preferred over (b) an
intermediate account and (c) claimable balances.

> **Verification status.** The reference implementation ships the 2-arg
> discovery router, delivered in this repo with a 17-test native suite (11
> scenario + 6 environment-classification tests) plus opt-in testnet e2e for the
> open (USDC) and discovery (TLO) paths (`tests/e2e/`); the testnet router id is
> pinned in the SDK's `ROUTERS` registry. The native suite demonstrates that the
> **contract-level composition compiles and the happy path authorizes the holder
> through the on-chain discovered admin under mocked auth**, and that divergence
> reverts; the end-to-end single _real_ signature is exercised by the opt-in
> testnet e2e, not asserted by the unit tests.

### 5. The two reserve backends and integrator selection

CAP-73's `trust()` **does not support sponsorship**: the holder pays their own
0.5 XLM trustline reserve. This is correct for a CEX-withdrawal recipient who
already has a funded `G`-account, but it cannot onboard a **brand-new,
zero-XLM** account, which has no reserve to pay. The standard therefore defines
**two backends** and an integrator-side selection rule.

|                                | **Backend 1 — CAP-73 one-signature** (Cases A, C)      | **Backend 2 — CAP-33 sponsored reserve-free** (Case B)                                                                                        |
| ------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Primitive                      | Soroban `SAC.trust()` (CAP-73)                         | Classic `BEGIN/END_SPONSORING_FUTURE_RESERVES` (CAP-33) wrapping the holder's `ChangeTrust` (and `CREATE_ACCOUNT` for a non-existent account) |
| Who pays the reserve(s)        | **Holder** (0.5 XLM trustline reserve)                 | **Sponsor** (1 XLM base reserve if the account must be created + 0.5 XLM trustline reserve)                                                   |
| Authorization (regulated only) | `Authorizer.authorize_trustline` (one Soroban tx)      | Issuer `SetTrustLineFlags(authorized)` or SAC `set_authorized`, in/after the sponsored classic tx                                             |
| Holder signatures              | 1 (Case C); 0 if the trustline already exists (Case A) | 1 holder signature on a multi-signer classic tx (sponsor co-signs; issuer co-signs if authorizing in the same tx)                             |
| Transaction shape              | Single Soroban tx (`onboard`)                          | Classic tx (sponsorship sandwich); cannot be a single Soroban op                                                                              |
| Account precondition           | Holder account already exists and is funded            | Holder must control an on-ledger account to sign; a non-existent account requires sponsored `CREATE_ACCOUNT`                                  |
| Best for                       | Funded holder (CEX withdrawal recipient)               | Brand-new / underfunded user (zero spendable XLM)                                                                                             |

**Why two:** classic and Soroban operations cannot be mixed in one transaction.
The one-signature atomic `onboard()` is only achievable on the Soroban side via
CAP-73 — but CAP-73 has no sponsorship. Reserve-free onboarding requires the
_classic_ sponsored-reserve construction (CAP-33), which is two-or-more classic
ops and therefore cannot be a single Soroban transaction. Papering over this
would be incorrect; the standard surfaces it.

#### Account existence on Backend 2 (normative)

Backend 2 onboards an account with **zero spendable XLM**, but it MUST
distinguish two cases, because an account that does not yet exist on the ledger
cannot sign anything and cannot hold a trustline:

- **(a) Existing account, insufficient XLM.** The holder account already exists
  (it holds at least the base reserve) but lacks the 0.5 XLM trustline reserve.
  The sponsor sponsors only the **trustline reserve**. The holder co-signs
  `ChangeTrust` / `END_SPONSORING_FUTURE_RESERVES` with the key that controls
  the existing account.
- **(b) Brand-new (non-existent) account.** The target `G`-address has no
  account entry. The transaction MUST additionally **create the account** via a
  `CREATE_ACCOUNT(holder, starting_balance)` sourced from the sponsor, so the
  sponsor pays **both** the 1 XLM base reserve **and** the 0.5 XLM trustline
  reserve. The holder keypair MUST control the resulting on-ledger account to
  provide its single signature on `ChangeTrust` /
  `END_SPONSORING_FUTURE_RESERVES`.

In both cases the holder MUST control an on-ledger account to sign
`END_SPONSORING_FUTURE_RESERVES` and `ChangeTrust`; the sponsor co-signs and
pays the sponsored reserves. The integrator MUST NOT treat "zero spendable XLM"
as equivalent to "account does not exist": the latter requires the additional
sponsored account creation in (b).

#### Selection rule (normative)

An integrator MUST select the backend as follows, in order:

1. If the asset is `AUTH_REQUIRED` **and** the holder already has an
   **unauthorized** trustline → **Case A**: call `authorize_trustline(holder)`
   on-behalf, **zero holder signatures**.
2. Else, if the holder's account **exists** and its available balance ≥ the next
   reserve increment (0.5 XLM) → **Case C / Backend 1** (CAP-73 `onboard()`, or
   for an open asset a plain `ChangeTrust` the holder signs once).
3. Else, if the issuer advertises `BACKENDS` including `cap33-sponsored` and
   offers a sponsor → **Case B / Backend 2**:
   - holder account **exists** but underfunded → **Backend 2 (a)** (sponsor the
     trustline reserve);
   - holder account **does not exist** → **Backend 2 (b)** (sponsor base +
     trustline reserve, including `CREATE_ACCOUNT`).
4. Else, fall back to the legacy two-step flow (holder `ChangeTrust`, then
   `authorize_trustline`) as a recovery path.

Both backends MUST result in the same end state: the holder holds an
**authorized** trustline for a regulated asset, or a usable trustline for an
open asset.

### 6. `stellar.toml` discovery — `[TRUSTLINE_ONBOARDER]`

Per
[SEP-1](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0001.md),
an issuer advertises onboarder support with a `[TRUSTLINE_ONBOARDER]` table in
its `stellar.toml`. Any integrator reads exactly this block to drive the flow —
one issuer config yields universal interop, with no bilateral integration deals.

| Field               | Type   | Req.  | Description                                                                                                                                                                                               |
| ------------------- | ------ | :---: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VERSION`           | string |  yes  | Onboarder protocol version this issuer implements (e.g., `"0.3"`).                                                                                                                                        |
| `ASSET_CODE`        | string |  yes  | Classic asset code being onboarded.                                                                                                                                                                       |
| `ASSET_ISSUER`      | `G…`   |  yes  | Classic issuer account.                                                                                                                                                                                   |
| `SAC`               | `C…`   |  yes  | Stellar Asset Contract address of the asset.                                                                                                                                                              |
| `AUTHORIZER`        | `C…`   |  no   | Trustline Authorizer contract (the SAC admin). INFORMATIONAL for the one-signature path (the router discovers the admin on-chain); used by integrators for the zero-signature Case-A authorize-on-behalf. |
| `ONBOARD_WRAPPER`   | `C…`   | cond. | The Trustline Onboard **router** exposing `onboard(sac, holder)`. REQUIRED if `cap73-onesig` is in `BACKENDS`. Integrators SHOULD prefer a pinned/curated router id over an advertised one.               |
| `POLICY`            | string | cond. | `"denylist"` or `"allowlist"`. REQUIRED when `AUTHORIZER` is set.                                                                                                                                         |
| `BACKENDS`          | list   |  yes  | Ordered preference, subset of `["cap73-onesig", "cap33-sponsored"]`.                                                                                                                                      |
| `SPONSOR`           | `G…`   | cond. | Reserve sponsor account. REQUIRED if `cap33-sponsored` is in `BACKENDS`.                                                                                                                                  |
| `AUTH_ENDPOINT`     | url    |  no   | Off-chain authorization/KYC endpoint (allowlist policy). SHOULD be SEP-10 gated.                                                                                                                          |
| `WEB_AUTH_ENDPOINT` | url    | cond. | SEP-10 endpoint used to authenticate to `AUTH_ENDPOINT`. REQUIRED if `AUTH_ENDPOINT` is set.                                                                                                              |

Example (regulated asset, denylist / open-by-default):

```toml
[TRUSTLINE_ONBOARDER]
VERSION = "0.3"
ASSET_CODE = "EURCV"
ASSET_ISSUER = "GCEYGIVOLAVBF2TG2RUSGTUJCIN75KEX3NGLMY4VPL4GFE5L355AXW3G"
SAC = "CANKBYNNAYKEZXLB655F2UPNTAZFK5HILZUXL7ZTFR3NF6LKDSVY7KFH"   # SAC for EURCV
AUTHORIZER = "CB2DHZMQHQE3TGUMD6BRM7UCJZNIPKDRVEQOWBIRRS3G2FZOGDTRKSB3"
ONBOARD_WRAPPER = "C…"              # Trustline Onboard wrapper
POLICY = "denylist"
BACKENDS = ["cap73-onesig", "cap33-sponsored"]
SPONSOR = "G…"                      # reserve sponsor for new / underfunded users
# AUTH_ENDPOINT / WEB_AUTH_ENDPOINT omitted: denylist policy is self-service
```

Example (open asset — no Authorizer, no authorize step):

```toml
[TRUSTLINE_ONBOARDER]
VERSION = "0.3"
ASSET_CODE = "USDC"
ASSET_ISSUER = "G…"
SAC = "C…"
ONBOARD_WRAPPER = "C…"              # required: cap73-onesig is in BACKENDS
# AUTHORIZER / POLICY omitted: asset is not AUTH_REQUIRED
BACKENDS = ["cap33-sponsored", "cap73-onesig"]
SPONSOR = "G…"
```

> The `AUTHORIZER` and `SAC` values above are the live mainnet EURCV contracts
> (`eurcv_auth` admin `CB2DHZ…KSB3`; SAC `CANKBYNN…7KFH`), pinned and verified
> in the SDK registry. `ONBOARD_WRAPPER` is shown as a placeholder pending the
> asset-agnostic deployment delivered by the grant. Testnet reference
> deployments are listed in the Reference Implementation section.
>
> Wire-token note: `BACKENDS` uses the short form `cap73-onesig`; the SDK's
> `Backend` type is the canonical `cap73-one-signature`, and
> `parseOnboarderToml` normalizes the wire token to it. Match on the SDK enum,
> not the wire literal.

### 7. Integrator interface and handoffs

A conformant integrator implements the following surface (the reference
implementation is the `@theahaco/authline` TypeScript SDK):

- `discover(toml)` — parse the issuer's `stellar.toml` `[TRUSTLINE_ONBOARDER]`
  block into a config. One config, any integrator.
- `decodeOnboardStatus(returnValue)` — decode the router's `OnboardStatus`
  (`Authorized` | `TrustlineOnly`) from a transaction's return value, so the
  integrator reports the truthful outcome instead of treating tx success as full
  activation. Capability detection is on-chain in the router; there is no
  client-side `auth_required` pre-check.
- `status(address)` — report whether the holder holds a trustline and whether it
  is authorized, to select the case (§2) and to confirm completion.
- `buildSponsoredOnboardTx(...)` — build a reserve-free classic `ChangeTrust`
  (Backend 2 / Case B), with an optional sponsored `CreateAccount` for a
  brand-new account.
- `buildAuthorizeTx(...)` — build the permissionless authorize-on-behalf call
  (Case A; no holder/issuer signature).
- `buildOnboardTx(...)` — build the CAP-73 one-transaction `onboard()` (Backend
  1 / Case C).
- `onboardingRequest(...)` — produce the **handoffs**: a **SEP-7**
  `web+stellar:` URI, a wallet **deep link**, and a **hosted-redirect URL**. An
  exchange withdrawal screen hands the user off via any of these; a Stellar
  Wallets Kit wallet opens and signs the SEP-7 URI.

The handoffs decouple the third party that _initiates_ onboarding from the
wallet that holds the user's key: the third party builds the transaction and
emits a SEP-7 URI / deep link / hosted URL; the user's wallet completes the
at-most-one signature. The hosted-redirect target MAY be a reference "activation
page" (one reference consumer of this interface), but the standard does not
require any hosted page — a wallet that embeds the SDK can drive the flow
in-app.

**Co-signatures in a handoff.** A SEP-7 wallet adds the _holder's_ signature and
submits. That completes a **Backend 1 / Case C** transaction, whose only
required signer is the holder. It does **not** complete a **Backend 2 / Case B**
transaction: the sponsor sources the envelope and must sign it as well. An
integrator handing off a sponsored transaction MUST therefore either sign as the
sponsor **before** emitting the URI — a SEP-7 `xdr` is a full
`TransactionEnvelope`, so that signature travels with it and the holder's
completes it — or set the SEP-7 `callback` parameter so the wallet returns the
signed XDR for the integrator to countersign and submit. Emitting an unsigned
sponsored envelope with no `callback` produces a signature request that cannot
succeed, and implementations SHOULD reject it rather than hand the user a link
that fails on submit.

For an **allowlist** policy, the integrator MUST ensure the holder is allowed
before submitting: it SHOULD authenticate to `WEB_AUTH_ENDPOINT` (SEP-10) and
call `AUTH_ENDPOINT` to trigger off-band KYC and a subsequent `allow(holder)` by
the Authorizer admin.

#### Backend 1 — CAP-73 one-signature (funded holder, Case C)

```
Integrator (3rd party)              Holder                      Chain
    │ GET <issuer>/.well-known/stellar.toml; discover()          │
    │◄── [TRUSTLINE_ONBOARDER] ────────┤                           │
    │ build tx: invoke ONBOARD_WRAPPER.onboard(SAC, holder)
    │── SEP-7 URI / deep link ────────►│                           │
    │                                  │ sign (1 holder signature) │
    │◄─────────────────────────────────┤                           │
    │── submit ───────────────────────────────────────────────────►│
    │                                  │      trust(holder) [CAP-73]│
    │                                  │      authorize_trustline   │
    │                                  │      → set_authorized(true)│
    │◄── success: authorized trustline ───────────────────────────┤
```

#### Backend 2 — CAP-33 sponsored reserve-free (new / underfunded holder, Case B)

The holder signs **once**; the transaction is a **multi-signer classic
transaction** that the sponsor (and the issuer, when authorizing in the same tx)
also co-sign. For a brand-new account, `CREATE_ACCOUNT` is included so the
sponsor pays the base reserve as well; for an existing underfunded account, omit
`CREATE_ACCOUNT`.

```
Integrator (3rd party)              Holder                Sponsor / Issuer
    │ read toml → POLICY, SPONSOR      │                           │
    │ build classic tx:               │                           │
    │   BEGIN_SPONSORING_FUTURE_RESERVES(holder)  [source: SPONSOR]│
    │   CREATE_ACCOUNT(holder, base)   [source: SPONSOR]  (new acct only)
    │   ChangeTrust(asset)                         [source: holder]│
    │   END_SPONSORING_FUTURE_RESERVES             [source: holder]│
    │   SetTrustLineFlags(holder, AUTHORIZED)  [source: issuer/SAC admin]  (regulated only)
    │── SEP-7 URI / deep link ────────►│                           │
    │◄── holder signs (1 signature) ───┤                           │
    │── co-sign (SPONSOR + issuer) ───────────────────────────────►│
    │── submit ───────────────────────────────────────────────────►│
    │◄── success: authorized trustline, reserves paid by SPONSOR ──┤
```

> The holder MUST control an on-ledger account to sign
> `END_SPONSORING_FUTURE_RESERVES`/`ChangeTrust`. A brand-new (non-existent)
> account is created in the same transaction via the sponsored `CREATE_ACCOUNT`,
> and the holder keypair must control that account to provide its single
> signature (§5 "Account existence").

A status check MUST be available by reading the holder's trustline flags
(classic) or the Authorizer's recorded authorization state. After success the
holder's trustline has the `authorized` flag set (regulated) or simply exists
(open).

### 8. Audit events

The Authorizer MUST emit a structured event for every authorization-state
transition so issuers can build a MiCA-style audit trail without an indexer of
their own.

| Topic                                              | Data                                   | Emitted on                                    |
| -------------------------------------------------- | -------------------------------------- | --------------------------------------------- |
| `("authorized", account)`                          | `{ policy, authorizer_admin, ledger }` | successful `authorize_trustline`              |
| `("deauthorized", account)`                        | `{ reason, authorizer_admin, ledger }` | `deauthorize_trustline`                       |
| `("banned", account)` / `("unbanned", account)`    | `{ authorizer_admin, ledger }`         | denylist updates                              |
| `("allowed", account)` / `("disallowed", account)` | `{ authorizer_admin, ledger }`         | allowlist updates                             |
| `("frozen", account)` / `("unfrozen", account)`    | `{ authorizer_admin, ledger }`         | freeze lifecycle (ban/disallow + deauthorize) |
| `("clawback", from)`                               | `{ amount, authorizer_admin, ledger }` | clawback                                      |
| `("paused")` / `("unpaused")`                      | `{ authorizer_admin, ledger }`         | pause lifecycle                               |

Events MUST identify the policy in force and the admin that authorized the state
change. `reason` SHOULD be an enumerated code (e.g., `sanctions`, `kyc_expired`,
`issuer_request`) to support compliance reporting.

## Design Rationale

### Why Option A (authorize on behalf via a standard interface)

The RFP names three candidate mechanisms for frictionless activation: **(a)**
authorize trustlines on behalf of users via a standard interface, **(b)** an
intermediate account that holds and forwards, **(c)** claimable balances. This
SEP specifies **(a)** as the primary, general path and documents (b)/(c) as
situational alternatives.

- **(a) Authorize on behalf** keeps the holder as the **direct, sole owner** of
  the trustline and the asset. It works for both asset classes: for open assets
  it is a sponsored `ChangeTrust`; for regulated assets it adds permissionless
  authorize-on-behalf. With CAP-73 it is a single signature and a single atomic
  transaction (Case C), and for a pre-existing unauthorized trustline it is
  **zero** signatures (Case A). Authorization policy is on-chain (Authorizer =
  SAC admin), so it is deterministic and auditable. This matches the live EURCV
  model and the **merged** one-signature reference (`authline` PR #10), so the
  standard is grounded in working code.
- **(b) Intermediate account** has the third party control a temporary account,
  trust + receive there, then forward. It unblocks the _exchange side_, but the
  **user still needs their own trustline** to finally hold the asset — so it
  suits **custodial** flows or new-account provisioning, not self-custody. It
  adds a custodial hop, a second transfer, reconciliation, and — for a regulated
  asset — a custody/liability question.
- **(c) Claimable balances** let the third party send a claimable balance to a
  trustline-less user, so the withdrawal completes with **zero user action at
  that moment**; the user creates a trustline and **claims later**. It defers
  rather than removes the trustline step, and claimable-balance entries consume
  reserves.

  The deferred cost is **one signature for an open asset and two for a regulated
  one**, and the difference is a protocol constraint, not an implementation
  choice. For an open asset the claim transaction can carry the `ChangeTrust`
  that onboards the user —
  `BeginSponsoringFutureReserves · ChangeTrust · EndSponsoringFutureReserves · ClaimClaimableBalance`
  — so a single user signature both establishes the trustline and collects the
  funds, and with the sender as fee source and sponsor the user spends no XLM at
  all. For an `AUTH_REQUIRED` asset the claimant must be authorized **at claim
  time**, and authorization here is a Soroban call to the Authorizer; a Soroban
  invocation must be the **only** operation in its transaction (the network
  rejects a mixed envelope with `Transaction contains more than one operation`),
  so it cannot be placed between the `ChangeTrust` and the claim. A regulated
  claim is therefore necessarily three transactions — create trustline (user),
  authorize (**integrator, no user signature**, i.e. Case A), claim (user).

  This is implemented in the reference SDK as an extension —
  `buildClaimableBalanceDelivery`, `planClaim`, `buildClaimTx`,
  `getClaimableBalance`, `findClaimableBalances` — and both paths, including the
  on-chain rejection of the fused regulated claim, are exercised against testnet
  by `tests/e2e/testnet-claimable.e2e.test.ts`. It remains **outside the
  normative interface** below: an integrator can interoperate fully without it.

We chose **(a)** as primary: the general, non-custodial, interoperable path that
works for both asset classes; **(b)/(c)** are documented situational
alternatives. (b) and (c) are not part of the normative interface.

### Why two backends instead of one

See §5. A single backend cannot serve both a funded CEX-withdrawal recipient
(where CAP-73's no-sponsorship one-signature path is ideal) and a brand-new
zero-XLM user (who needs someone else to pay the base and trustline reserves,
which only the classic CAP-33 sponsorship construction provides). The standard
exposes both and a deterministic selection rule rather than forcing integrators
to pick wrong. The "one signature" property differs by backend: on Backend 1 the
holder signs a single Soroban transaction; on Backend 2 the holder still signs
only once, but on a multi-signer classic transaction co-signed by the sponsor
(and issuer). The standard is explicit about this so the one-signature claim is
never read as "single-signer."

### Why a contract as SAC admin (vs issuer-key authorization)

Setting a policy contract as SAC admin moves the authorization decision
on-chain. The policy (denylist/allowlist) is then transparent, deterministic,
retryable, and self-service for the common (denylist) case, and every state
change emits an audit event. Off-chain issuer-key authorization provides none of
these, requires the issuer to co-sign (as a SEP-8 approval server does, per
transaction), and cannot be composed atomically with CAP-73 `trust()`.
Delegating once to a permissionless contract replaces per-transaction co-signing
with a one-time admin transfer.

## Security Considerations

- **Admin compromise.** The Authorizer's `admin` can ban/freeze/clawback/mint
  and can `upgrade` the contract. Issuers SHOULD use a multisig or threshold
  account as the Authorizer admin (`admin-sep` `set_admin`), and SHOULD treat
  `upgrade` and `clawback` as the highest-privilege operations.
- **The holder's signature covers the discovered admin's sub-invocations.**
  `onboard()` invokes the asset's SAC admin — a contract chosen by the _asset_,
  not by the integrator. In recording-mode simulation, any nested
  `holder.require_auth()` the admin triggers is folded into the single root
  authorization the holder signs, and the router cannot prevent a malicious
  admin from abusing this. Integrators MUST therefore only onboard SACs from a
  trusted/pinned source (the curated registry), and wallets SHOULD render the
  full authorization tree before signing.
- **Permissionless self-authorization (denylist).** Under the denylist policy,
  `authorize_trustline` is intentionally permissionless — any non-banned account
  may authorize itself or be authorized on-behalf. Issuers requiring per-user
  gating MUST use the allowlist policy. Sanctions screening for the denylist
  MUST be enforced by keeping the banned set current; the standard cannot screen
  accounts the issuer has not banned.
- **Replayed authorization and the freeze lifecycle.** Because
  `authorize_trustline` is permissionless under denylist and a retried
  `onboard()` re-runs the authorization step, `authorize_trustline` MUST consult
  the policy on **every** call (§3), and `freeze_accounts` MUST set the
  banned/disallowed bit in addition to deauthorizing (§3 "Freeze / deauthorize
  lifecycle"). A frozen-but-not-banned state MUST NOT exist; otherwise a
  replayed `onboard()` would re-authorize a previously frozen account. Where
  stronger reversibility is needed, the issuer retains `clawback` (under
  `AUTH_CLAWBACK_ENABLED`).
- **`CannotAuthorizeAdminContract`.** The Authorizer MUST refuse to authorize
  its own address to avoid self-referential trust states.
- **Reserve griefing on the sponsored backend.** Backend 2's sponsor pays the
  base and/or trustline reserve. The sponsor SHOULD rate-limit and/or KYC-gate
  sponsorship to prevent reserve drain, and SHOULD reclaim reserves on
  trustline/account removal where applicable.
- **Reentrancy / partial state.** `onboard()` runs `trust()` then
  `authorize_trustline()` in one Soroban invocation; a failure reverts both.
  Implementations MUST NOT leave a trustline created-but-unauthorized as a
  _persisted success_ state.
- **`stellar.toml` integrity.** Integrators MUST fetch `stellar.toml` over TLS
  from the issuer's `home_domain` and SHOULD verify the `AUTHORIZER`/`SAC`
  addresses against an out-of-band source before authorizing high-value flows. A
  compromised `stellar.toml` could redirect users to a malicious wrapper; the
  on-chain `onboard()` still requires the holder's signature, but the holder
  could be induced to sign against a wrong asset. SEP-7 URIs and deep links
  carry the same obligation: the wallet SHOULD display the asset and contract
  being signed.
- **CAP-73 no-op semantics.** `trust()` is a no-op for existing trustlines and
  C-addresses. Integrators MUST NOT assume `onboard()` created a _new_
  trustline; idempotency is a property to rely on, not a signal that nothing
  existed before.
- **SEP-10 gating.** Any off-chain `AUTH_ENDPOINT` (allowlist KYC) MUST be
  authenticated with SEP-10 to bind the request to the holder's account.

## Backwards Compatibility

This SEP introduces no protocol change and is **purely additive**.

- Issuers that do not publish `[TRUSTLINE_ONBOARDER]` are unaffected; wallets
  simply do not offer the onboarding flow.
- Open (non-`AUTH_REQUIRED`) assets need no Authorizer; the standard degrades to
  a sponsored `ChangeTrust` for them.
- The legacy two-step flow (holder signs `ChangeTrust`, then
  `authorize_trustline` is called) remains valid and is retained as the explicit
  recovery path (selection rule step 4, §5).
- The `onboard()` wrapper depends on CAP-73's `SAC.trust()`, live since Protocol
  26; integrators on pre-26 history MUST use Backend 2 or the legacy path. The
  standard therefore degrades gracefully if CAP-73 is unavailable.
- `admin-sep` compatibility: the Authorizer is an `Administratable` contract, so
  any tooling that understands `admin-sep`'s `admin`/`set_admin`/`upgrade`
  surface works unchanged.

## Reference Implementation

The public reference implementation (work in progress for SCF #44) is at
[github.com/theahaco/authline](https://github.com/theahaco/authline)
(Apache-2.0; formerly `theahaco/stellar-assets`, which redirects).

| Component                                                                                                                                                                                                                                                                                                                                     | Status                                                    | Reference                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eurcv_auth` Trustline Authorizer (denylist, set as SAC admin; `authorize_trustline`, `add/remove_banned_accounts`, `freeze/unfreeze_accounts`, `deauthorize_trustline`, `clawback`, `mint_to_account`, `pause/unpause`, `upgrade`)                                                                                                           | **LIVE on mainnet**                                       | `theahaco/eurcv_auth` (repo private — available on request); mainnet contract [`CB2DHZ…KSB3` on Stellar Expert](https://stellar.expert/explorer/public/contract/CB2DHZMQHQE3TGUMD6BRM7UCJZNIPKDRVEQOWBIRRS3G2FZOGDTRKSB3); activation page `https://eurcv.theaha.co` (currently a two-step / two-transaction flow, not yet one-signature)                                                                                          |
| `onboard()` one-signature discovery router over CAP-73 `trust()`                                                                                                                                                                                                                                                                              | **DELIVERED in this repo** (this grant)                   | `contracts/trustline-onboard` — `onboard(sac, holder)` with on-chain authorizer discovery (CAP-68 `get_address_executable` + `SAC.admin()`). Delivered: a 17-test native suite (11 scenario + 6 environment-classification tests) plus opt-in testnet e2e for the open (USDC) and discovery (TLO) paths (`tests/e2e/`); the testnet router id is pinned in the SDK's `ROUTERS` registry (`packages/authline-sdk/src/registry.ts`). |
| Contract Admin SEP (`Administratable` + `Upgradable`) — built upon by §3                                                                                                                                                                                                                                                                      | Draft                                                     | [github.com/theahaco/admin-sep](https://github.com/theahaco/admin-sep) (SDF discussion #1670)                                                                                                                                                                                                                                                                                                                                      |
| Asset-agnostic **Trustline Authorizer** — the full §3 interface (both policies, `authorize_trustline`, `add/remove_banned_accounts`, `allow/disallow`, `freeze/unfreeze_accounts`, `deauthorize_trustline`, `mint_to_account`, `clawback`, `pause/unpause`, `set_policy`, `admin`/`set_admin`/`upgrade`) with a §8 event for every transition | **DELIVERED in this repo + LIVE on testnet** (this grant) | `contracts/trustline-authorizer` — 36-test native suite including the freeze-replay and paused-rejects-everything cases and five router-integration tests. Testnet `CDTDC7PMCJLEH53XEGGG2XIMYYP2M4N6DQS4NTZPY6IIBWFPYRI6ZZSM`, SAC admin of the pinned EURCV test token, replacing the Tranche-1 stub. Earlier partial deployment: `CD7K7S43HSIR2DLGDT5OWSHDJQIQWFAJWZOIO66T2OVMLNYFL74OK2KU` (still the TLO test asset's admin).  |
| Issuer admin **CLI** + runbook                                                                                                                                                                                                                                                                                                                | **DELIVERED in this repo** (this grant)                   | `scripts/authorizer.mjs` (`npm run authorizer -- …`) wrapping every entry point, with typed-error explanations and an event-log reader; runbook at `docs/authorizer-runbook.md`.                                                                                                                                                                                                                                                   |
| **Trustline Onboard** CAP-73 wrapper (testnet)                                                                                                                                                                                                                                                                                                | **SUPERSEDED** (v0.2, 3-arg interface)                    | `CCQJ53C6C7ROJ6DSUG572NN46W3KHRT3BF3RDLZL4PGB4JYICDTPSAZ5`. Replaced by the v0.3 discovery router — current testnet id is pinned in the SDK's `ROUTERS` registry (`packages/authline-sdk/src/registry.ts`).                                                                                                                                                                                                                        |
| Test asset **TLO** (`AUTH_REQUIRED`) — SAC / issuer                                                                                                                                                                                                                                                                                           | testnet                                                   | SAC `CDVVAQAQ4FKQ4DCPPIIOIAOPRJJBO6HVOXRQX3PXONJVJNNK432O6HW3`, issuer `GATBENNAFELDD6XLFPIMT3GBYAGWT4A7XY45P4YCFVPK2HHRNC2HQJ4U`                                                                                                                                                                                                                                                                                                  |
| `@theahaco/authline` integrator SDK (`discover`, `status`, `decodeOnboardStatus`, `buildSponsoredOnboardTx`, `buildAuthorizeTx`, `buildOnboardTx`, `onboardingRequest`), reference exchange-withdrawal integration, activation page, issuer admin CLI, and this `stellar.toml` block                                                          | **IN PROGRESS** (this grant)                              | [github.com/theahaco/authline](https://github.com/theahaco/authline)                                                                                                                                                                                                                                                                                                                                                               |
| Authorization **relayer** — HTTP wrapper over the §7 integrator interface: `GET /v1/accounts/{a}/ready` (readiness + live policy eligibility) and `POST /v1/accounts/{a}/authorize` (permissionless Case-A authorize), so an integrator needs no Stellar SDK at all; ships as a Docker image for self-hosting                                 | **DELIVERED in this repo** (this grant)                   | `packages/relayer` — unit tests (mocked chain, in CI) plus an opt-in testnet e2e driving the full ready → authorize → ready flip over plain HTTP (`tests/e2e/testnet-relayer.e2e.test.ts`); runbook at `docs/relayer-runbook.md`; MiCA/data-protection design note at `docs/mica-authorization-model.md`.                                                                                                                          |

#### Integration without a Stellar SDK — what the relayer taught us

Wrapping the §7 integrator interface in two HTTP endpoints surfaced three points
that any implementation of this SEP should carry over (non-normative):

- **"Not ready" is three different states, not one.** The integrator's remedial
  action differs per state, so a readiness answer must distinguish `no_account`
  (fund it, or deliver via claimable balance), `no_trustline` (onboard through
  the router / sponsored flow), and `trustline_unauthorized` (the §3 authorize
  fixes it). A missing account and a missing trustline read identically from the
  trustline ledger entry — disambiguating them costs one extra account lookup
  and is worth it.
- **Expose the policy pre-check.** `is_eligible` (§3) should be consulted before
  submitting an authorize the integrator pays fees for: a readiness response
  that carries `authorizable: false` turns a fee-costing on-chain refusal into a
  free read. When the policy cannot be read, say "unknown" rather than guessing.
- **Authorize-on-behalf must be idempotent at the service layer.** Exchange
  flows naturally race (retry queues, duplicate webhooks); answering an
  already-authorized account with success-without-submission makes the
  permissionless entry point safe to call from at-least-once pipelines.

Because `authorize_trustline` is permissionless and the policy is enforced by
the Authorizer contract, the relayer holds **no authority**: its key only pays
fees, and denying service at the relayer denies nothing — the contract remains
the single enforcement point. The accompanying design note
(`docs/mica-authorization-model.md`) builds on exactly that property: every
compliance-relevant fact lives on-chain as an address plus enumerated codes, and
no personal data exists anywhere in the flow.

#### Proven on testnet

**v0.3 — one-signature discovery router (this grant's deliverable).** A
brand-new friendbot-funded holder establishes an **authorized** trustline to the
`AUTH_REQUIRED` test asset **TLO** in a **single transaction, one signature**.
`buildOnboardTx` targets the pinned router (`ROUTERS.TESTNET` =
`CABVVUYHXS6UVN2VYYXKEUO2XEJIAGMTEYF2BOWGUUJVOO2IGPRWZAX4`), which runs CAP-73
`trust()` and then discovers the SAC admin's `authorize_trustline` on-chain
(CAP-68) and calls it in the same transaction. Final state, read back over
Stellar RPC: `hasTrustline = true`, `isAuthorized = true` — the `isAuthorized`
bit proves the **discovered** authorize step ran, since `trust()` alone would
leave an `AUTH_REQUIRED` line unauthorized. This runs **end-to-end in pure
JavaScript** — build, simulate (`prepareTransaction`), submit, and decode the
`OnboardStatus` return value — with no Rust-CLI fallback, and is reproducible
via `RUN_TESTNET_E2E=1 npm run test:e2e:testnet`
(`tests/e2e/testnet-tlo.e2e.test.ts`; the open-asset USDC path is covered by
`testnet-usdc.e2e.test.ts`).

**Both asset classes, one router — on-chain evidence (2026-08-12).** One
onboarding of each asset type through the pinned testnet router, each a single
transaction signed only by a brand-new friendbot-funded holder:

| Asset class                 | Asset                             | Holder          | `onboard` transaction                                                                                                                                                                        |
| --------------------------- | --------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Regulated (`AUTH_REQUIRED`) | **TLO** (SAC admin = Authorizer)  | `GDI7RTZM…X2RE` | [`dd80eacc…8488`](https://stellar.expert/explorer/testnet/tx/dd80eaccb5db273836517565843a712353e314182cdba9ad25015a3d60fc8488) — discovery ran: `hasTrustline = true`, `isAuthorized = true` |
| Open (not `AUTH_REQUIRED`)  | **USDC** (testnet, Circle issuer) | `GABGK323…5KK3` | [`1c00ce17…20c9`](https://stellar.expert/explorer/testnet/tx/1c00ce17b99dde1a27970b0804c8edc220bd7f3a72aadf9099490099be8620c9) — `trust()` only, returns `Authorized`                        |

**Claimable-balance delivery — on-chain evidence (2026-08-19).** A withdrawal to
a recipient with no trustline, completed as a claimable balance and collected
later by the user. Reproducible via `RUN_TESTNET_E2E=1 npm run test:e2e:testnet`
(`tests/e2e/testnet-claimable.e2e.test.ts`).

| Asset class                 | Step                                       | Transaction                                                                                                                    | User signatures                                             |
| --------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Open (not `AUTH_REQUIRED`)  | Exchange delivers the claimable balance    | [`df5ffa36…b7f6`](https://stellar.expert/explorer/testnet/tx/df5ffa36f04816ff4aa325ef63e0863939be6599b3ec6a540e07b5ef1fa6b7f6) | **0** — the user is not involved at all                     |
| Open (not `AUTH_REQUIRED`)  | User claims; the claim opens the trustline | [`3c9bb5e6…faf9`](https://stellar.expert/explorer/testnet/tx/3c9bb5e615e72c24f8e3ef328d6b6d46248b524e5159e68861b5351dda86faf9) | **1** — 4 ops, 2 signatures, exactly one of them the user's |
| Regulated (`AUTH_REQUIRED`) | Final claim of the three-step plan         | [`c6dda920…1347`](https://stellar.expert/explorer/testnet/tx/c6dda9203db3bcccb571ef71a8e3b0f8521c1490b65413c18d1727d49ca41347) | **1** (2 across the plan; the authorize step costs none)    |

In the open-asset claim the recipient ends holding the full delivered amount
with their XLM untouched at the 1 XLM they were created with: the sender was
both fee source and sponsor, so the user paid neither the fee nor the 0.5 XLM
reserve. The e2e also asserts the two negative results this design rests on — a
plain payment to a trustline-less recipient is rejected, and the _fused_
one-signature claim is rejected by the network for an `AUTH_REQUIRED` asset
because the trustline created inside the claim envelope is still unauthorized
when `ClaimClaimableBalance` runs. Neither produces a ledger entry, so both are
reproducible only by running the suite.

**Case A in pure JavaScript (2026-08-19).** The permissionless
authorize-on-behalf step now runs through the SDK's `buildAuthorizeTx` with no
Rust-CLI fallback:
[`91f03714…47b9`](https://stellar.expert/explorer/testnet/tx/91f037142a0e3dae7776748f2a4faa4c1809023ad8bff2fe8a594af8658847b9)
— **one signature, from the exchange**, sourced by the exchange account, with
the holder appearing only as the call argument
(`examples/exchange-withdrawal/demo.mjs`).

**Authorization lifecycle on real trustlines (2026-08-20).** The pinned testnet
EURCV test token was re-issued with the full asset-agnostic Trustline Authorizer
as its SAC admin (`CDTDC7PM…ZZSM`), replacing the Tranche-1 stub — SAC adminship
is one-way and the stub exposed no `set_admin`, so the old instance could not be
upgraded in place. Both §3 paths were then exercised against it on-chain, along
with the freeze invariant this SEP rests on:

| Step                                                            | Result                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One-signature `onboard()` through the pinned router             | [`26508a57…1e32`](https://stellar.expert/explorer/testnet/tx/26508a57895a9e2879412e0849e0b0dd4d7dc185896ea572e1af120040441e32) — `Authorized`; the authorizer was discovered from `SAC.admin()`, not configured                                                               |
| `mint_to_account` 100, `clawback` 40                            | [`de1bfee1…7919`](https://stellar.expert/explorer/testnet/tx/de1bfee172542dddda20bb2ff1b9009fd7bf3b6a419ac87ddd69d8aee9937919) · [`83c6291d…0293`](https://stellar.expert/explorer/testnet/tx/83c6291d36889b0d3ca5220359084718910e03576d15654754f9736bee860293)               |
| `freeze_accounts` — ban **and** deauthorize                     | [`ae94a3af…5245`](https://stellar.expert/explorer/testnet/tx/ae94a3afc8fd65e744ac3e9837f1e40a6ac96ce0fcf1589bfa771fc8da2e5245) — event `frozen{deauthorized:true}`                                                                                                            |
| Frozen holder **deletes** the trustline (`ChangeTrust` limit 0) | [`b33187c4…f073`](https://stellar.expert/explorer/testnet/tx/b33187c4c86c9e9d4098b4ea645665290149ee2fa36bb4cba6d04297a422f073)                                                                                                                                                |
| …then replays `onboard()` on a clean slate                      | **refused** — router `AuthorizationRefused`, no trustline created: the ban is bound to the address, not the trustline                                                                                                                                                         |
| `unfreeze_accounts`, then onboard again                         | [`8a4ad600…fcc7`](https://stellar.expert/explorer/testnet/tx/8a4ad60045a1749bb2490924052baf0dd511916e70539e8caa1bb59ce92fccc7) · [`e336c3c4…3c2`](https://stellar.expert/explorer/testnet/tx/e336c3c41a9718be5956a03bef264b8d22d6e56dc95bf629bd56e3e3d45a23c2) — `Authorized` |
| `pause` refuses `authorize_trustline` **and** `ban`; `unpause`  | [`5e207c88…efa5`](https://stellar.expert/explorer/testnet/tx/5e207c88a29356e6e69c1a402512fa987937da06d01a3e1d9a35e5856204efa5) · [`5b6caa47…1cd98`](https://stellar.expert/explorer/testnet/tx/5b6caa47a63d7f14e5f13a9df5d95cfc6516134fc9d47e85c53ed6849b21cd98)              |

The §8 audit trail for the whole run is readable from the ledger with
`npm run authorizer -- history`. The router and authorize-on-behalf paths are
reproducible via
`RUN_TESTNET_E2E=1 npx vitest run tests/e2e/testnet-eurcv.e2e.test.ts`.

**v0.2 — sponsored two-transaction flow (Backend 2 / Case B).** An earlier
reference exchange-withdrawal demo established an authorized trustline for a
brand-new **zero-XLM** user against TLO via (1) a sponsored `ChangeTrust`
(exchange pays the reserve, user signs once) — tx
`b001cc0f183b5a554b2abb004f0f424227e728354917aafae5aa0fee390464e8` — and (2) a
separate authorize-on-behalf, no user or issuer signature — tx
`2a1257b2eac34114e0face7f07080bb602c85d573deddd59401a29f55eca6479`. Both are
verifiable on Stellar Expert (testnet).

CAP-73 is the protocol dependency:
[core/cap-0073.md](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0073.md)
(Protocol 26, _"Yardstick,"_ mainnet 2026-05-06).

## Changelog

| Version | Date       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v0.0.1  | 2026-08-31 | Submission version. The SEP process (`ecosystem/README.md`) requires a newly submitted draft to start at `v0.0.1` with the number left `To Be Assigned`. The 0.1–0.6 rows below are this document's pre-submission history in the reference-implementation repo, kept for provenance.                                                                                                                                                                                                                                                                                                                                                                                        |
| 0.6     | 2026-08-20 | Added the authorization relayer to Reference Implementation — the §7 integrator interface as two HTTP endpoints (`ready` / `authorize`), shipped as a Docker image — plus the lessons it surfaced (three distinguishable not-ready states, `is_eligible` as a pre-submit policy read, service-layer idempotency of authorize-on-behalf) and the MiCA/data-protection design note (`docs/mica-authorization-model.md`): the on-chain record is addresses + enumerated codes only, with no free-text field anywhere in the interface. Testnet e2e now also drives the relayer's ready → authorize → ready flip over plain HTTP.                                                |
| 0.5     | 2026-08-20 | The asset-agnostic Trustline Authorizer of §3 is implemented and live: `deauthorize_trustline` now carries an enumerated `Reason` into its §8 event, and §3 states the pause scope (everything but `unpause`/`set_admin`/`upgrade`, so a paused contract stays recoverable). Recorded the testnet deployment that replaces the Tranche-1 stub as the EURCV test token's SAC admin, the freeze-replay invariant proven against a deleted-and-recreated trustline, and the issuer admin CLI + runbook under Reference Implementation.                                                                                                                                          |
| 0.4     | 2026-08-18 | Documented claimable-balance delivery (Design Rationale (c)) against a working implementation: the open-asset claim fuses `ChangeTrust` with `ClaimClaimableBalance` for a **single** user signature, while a regulated claim is necessarily three transactions because a Soroban authorize cannot share an envelope with classic operations — verified on testnet, with transaction hashes recorded under Proven on testnet. Shipped as a reference-SDK extension; still outside the normative interface.                                                                                                                                                                   |
| 0.3     | 2026-06-10 | `onboard` is now `onboard(sac, holder)` with on-chain authorizer discovery (CAP-68 `get_address_executable` + `SAC.admin()`); added `OnboardStatus` (`Authorized` / `TrustlineOnly`) and the typed-error rejection rule (§3); `AUTHORIZER` in `[TRUSTLINE_ONBOARDER]` demoted to informational; integrators MAY classify assets by simulating `onboard()`; documented the holder-signature-over-admin-subinvocations boundary (Security Considerations); recorded the v0.3 discovery-router run under Proven on testnet and removed the obsolete Protocol-26 JS-SDK decode caveat (the JS SDK now builds, simulates, submits, and decodes the discovery onboard end-to-end). |
| 0.2     | 2026-06-04 | Reframed around third-party onboarding; added the two asset classes (open vs. regulated) and asset-class detection via `auth_required`; added the three onboarding cases (A zero-sig / B sponsored one-tap / C CAP-73 one-tx); added the integrator interface and SEP-7 / deep-link / hosted-redirect handoffs; documented (b)/(c) as situational alternatives; added testnet deployment ids, the proven testnet exchange-withdrawal run, and the P26 JS-SDK decode caveat.                                                                                                                                                                                                  |
| 0.1     | 2026       | Initial draft. Defined roles, denylist/allowlist authorization-delegation interface (built on `admin-sep`), CAP-73 one-signature `onboard()` composition, the freeze = ban/disallow + deauthorize lifecycle and per-call policy evaluation, two reserve backends (CAP-73 funded-holder / CAP-33 sponsored), `[TRUSTLINE_ONBOARDER]` `stellar.toml` discovery block, activation flow, and audit events.                                                                                                                                                                                                                                                                       |
