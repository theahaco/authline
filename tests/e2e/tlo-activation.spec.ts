import { expect, test } from "@playwright/test"
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk"

// Regulated (AUTH_REQUIRED) path: the testnet test token TLO, whose SAC admin is
// the asset-agnostic Trustline Authorizer. Activating it drives the router's
// full one-step discovery — CAP-73 trust() then on-chain authorize_trustline —
// the same shape mainnet EURCV uses. Served by the e2e-tlo build at /tlo/app.html.

const PASSPHRASE = Networks.TESTNET
const holder = Keypair.random()

test.beforeAll(async () => {
	// Fund the holder (CAP-73 trust() has no sponsorship). The TLO SAC + authorizer
	// are already deployed on testnet, so no contract deploy is needed here.
	const r = await fetch(
		`https://friendbot.stellar.org/?addr=${holder.publicKey()}`,
	)
	if (!r.ok) throw new Error("friendbot failed")
})

test("activate an AUTH_REQUIRED (TLO) trustline through the dApp via one-step discovery", async ({
	page,
}) => {
	// Node-side signer: the secret never enters the page.
	await page.exposeFunction("__authlineSign", (xdr: string) => {
		const tx = TransactionBuilder.fromXDR(xdr, PASSPHRASE)
		tx.sign(holder)
		return tx.toXDR()
	})
	await page.addInitScript((address) => {
		;(globalThis as unknown as { __AUTHLINE_E2E__: unknown }).__AUTHLINE_E2E__ =
			{
				address,
				async signTransaction(xdr: string) {
					const signedTxXdr = await (
						globalThis as unknown as {
							__authlineSign: (x: string) => Promise<string>
						}
					).__authlineSign(xdr)
					return { signedTxXdr }
				},
			}
	}, holder.publicKey())

	await page.goto("/tlo/app.html")
	await page.getByRole("button", { name: "Close" }).click()
	// Directory → pick the TLO (live) tile
	await page.getByRole("button", { name: /TLO/ }).first().click()
	// Idle → Connect (the e2e seam connects directly, skipping the modal)
	await page.getByRole("button", { name: /Connect wallet/i }).click()
	// Ready → Activate
	await page.getByRole("button", { name: /Activate TLO · 1 signature/ }).click()
	// Success: a regulated asset reaches "authorized" only if the router
	// discovered the SAC admin's authorize_trustline and ran it in the same tx —
	// trust() alone would leave an AUTH_REQUIRED line unauthorized.
	await expect(page.getByText(/TLO trustline authorized/i)).toBeVisible({
		timeout: 180_000,
	})
})
