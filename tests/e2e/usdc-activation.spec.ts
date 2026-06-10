import { execFileSync } from "node:child_process"
import { expect, test } from "@playwright/test"
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk"

const PASSPHRASE = Networks.TESTNET
const holder = Keypair.random()

test.beforeAll(async () => {
	const r = await fetch(
		`https://friendbot.stellar.org/?addr=${holder.publicKey()}`,
	)
	if (!r.ok) throw new Error("friendbot failed")
	execFileSync("node", ["scripts/deploy-testnet-usdc-sac.mjs"], {
		stdio: "inherit",
		env: { ...process.env, SOURCE_SECRET: holder.secret() },
	})
})

test("activate a USDC trustline through the dApp", async ({ page }) => {
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

	await page.goto("/app.html")
	// Directory → pick the USDC (live) tile
	await page.getByRole("button", { name: /USDC/ }).first().click()
	// Idle → Connect (the e2e seam connects directly, skipping the modal)
	await page.getByRole("button", { name: /Connect wallet/i }).click()
	// Ready → Activate
	await page
		.getByRole("button", { name: /Activate USDC · 1 signature/ })
		.click()
	// Success
	await expect(page.getByText(/USDC trustline authorized/i)).toBeVisible({
		timeout: 180_000,
	})
})
