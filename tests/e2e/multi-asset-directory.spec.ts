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
	await page.getByRole("button", { name: "Close" }).click()
	// Every registry-pinned testnet asset is a live tile.
	await expect(page.getByRole("button", { name: /^EC EURC / })).toBeEnabled()
	await expect(page.getByRole("button", { name: /^BL BLND / })).toBeEnabled()
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

	// "‹ All assets" returns to the directory WITHOUT a page refresh and WITHOUT
	// dropping the wallet: picking another asset goes straight to its flow (no
	// Connect step), and the freshly activated EURCV reads as authorized.
	await page.getByRole("button", { name: /All assets/ }).click()
	await expect(page.getByText(/Supported assets/i)).toBeVisible()
	// Directory badge reflects the fresh activation — no tile click needed.
	await expect(
		page.getByRole("button", { name: /^EV EURCV / }).getByText("Authorized"),
	).toBeVisible({ timeout: 60_000 })
	await page.getByRole("button", { name: /^US USDC / }).click()
	await expect(
		page.getByRole("button", { name: /Activate USDC · 1 signature/ }),
	).toBeVisible()
	await page.getByRole("button", { name: /All assets/ }).click()
	await page.getByRole("button", { name: /^EV EURCV / }).click()
	await expect(page.getByText(/You’re all set/)).toBeVisible()
})

test("connecting from the auto-opened modal stays on the directory and fills the badges", async ({
	page,
}) => {
	const holder = Keypair.random()
	await fund(holder.publicKey())
	await installSigner(page, holder)

	await page.goto("/app.html")
	// Connect-on-open: the picker is already up — pick a wallet (the e2e seam
	// intercepts inside connect()).
	await page.getByRole("button", { name: /Freighter/ }).click()
	// Connected FROM the directory → stay on the directory…
	await expect(page.getByText(/Supported assets/i)).toBeVisible()
	// …and every live tile gets its wallet badge: a fresh G-account holds
	// nothing, so all five read "Not active" — visible without any tile click.
	await expect(page.getByText("Not active")).toHaveCount(5, {
		timeout: 60_000,
	})

	// Switching wallets clears the outgoing wallet's badges (they belong to
	// the address): tiles fall back to the plain "Live" pill.
	await page.getByRole("button", { name: "Switch wallet" }).click()
	await page.getByRole("button", { name: "Close" }).click()
	await expect(page.getByText("Not active")).toHaveCount(0)
})

test("EURC (Circle's official testnet asset, open) activates from the directory", async ({
	page,
}) => {
	const holder = Keypair.random()
	await fund(holder.publicKey())
	await installSigner(page, holder)

	await page.goto("/app.html")
	await page.getByRole("button", { name: "Close" }).click()
	await page.getByRole("button", { name: /^EC EURC / }).click()
	await page.getByRole("button", { name: /Connect wallet/i }).click()
	await page
		.getByRole("button", { name: /Activate EURC · 1 signature/ })
		.click()
	// Open asset: CAP-73 trust() creates the line already authorized.
	await expect(page.getByText(/EURC trustline authorized/i)).toBeVisible({
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
	await page.getByRole("button", { name: "Close" }).click()
	await expect(page.getByText(/Supported assets/i)).toBeVisible()
})
