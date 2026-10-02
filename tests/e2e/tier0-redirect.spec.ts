import { execFileSync } from "node:child_process"
import { expect, test } from "@playwright/test"
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk"

// Tier 0 of the integration ladder (docs/integration-tiers.md), end to end on
// testnet — the integration that is only a link:
//
//   withdraw.html?tier=0 (exchange, no backend)
//        │  payment would bounce: "Withdrawal failed" → Set up your wallet
//        ▼
//   app.html?asset=USDC&address=G…&return_url=…/withdraw.html?…
//        │  connect, one signature, "Return to localhost:4173"
//        ▼
//   withdraw.html?tier=0&asset=USDC&address=G…&amount=… → retried → paid
//
// The wallet is the e2e seam (a Node-side keypair signing exactly what
// Freighter would). No relayer runs: Tier 0 has no backend.

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

test("withdrawal fails → activation page → return link → withdrawal retried and paid", async ({
	page,
}) => {
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

	// 1. The exchange: the address has no USDC trustline, so the payment fails.
	await page.goto("/withdraw.html?tier=0")
	await page.getByRole("combobox").selectOption("USDC")
	await page.getByPlaceholder("G…").fill(holder.publicKey())
	await page.getByRole("button", { name: /Continue to withdrawal/ }).click()
	await expect(page.getByText("Withdrawal failed")).toBeVisible()

	// 2. The Tier 0 link carries the asset, the address and the way back.
	const setUp = page.getByRole("link", { name: /Set up your wallet for USDC/ })
	const link = new URL((await setUp.getAttribute("href"))!, page.url())
	expect(link.pathname).toBe("/app.html")
	expect(link.searchParams.get("asset")).toBe("USDC")
	expect(link.searchParams.get("address")).toBe(holder.publicKey())
	const back = new URL(link.searchParams.get("return_url")!)
	expect(back.pathname).toBe("/withdraw.html")
	expect(back.searchParams.get("tier")).toBe("0")
	expect(back.searchParams.get("address")).toBe(holder.publicKey())
	expect(back.searchParams.get("asset")).toBe("USDC")

	// 3. The activation page names where the user goes back to.
	await setUp.click()
	await expect(page.getByText("Activate USDC", { exact: true })).toBeVisible()
	await expect(
		page.getByRole("link", { name: "localhost:4173", exact: true }),
	).toHaveAttribute("href", back.href)

	// 4. Connect, one signature.
	await page.getByRole("button", { name: /Connect to activate/ }).click()
	await page
		.getByRole("button", { name: /Activate USDC · 1 signature/ })
		.click()
	await expect(page.getByText(/USDC trustline authorized/i)).toBeVisible({
		timeout: 180_000,
	})

	// 5. Back to the exchange, which retries on its own and pays.
	await page.getByRole("link", { name: "Return to localhost:4173" }).click()
	await expect(page).toHaveURL(back.href)
	await expect(page.getByText("Your wallet is already set up")).toBeVisible()
})

test("the activation page refuses a return link it cannot show honestly", async ({
	page,
}) => {
	const address = Keypair.random().publicKey()
	// A credentialed URL reads as exchange.example but leads to evil.example.
	const tricky = encodeURIComponent("https://exchange.example@evil.example/")
	await page.goto(
		`/app.html?asset=USDC&address=${address}&return_url=${tricky}`,
	)
	await expect(page.getByText("Activate USDC", { exact: true })).toBeVisible()
	await expect(page.getByText(/When you’re done, return to/)).toHaveCount(0)
	await expect(page.getByRole("link", { name: /evil\.example/ })).toHaveCount(0)
})
