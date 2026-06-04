# Multi-asset Stellar onboarding — design

**Date:** 2026-06-04 **Branch:** `feature/p26-one-step-trustline` **Status:**
Draft for review

## 1. Summary & goal

Broaden the dApp from a single-asset **EURCV trustline-authorization** page into
a general, capability-driven **Stellar asset onboarding** tool: the user picks
from a curated list of official assets and adds (and, where required,
authorizes) a trustline in as few signatures as possible.

The onboarding mechanism is **asset-agnostic** — the existing `onboard` contract
already takes the SAC and authorizer as runtime parameters. So this work is
overwhelmingly a **frontend/config/naming** change, plus a small **contract
hardening + rename**.

Two facts from research drive the design:

- The biggest Stellar assets are **open, not permissioned**. USDC and EURC have
  `auth_required=false` — they auto-authorize trustlines, so they only need a
  classic `changeTrust` and have nothing for an authorize flow to do.
- **EURCV is the only verified permissioned asset** (`auth_required=true`, with
  a Soroban authorizer exposing `authorize_trustline`). It is the one asset that
  uses the full onboard/authorize flow.
- ⚠️ Five **copycat/scam `EURCV`-coded issuers** exist on mainnet with all auth
  flags false. Assets must therefore be resolved by a **pinned `{code, issuer}`
  pair from a curated registry — never by code alone**.

## 2. Capability model

Every asset in the registry declares a capability that determines its UI and
flow:

| Capability            | Condition                                                                                  | Flow                                                                                                                      | Seeded examples            |
| --------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `open`                | `auth_required = false`                                                                    | `changeTrust` only; usable immediately                                                                                    | USDC, EURC                 |
| `permissionedOneStep` | `auth_required = true` **and** a Soroban authorizer exposes `authorize_trustline(account)` | One-step `onboard` (trust + authorize, 1 sig) for self; classic `changeTrust` + `authorize` for admins authorizing others | EURCV                      |
| `permissionedManual`  | `auth_required = true`, **no** Soroban authorizer                                          | `changeTrust`, then the issuer authorizes off-platform (UI shows "authorization pending")                                 | _(supported, none seeded)_ |

## 3. Asset registry (curated, in-repo)

New module `src/contracts/assets.ts`:

```ts
export type AssetCapability =
	| "open"
	| "permissionedOneStep"
	| "permissionedManual"
export type StellarNet = "PUBLIC" | "TESTNET" | "FUTURENET" | "LOCAL"

export interface OfficialAsset {
	code: string
	issuer: string // PINNED — scam-issuer mitigation; never resolve by code alone
	sac: string // PINNED canonical SAC (verified), not derived at runtime
	authorizer?: string // required iff capability === "permissionedOneStep"
	capability: AssetCapability
	name: string // display name, e.g. "USD Coin"
	network: StellarNet
	homeDomain?: string
	authRevocable?: boolean // issuer can freeze the trustline
	authClawback?: boolean // issuer can claw back balances — surfaced as a UI warning
	verifiedAt?: string // source-of-truth date (review Medium #6)
}

export const OFFICIAL_ASSETS: OfficialAsset[]
export function assetsForNetwork(net: StellarNet): OfficialAsset[]
```

### Verified mainnet (`PUBLIC`) seed

All addresses verified on-chain (Horizon `/accounts` flags + stellar.expert),
strkeys checksum-valid, on 2026-06-04.

| Code  | Issuer                                                     | SAC                                                        | Authorizer                                                 | Capability            | revocable / clawback |
| ----- | ---------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- | --------------------- | -------------------- |
| USDC  | `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` | —                                                          | `open`                | yes / no             |
| EURC  | `GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2` | `CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV` | —                                                          | `open`                | yes / no             |
| EURCV | `GCEYGIVOLAVBF2TG2RUSGTUJCIN75KEX3NGLMY4VPL4GFE5L355AXW3G` | `CANKBYNNAYKEZXLB655F2UPNTAZFK5HILZUXL7ZTFR3NF6LKDSVY7KFH` | `CB2DHZMQHQE3TGUMD6BRM7UCJZNIPKDRVEQOWBIRRS3G2FZOGDTRKSB3` | `permissionedOneStep` | yes / **yes**        |

More large assets can be appended later, each only after passing the same
verification bar (issuer + flags corroborated from ≥2 primary sources). The
leaderboard beyond these three is intentionally **not** populated speculatively.

### Testnet / local

The existing `PUBLIC_TEST_*` env vars are preserved as an **override** that
injects one registry entry for the active network, keeping the
`scripts/issue-test-asset.sh` workflow intact. Running that script twice with
different codes yields two testnet stub assets, so the multi-asset list is
exercisable end-to-end on testnet.

## 4. Contract: rename + harden (`trustline-onboard`)

Used only by the `permissionedOneStep` flow. Open assets never touch it.

- **Rename (de-EURCV-ify):** trait `EurcvAuth` → `Authorizer`, client
  `EurcvAuthClient` → `AuthorizerClient`, param `eurcv_auth` → `authorizer`;
  rename crate `eurcv-auth-stub` → `authorizer-stub`. The standard interface
  stays `authorize_trustline(account)`.
