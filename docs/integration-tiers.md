# Integrating Authline — the tier ladder

An exchange, broker or wallet adopts the
[Trustline Onboarder standard](../sep/sep_trustlineonboarder.md) at whatever
depth it can take on today. **Tier 0 is a link**: the platform's "withdrawal
failed" screen sends the user to the activation page, which sends them back.
Each tier above it moves one more step of the work from the user onto the
platform. Every tier is a real integration of the standard. A platform starts
where it can and climbs later.

| Tier                      | What the platform does                                                                                                                                                                                                       | What it needs                                                               | User signatures                                                    | On the ledger                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| **0 — Redirect**          | Links the user from its failure screen to the [activation page](#tier-0--the-activation-link), with a way back.                                                                                                              | A URL. No backend, no SDK, no key.                                          | 1, on the activation page                                          | The user's onboarding transaction (router `onboard`, or `authorize_trustline` for an existing trustline) |
| **1 — Relayer call**      | Its backend asks the [relayer](relayer-runbook.md) `ready?` before paying, `authorize` when only authorization is missing, and `sep7/request` for a signed SEP-7 handoff otherwise.                                          | HTTP calls to a hosted or self-hosted relayer (Docker image).               | **0** when the trustline exists (Case A); 1 otherwise (Case B / C) | `authorize_trustline` paid by the platform's relayer account, which attributes the onboarding to it      |
| **2 — Claimable balance** | When the user can't receive yet, pays anyway as a [claimable balance](sep7-handoff.md#4-claimable-balance-delivery-post-v1claimablesend). The user collects it on the activation page, and the claim can open the trustline. | The relayer's `POST /v1/claimable/send`, or `buildClaimableBalanceDelivery` | 0 to be paid; 1 to claim (2 for an `AUTH_REQUIRED` asset)          | The platform's claimable-balance creation, then the user's claim                                         |
| **3 — Full SDK**          | Embeds [`@theahaco/authline`](authline-sdk.md): reads the issuer's `stellar.toml`, reads status, builds and sponsors the transactions itself, and signs SEP-7 requests as its own `origin_domain`.                           | The SDK, a signing key, and a funded account for fees and reserves          | 0 or 1 (Cases A / B / C), in the platform's own screen             | Every transaction sourced or sponsored by the platform's accounts                                        |

Tiers stack. A Tier 1 exchange keeps its Tier 0 link as the fallback for
anything its backend doesn't cover. A Tier 3 wallet still accepts Tier 0 links
from exchanges.

## Tier 0 — the activation link

```
https://authline.io/app.html?asset=EURCV&address=G…&return_url=https%3A%2F%2Fexchange.example%2Fwithdrawals%2F42
```

| Parameter    | Required    | Meaning                                                                                                                                                                                                                      |
| ------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `asset`      | yes         | Asset code, as pinned for the page's network (mainnet: `EURCV`, `USDC`, `EURC`, `BLND`). The page opens straight on that asset.                                                                                              |
| `address`    | recommended | The withdrawal's destination, a `G…` account or a `C…` smart account. The page shows a read-only preview of its status and asks the user to connect **that** account.                                                        |
| `return_url` | recommended | Where the user goes afterwards. It must be an absolute `https:` URL (plain `http:` only on localhost), carry no `user:pass@` part, and be at most 2048 characters. Anything else is ignored, and the page shows no way back. |

What the user sees:

1. "Activate EURCV", and under it: _When you're done, return to
   `exchange.example`._ The page shows the link's **host**, never a platform
   name. The link is supplied by the caller, so the page's only claim is where
   it leads.
2. The account's current status, then **Connect to activate**. Any Stellar
   Wallets Kit wallet works: Freighter, xBull, Albedo, Lobstr, Hana.
3. One signature.
4. **Return to exchange.example**, on the success screen and on the "you're
   already set up" screen. It is a link the user clicks. The page never
   redirects on its own, and it adds nothing to `return_url`.

When the user comes back, **re-check the ledger and retry the payment**. Never
treat the return itself, or anything in the URL, as proof the account is ready.
The link carries only the asset, the address and the way back: no key, no
transaction, no user data.

### When to show it

The payment was refused, or would be:

- **The payment failed** with operation result `op_no_trust` (no trustline) or
  `op_not_authorized` (a trustline the issuer hasn't authorized). Both mean "the
  user must act first". `op_no_destination` means the account doesn't exist at
  all. Activation can't fix that: the user has to fund the account, or you
  deliver by claimable balance (Tier 2).
- **Or check before paying**, with one plain HTTP read:

```js
const HORIZON = "https://horizon.stellar.org"

async function canReceive(account, code, issuer) {
	const r = await fetch(`${HORIZON}/accounts/${account}`)
	if (r.status === 404) return false // no account — fund it first
	const { balances } = await r.json()
	return balances.some(
		(b) =>
			b.asset_code === code && b.asset_issuer === issuer && b.is_authorized,
	)
}
```

### Building the link

Any language can build it: three query parameters, URL-encoded. The SDK has a
helper that validates each one the same way the page does:

```ts
import { activationLink } from "@theahaco/authline"

const url = activationLink({
	base: "https://authline.io/app.html",
	asset: "EURCV",
	address: withdrawal.destination,
	returnUrl: `https://exchange.example/withdrawals/${withdrawal.id}`,
})
```

### Reference implementation

- `withdraw.html?tier=0` is the reference exchange screen at Tier 0. It has no
  backend: a destination that can't receive the asset gets **Withdrawal failed**
  and **Set up your wallet**. The activation link sends the user back to the
  prefilled form, which retries on its own. Without `?tier=0` the same screen is
  the relayer-backed Tier 1 and Tier 2 reference
  ([sep7-handoff.md](sep7-handoff.md)).
- `tests/e2e/tier0-redirect.spec.ts` drives the whole round trip in a browser
  against testnet: failed withdrawal, activation link, one signature, return,
  paid. It also asserts that a credentialed return link
  (`https://exchange.example@evil.example/`) is refused.

