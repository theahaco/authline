# Authline — integrator SDK + frontend rebrand

This PR brings the **Authline** experience to `stellar-assets`: the
`@theaha/authline` integrator SDK **and** the Authline landing page + activation
dApp, wired together. The **backend is untouched** — same contracts
(`contracts/trustline-onboard`, `authorizer-stub`), the same onboarding logic
(`src/hooks/useOnboard.ts`, `src/contracts/assets.ts`), and authorization still
flows through the live `eurcv_auth`. Only the **frontend/design layer** changes.

## Two parts

### 1. `packages/authline-sdk/` — the integrator SDK (`@theaha/authline`)

A small TypeScript SDK that lets a **third party** (exchange / broker / wallet)
establish a trustline **on behalf of a user** during a withdrawal — the core of
the "Trustline Onboarder" RFP. It is a real workspace package (the frontend
depends on it; `npm run build` builds it first).

| Need                             | Already in this repo                                                 |
| -------------------------------- | -------------------------------------------------------------------- |
| One-signature create + authorize | `contracts/trustline-onboard` → `onboard(sac, authorizer, holder)`   |
| The authorize seam               | the live **`eurcv_auth`** SAC admin → `authorize_trustline(account)` |

Surface: `assetAuthRequired()` (open vs regulated detection),
`buildSponsoredOnboardTx()` (CAP-33 sponsored, reserve-free `ChangeTrust` for a
zero-XLM user), `buildOnboardTx()` (wraps this repo's `onboard()`),
`buildAuthorizeTx()` (permissionless authorize-on-behalf), `onboardingRequest()`
(SEP-7 + deep-link + hosted handoffs),
`discoverOnboarder()`/`parseOnboarderToml()` (StrKey-validated `stellar.toml`
discovery), a pinned `OFFICIAL_ASSETS` registry, and an optional headless
`useActivation()` React hook. There is **no Authline authorizer** —
`authorize_trustline` is satisfied by `eurcv_auth`.

### 2. The Authline frontend (landing + dApp)

- `index.html` — the Authline landing page (warm rebrand, "Hold any asset. In
  one tap.").
- `app.html` + `src/{main,authline,config}.tsx` — the activation dApp, wired to
  the SDK and Stellar Wallets Kit.
- `vite.config.ts` — multi-page (`index.html` + `app.html`), keeping the
  existing `nodePolyfills` + `wasm` plugins.

The previous React app (`src/App.tsx`, `src/components/*`, `src/hooks/*`) is
**kept in place** (the onboarding backend logic is preserved); the new entry
simply mounts the Authline dApp instead.

## Build / run

```bash
npm ci && npm run build      # builds the SDK, then the multi-page dapp
npm run dev                  # local dev
node examples/exchange-withdrawal/demo.mjs        # regulated path (testnet)
node examples/exchange-withdrawal/demo-open.mjs   # open path (testnet)
```

See the PR description for the file-by-file change list, the backend-untouched
guarantee, and the optional follow-up (the asset-agnostic authorizer contract).
