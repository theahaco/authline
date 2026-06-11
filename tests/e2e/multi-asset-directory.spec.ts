import { expect, test, type Page } from "@playwright/test"
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk"

// Multi-asset directory on the DEFAULT build (/app.html — env-configured asset
// is USDC). Every registry-pinned testnet asset must be a live, selectable
// tile: picking EURCV from the USDC build runs the regulated one-step flow
// end-to-end. This is exactly the hosted-build configuration where EURCV used
// to render as a grey "Soon" tile.

const PASSPHRASE = Networks.TESTNET

const fund = async (addr: string) => {
	const r = await fetch(`https://friendbot.stellar.org/?addr=${addr}`)
	if (!r.ok) throw new Error("friendbot failed")
}

/** Wire the e2e signer seam (Node-side keys — the secret never enters the page). */
async function installSigner(page: Page, holder: Keypair) {
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
}

test("EURCV is live in the USDC build's directory and activates end-to-end", async ({
	page,
}) => {
	const holder = Keypair.random()
	await fund(holder.publicKey())
	await installSigner(page, holder)

	await page.goto("/app.html")
	// Exactly one EURCV tile (live from the registry; the roadmap copy deduped)
	// and it must be enabled — the old single-asset directory grayed it out.
	// Anchored on the "EV" glyph + code: TLO's tile name contains
	// "(EURCV-style)" and must not match.
	const eurcvTile = page.getByRole("button", { name: /^EV EURCV / })
	await expect(eurcvTile).toHaveCount(1)
	await expect(eurcvTile).toBeEnabled()
	await eurcvTile.click()
	await page.getByRole("button", { name: /Connect wallet/i }).click()
	await page
		.getByRole("button", { name: /Activate EURCV · 1 signature/ })
		.click()
	await expect(page.getByText(/EURCV trustline authorized/i)).toBeVisible({
		timeout: 180_000,
	})
})

test("?asset=EURCV deep link preselects EURCV past the directory", async ({
	page,
}) => {
	await page.goto("/app.html?asset=EURCV")
	// Lands on the EURCV idle screen (no directory step), regulated copy.
	await expect(
		page.getByRole("button", { name: /Connect wallet/i }),
	).toBeVisible()
	await expect(
		page.getByText("EUR CoinVertible (testnet test token)", { exact: true }),
	).toBeVisible()
	await expect(page.getByText(/Auth req\./i)).toBeVisible()
})

test("an unknown ?asset= code falls back to the directory", async ({
	page,
}) => {
	await page.goto("/app.html?asset=NOPE")
	await expect(page.getByText(/Supported assets/i)).toBeVisible()
})