### Mainnet availability

On mainnet the activation page authorizes an **existing, unauthorized**
trustline (Case A: `authorize_trustline` on the asset's Authorizer). That needs
no router, so it works today. **Creating** a trustline from the page goes
through the onboard router, which is not yet deployed on mainnet
([#25](https://github.com/theahaco/authline/issues/25)). Until it is, the page
tells a user without a trustline that creating one isn't available there yet.

## Wallets

A wallet reaches the same tiers from the other side.

- **Tier 0.** When an asset the user wants to hold is regulated and their
  trustline is missing or unauthorized, open the activation link with the user's
  address. A web wallet passes its own page as `return_url`. A browser
  extension, which has no page to return to, can leave it out. The activation
  page connects through
  [Stellar Wallets Kit](https://github.com/Creit-Tech/Stellar-Wallets-Kit), so a
  Wallets Kit wallet needs no code of its own for the user to finish there.
- **Tier 1.** Handle `web+stellar:` SEP-7 links. An exchange's relayer-built
  request then opens directly in the wallet: the wallet verifies
  `origin_domain`, shows what the transaction does, and returns the signature
  through `callback`. Wallets that don't register the scheme are served by the
  activation page's receiving end (`app.html?sep7=…`).
- **Tier 3.** Run the flow in-app with the SDK, signing through the kit:

```ts
import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit"
import { buildOnboardTx, getActivationStatus } from "@theahaco/authline"

const st = await getActivationStatus({
	rpcUrl,
	networkPassphrase,
	account,
	...asset,
})
if (!st.isAuthorized) {
	const xdr = await buildOnboardTx({
		rpcUrl,
		networkPassphrase,
		holder: account,
		config: asset,
	})
	const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, {
		networkPassphrase,
		address: account,
	})
	// submit signedTxXdr through Stellar RPC and poll getTransaction
}
```

`@theahaco/authline/react` exports the same flow as a headless `useActivation()`
hook and an `<ActivateButton>`. Pass the kit's `signTransaction` to either.

## What counts as an integration

For adoption reporting ([adoption-evidence.md](adoption-evidence.md)), a
platform counts at a tier when both hold:

1. **It is live and documented.** The platform's screen, or its code change, is
   in production, and the integration record names the platform, the tier and
   the date.
2. **Real onboardings went through it on mainnet**, and each one is a
   transaction on Stellar Expert. `scripts/adoption-evidence.mjs` lists every
   authorization of an asset that went through its on-chain Authorizer or the
   router, as opposed to the issuer setting flags by hand. It can narrow the
   list to the addresses a platform sent over, or to the account a platform's
   relayer pays fees from.
