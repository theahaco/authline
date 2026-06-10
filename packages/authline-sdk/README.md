# @theaha/authline

Integrator SDK for **one-signature activation** of `AUTH_REQUIRED` Stellar
classic assets. Wallets and exchanges embed the
[Trustline Onboarder](../../README.md) flow with a few calls.

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
import { buildOnboardTx } from "@theaha/authline"

const xdr = await buildOnboardTx({
	rpcUrl: "https://mainnet.sorobanrpc.com",
	networkPassphrase: "Public Global Stellar Network ; September 2015",
	holder: userPublicKey,
	config,
})
// Hand `xdr` to the wallet to sign (one signature), then submit via Soroban RPC.
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
  sponsored-reserve transaction (sponsor pays the reserve). Helper provided
  separately; see [ARCHITECTURE.md](../../ARCHITECTURE.md) §3.

Use `selectBackend()` to choose per holder.

## Status

```ts
import { getActivationStatus } from "@theaha/authline"
const { hasTrustline, isAuthorized } = await getActivationStatus({
	horizonUrl,
	account,
	assetCode: config.assetCode,
	assetIssuer: config.assetIssuer,
})
```
