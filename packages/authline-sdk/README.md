# @theaha/authline

Integrator SDK for **one-signature trustline onboarding** via an on-chain
discovery router. The router discovers on-chain (via the SAC admin) whether the
trustline also needs authorization, so the same single transaction shape works
for every asset — open (USDC/EURC) or `AUTH_REQUIRED`. The `onboard` call
returns an `OnboardStatus` (`Authorized` | `TrustlineOnly`); decode it with
`decodeOnboardStatus` to know whether the line was also authorized, rather than
treating tx success alone as full activation.

```bash
npm install @theaha/authline
```

## Discover an issuer's onboarder

```ts
import { discoverOnboarder } from "@theaha/authline"

// Reads https://theaha.co/.well-known/stellar.toml -> [TRUSTLINE_ONBOARDER].
// Always pass `network` for any flow that builds a signed tx: the result is
// then reconciled against the pinned registry, so a spoofed stellar.toml whose
// ids differ from the curated values is rejected (throws) instead of trusted.
const config = await discoverOnboarder("theaha.co", { network: passphrase })
// { assetCode: "EURCV", assetIssuer: "G...", sac: "C...", router: "C...", authorizer: "C...", backends: [...] }
```

> Without `network`, `discoverOnboarder` returns the issuer's **unverified**
> self-advertisement. StrKey validation proves the ids are well-formed, not that
> they are the right ids — reconcile against the registry before signing.

## Build the one-signature transaction

```ts
import { buildOnboardTx, ROUTERS } from "@theaha/authline"
import { Networks } from "@stellar/stellar-sdk"

// The router id must be pinned per network; mainnet awaits the mainnet router deployment.
const xdr = await buildOnboardTx({
	rpcUrl: "https://soroban-testnet.stellar.org",
	networkPassphrase: Networks.TESTNET,
	holder: userPublicKey,
	config: { ...config, router: ROUTERS.TESTNET },
})
// Hand `xdr` to the wallet to sign (one signature), then submit via Stellar RPC.
```

## React

```tsx
import { ActivateButton } from "@theaha/authline/react"
;<ActivateButton
	holder={address}
	config={config}
	rpcUrl={rpcUrl}
	networkPassphrase={passphrase}
	signTransaction={kit.signTransaction} // e.g. Stellar Wallets Kit
/>
```

## Backends

- `cap73-one-signature` — funded holder signs once; on-chain `onboard()` wrapper
  composes CAP-73 `trust()` + `authorize_trustline`. **(this SDK)**
- `cap33-sponsored` — brand-new / under-funded account; classic
  sponsored-reserve transaction. Build it with `buildSponsoredOnboardTx` from
  this package (the sponsor pays the reserve). **(this SDK)**

Use `selectBackend()` to choose per holder.
