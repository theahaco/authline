# Authline integrator SDK (`@theaha/authline`)

> **Proposed addition — see the PR.** This is an _integrator_ layer that wraps
> the contracts this repo already ships. It adds **no** new contract and changes
> **no** existing file. The on-chain authorizer stays the live `eurcv_auth`.

`authline-sdk/` is a small, dependency-light TypeScript SDK that lets a **third
party** (an exchange, broker, or wallet) establish a trustline **on behalf of a
user** during a withdrawal — the core of the "Trustline Onboarder" RFP. It is
the reference implementation of the draft standard in
[`sep/SEP-XXXX-trustline-onboarder.md`](../sep/SEP-XXXX-trustline-onboarder.md).

## Why it composes with this repo unchanged

This repo already has the two on-chain pieces the SDK needs:

| Need                             | Already here                                                         |
| -------------------------------- | -------------------------------------------------------------------- |
| One-signature create + authorize | `contracts/trustline-onboard` — `onboard(sac, authorizer, holder)`   |
| The authorize seam               | the live **`eurcv_auth`** SAC admin — `authorize_trustline(account)` |

The SDK only ever calls those existing interfaces. There is **no Authline
authorizer** in this PR; `authorize_trustline` is satisfied by `eurcv_auth`
today, and by any future asset's authorizer that exposes the same one-method
interface.

## What it adds (the integrator surface)

- **Two asset classes, detected at runtime** — `assetAuthRequired()` reads the
  issuer's `auth_required` flag, so the flow degrades correctly for **open**
  assets (USDC/EURC: just create the trustline) vs **regulated** ones (EURCV:
  create + authorize-on-behalf).
- **`buildSponsoredOnboardTx()`** — CAP-33 sponsored, reserve-free `ChangeTrust`
  for a brand-new, zero-XLM user (the third party pays the reserve; the user
  signs once). This is the piece a withdrawal flow needs that the dApp's
  self-funded `changeTrust` does not cover.
- **`buildOnboardTx()`** — wraps this repo's `onboard()` for a funded holder
  (one signature, one tx).
- **`buildAuthorizeTx()`** — permissionless authorize-on-behalf against the
  authorizer (zero user/issuer signature) when the holder already has an
  unauthorized trustline.
- **`onboardingRequest()`** — turns any of the above into a **SEP-7** URI + a
  wallet deep-link + a hosted-redirect URL, so the third party can hand the user
  off to their own wallet.
- **`discoverOnboarder()` / `parseOnboarderToml()`** — read an issuer's
  `stellar.toml` `[TRUSTLINE_ONBOARDER]` block (one issuer config → universal
  interop), with StrKey validation of every advertised address.
- **Pinned registry** (`OFFICIAL_ASSETS`, `resolveOfficialAsset`) — the same
  "never resolve an asset by code alone" defense as `src/contracts/assets.ts`,
  reusable from the SDK.
- **`useActivation()`** — an optional headless React hook (peer `react`).

## Try it

The SDK is intentionally **inert** in this repo (top-level `authline-sdk/`, not
a workspace member) so it touches nothing in the build, lockfile, or CI. To
adopt:

```bash
# build it standalone
cd authline-sdk && npm install && npm run build

# or move it into the workspace once you've decided to adopt it
mv authline-sdk packages/authline-sdk
```

Runnable references (testnet, keypairs generated at runtime — no secrets):

```bash
node examples/exchange-withdrawal/demo.mjs        # regulated (AUTH_REQUIRED) path
node examples/exchange-withdrawal/demo-open.mjs   # open (USDC/EURC-style) path
```

See the PR description for the full rationale, the file-by-file change list, and
the optional follow-up (contributing the asset-agnostic authorizer).
