import { expect, test, type Page } from "@playwright/test"
import {
	Asset,
	BASE_FEE,
	Keypair,
	Networks,
	Operation,
	TransactionBuilder,
	rpc,
} from "@stellar/stellar-sdk"

// Regulated (AUTH_REQUIRED) path against the pinned testnet EURCV test token,
// served by the e2e-eurcv build at /eurcv/app.html. Beyond the TLO spec, this
// covers the dApp's ledger-state detection: an account whose trustline already
// exists UNauthorized must land on the "Authorize" phase (not the Activate
// CTA), and the authorize-only call must complete from the UI.

const PASSPHRASE = Networks.TESTNET
const RPC_URL = "https://soroban-testnet.stellar.org"
const EURCV_ISSUER = "GCTYD662VYXT34UEPPURGATJSY3YH3YVDM35A7ZAO5F222WTAY2G76L7"

const fund = async (addr: string) => {
	const r = await fetch(`https://friendbot.stellar.org/?addr=${addr}`)
	if (!r.ok) throw new Error("friendbot failed")
}

/** Classic ChangeTrust only — leaves an AUTH_REQUIRED line unauthorized. */
async function createUnauthorizedTrustline(holder: Keypair) {
	const server = new rpc.Server(RPC_URL)
	const acct = await server.getAccount(holder.publicKey())
	const tx = new TransactionBuilder(acct, {
		fee: BASE_FEE,
		networkPassphrase: PASSPHRASE,
	})
		.addOperation(
			Operation.changeTrust({ asset: new Asset("EURCV", EURCV_ISSUER) }),
		)
		.setTimeout(120)
		.build()
	tx.sign(holder)
	const sent = await server.sendTransaction(tx)
	if (sent.status === "ERROR") throw new Error("changeTrust submit failed")
	const deadline = Date.now() + 60_000
	let got = await server.getTransaction(sent.hash)
	while (got.status === "NOT_FOUND" && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 1500))
		got = await server.getTransaction(sent.hash)
	}
	if (got.status !== "SUCCESS") throw new Error("changeTrust not confirmed")
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

test("activate an AUTH_REQUIRED (EURCV) trustline through the dApp via one-step discovery", async ({
	page,
}) => {
	const holder = Keypair.random()
	await fund(holder.publicKey())
	await installSigner(page, holder)

	await page.goto("/eurcv/app.html")
	await page.getByRole("button", { name: /EURCV/ }).first().click()
	await page.getByRole("button", { name: /Connect wallet/i }).click()
	await page
		.getByRole("button", { name: /Activate EURCV · 1 signature/ })
		.click()
	await expect(page.getByText(/EURCV trustline authorized/i)).toBeVisible({
		timeout: 180_000,
	})
})

test("detect an existing UNauthorized trustline and authorize it from the UI", async ({
	page,
}) => {
	const holder = Keypair.random()
	await fund(holder.publicKey())
	await createUnauthorizedTrustline(holder)
	await installSigner(page, holder)

	await page.goto("/eurcv/app.html")
	await page.getByRole("button", { name: /EURCV/ }).first().click()
	await page.getByRole("button", { name: /Connect wallet/i }).click()
	// Ledger-state detection: trustline exists but unauthorized → the dApp must
	// offer the direct authorize-only call, NOT the full Activate flow.
	await expect(page.getByText(/Created — not authorized/)).toBeVisible()
	await page
		.getByRole("button", { name: /Authorize EURCV · 1 signature/ })
		.click()
	await expect(page.getByText(/EURCV trustline authorized/i)).toBeVisible({
		timeout: 180_000,
	})
	// Done returns to the refreshed ledger state — "already authorized".
	await page.getByRole("button", { name: /^Done$/ }).click()
	await expect(page.getByText(/You’re all set/)).toBeVisible()
	await expect(page.getByText(/SAC authorized/)).toBeVisible()
})

test("read-only ?address= preview shows the real trustline state", async ({
	page,
}) => {
	const holder = Keypair.random()
	await fund(holder.publicKey())
	await createUnauthorizedTrustline(holder)

	await page.goto(`/eurcv/app.html?address=${holder.publicKey()}`)
	// The preview card must reflect the ledger — not a hardcoded "None".
	await expect(page.getByText(/Created — not authorized/)).toBeVisible({
		timeout: 60_000,
	})
	await expect(page.getByText(/SAC authorized/)).toBeVisible()
})
