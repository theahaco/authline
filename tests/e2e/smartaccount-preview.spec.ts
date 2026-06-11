import { expect, test } from "@playwright/test"

// Smart-account (C-address) holders in the dApp UI — the Nido wallet case.
// The full passkey ceremony runs in Nido's hosted wallet popup (covered
// upstream); here we prove the dApp's own smart-account handling: the
// ?address= read-only preview accepts a C-address, reads the SAC view from
// the real chain, and renders the truthful smart-account state instead of
// crashing on a trustline lookup (the pre-fix behavior).
const SMART_HOLDER = "CDVVAQAQ4FKQ4DCPPIIOIAOPRJJBO6HVOXRQX3PXONJVJNNK432O6HW3"

test("?address= preview of a smart account on a regulated asset: not authorized yet", async ({
	page,
}) => {
	// EURCV build — AUTH_REQUIRED: a contract holder defaults to unauthorized.
	await page.goto(`/eurcv/app.html?address=${SMART_HOLDER}`)
	await expect(page.getByText("● Smart account")).toBeVisible({
		timeout: 60_000,
	})
	await expect(page.getByText("Not needed")).toBeVisible() // trustline row
	// The SAC view must actually read UNauthorized — not just render the row.
	await expect(page.getByText("No", { exact: true })).toBeVisible()
})

test("?address= preview of a smart account on an open asset: already authorized", async ({
	page,
}) => {
	// USDC build — open asset: the SAC default for contract holders is
	// authorized, so the preview lands on the "already" screen.
	await page.goto(`/app.html?address=${SMART_HOLDER}`)
	await expect(page.getByText(/You’re all set/)).toBeVisible({
		timeout: 60_000,
	})
	await expect(page.getByText("● Smart account")).toBeVisible()
})

test("the wallet modal offers Nido on testnet builds", async ({ page }) => {
	await page.goto("/app.html?asset=EURCV")
	await page.getByRole("button", { name: /Connect wallet/i }).click()
	await expect(page.getByRole("button", { name: /Nido/ })).toBeVisible()
})

test("the connected header pill switches wallets (disconnect + picker)", async ({
	page,
}) => {
	const { Keypair } = await import("@stellar/stellar-sdk")
	const holder = Keypair.random()
	// Seam-connect (no funding needed: a missing account previews as not
	// activated and still counts as a connected wallet).
	await page.addInitScript((address) => {
		;(globalThis as unknown as { __AUTHLINE_E2E__: unknown }).__AUTHLINE_E2E__ =
			{
				address,
				async signTransaction(xdr: string) {
					return { signedTxXdr: xdr }
				},
			}
	}, holder.publicKey())
	await page.goto("/app.html?asset=EURCV")
	await page.getByRole("button", { name: /Connect wallet/i }).click()
	// Connected: the header pill shows the address and is a switch button.
	const pill = page.getByRole("button", { name: "Switch wallet" })
	await expect(pill).toBeVisible()
	await pill.click()
	// Disconnected + wallet picker reopened (Nido listed) — see nido#89 for
	// why this affordance must live in the dApp.
	await expect(
		page.getByText("Connect a wallet", { exact: true }),
	).toBeVisible()
	await expect(page.getByRole("button", { name: /Nido/ })).toBeVisible()
})