- **Hardening — post-condition assert** (decision: post-condition only, not the
  admin check, so the live EURCV flow can't break): after authorizing, require
  `sac.authorized(holder) == true`, else revert with a new `NotAuthorized`
  error. This closes the SAC-divergence finding (review High #2) and the
  "authorizer did nothing / wrong SAC" cases, and is method-agnostic.
- **"Authorizers vary" reconciliation:** the contract keeps the typed
  `authorize_trustline(account)` call. Any future asset whose admin exposes a
  different method gets a thin **adapter** (set as the SAC admin) normalizing to
  that interface — not dynamic dispatch in the contract.

```rust
pub fn onboard(env: Env, sac: Address, authorizer: Address, holder: Address) -> Result<(), Error> {
    holder.require_auth();
    let sac_client = StellarAssetClient::new(&env, &sac);
    sac_client.try_trust(&holder).map_err(|_| Error::TrustFailed)?.map_err(|_| Error::TrustFailed)?;
    AuthorizerClient::new(&env, &authorizer)
        .try_authorize_trustline(&holder)
        .map_err(|_| Error::AuthorizationFailed)?.map_err(|_| Error::AuthorizationFailed)?;
    if !sac_client.authorized(&holder) { return Err(Error::NotAuthorized); }
    Ok(())
}
```

Errors: `TrustFailed`, `AuthorizationFailed`, `NotAuthorized`.

(API confirmed in soroban-sdk 26.0.0 `token.rs`: `trust(addr)`,
`authorized(id) -> bool`, `set_authorized`, `admin() -> Address`.)

## 5. Frontend

Decompose the ~408-line `AuthorizeTrustline.tsx` into focused units:

- **`src/contracts/assets.ts`** — the registry + types + `assetsForNetwork` +
  `PUBLIC_TEST_*` override injection.
- **`src/contracts/util.ts`** — keep network/env/RPC config and
  `trustlineOnboardContractId`; **remove** the single-asset EURCV singletons
  (`assetCode`/`assetIssuer`/`assetSacContractId`/ `eurcvAuthContractId`) —
  those become registry data.
- **`src/components/AssetSelector.tsx`** (new) — renders `assetsForNetwork()` as
  a selectable list: code, name, a capability badge, and a freeze/clawback
  warning where applicable.
- **`src/hooks/useOnboard.ts`** (new) — the three flows (`changeTrust`,
  `authorize`, one-step `onboard`) parameterized by the **selected asset** (its
  `code/issuer/sac/authorizer/ capability`); returns per-flow
  status/error/handlers. The `authorize` flow targets the selected asset's
  `authorizer` (generic invocation), not a hardcoded EURCV binding.
- **`AuthorizeTrustline.tsx`** → refactored to compose `AssetSelector` +
  `useOnboard` and render buttons **per capability**:
  - `open`: "Add {CODE} trustline" → on success "You can now hold {CODE}".
  - `permissionedOneStep`: "Add & Authorize {CODE} (1 signature)" (self) +
    classic/authorize (admin), plus clawback/freeze warning.
  - `permissionedManual`: "Add trustline" → "Authorization pending from the
    issuer".
- Hero copy + page title generalized from "EURCV Trustline Authorization" to
  asset onboarding.

## 6. Testing

- **Rust (new):** success; `AuthorizationFailed` (stub returns `Err`);
  `NotAuthorized` (post-condition fires when the stub authorizes the wrong/no
  account); `TrustFailed`. The `authorizer-stub` gains an error-returning mode.
  Kills review Medium #3 (no error-path coverage).
- **Frontend:** no test runner exists in the repo; rely on `npm run typecheck` +
  manual verification. Adding a frontend test harness is out of scope (→
  future).

## 7. PR structure

- **This PR** (`feature/p26-one-step-trustline`): everything in this spec —
  registry, selector, `useOnboard`, contract rename + post-condition hardening,
  error-path tests, generalized UI.
- **Stacked PR** (branched off this one): the remaining ~43 review findings
  (deploy-script WASM bug, config footguns, scripts guards, frontend Low/Nits,
  hygiene), merged together with this PR for clean history. _Intrinsic_ changes
  (the rename + hardening + SAC pinning) live here because the feature depends
  on them.

## 8. Non-goals

- On-chain allowlist registry contract (the in-repo registry + post-condition is
  enough).
- Untyped dynamic dispatch in the contract (adapters handle interface variation
  instead).
- A full top-10–15 asset leaderboard (only the 3 verified assets are seeded;
  more added later).
- A frontend test harness.
- The orthogonal review-cleanup findings (→ stacked PR).

## 9. Open items / verify at integration

- **Re-verify EURCV's authorizer** `CB2D…` exposes `authorize_trustline` and
  authorizes against the EURCV SAC — via a testnet end-to-end run and a mainnet
  read. The post-condition assert protects users regardless of the answer.
- **Auth flags can change** (none of the three issuers set `auth_immutable`), so
  re-verify `auth_required` at integration time; consider a dev-time
  verification script.
- **Append more assets** only after the same ≥2-source verification.

```

```
