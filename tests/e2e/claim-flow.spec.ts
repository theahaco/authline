import { execFileSync } from "node:child_process"
import { expect, test } from "@playwright/test"
import {
	Horizon,
	Keypair,
	Networks,
	TransactionBuilder,
} from "@stellar/stellar-sdk"
import {
	buildClaimableBalanceDelivery,
	resolveOfficialAsset,
} from "@theahaco/authline"

const PASSPHRASE = Networks.TESTNET
const horizon = new Horizon.Server("https://horizon-testnet.stellar.org")
// A brand-new wallet: funded, but with no USDC trustline — the exact state a
// claimable-balance recipient is in.
const holder = Keypair.random()
const usdc = resolveOfficialAsset("USDC", "TESTNET")!

// The sender must hold real testnet USDC (friendbot cannot mint it). CI passes
// a funded account via the E2E_USDC_SENDER_SECRET repo secret; locally the
// `me` identity in the stellar CLI keystore serves. Without either, skip
// loudly instead of failing the suite.
function senderSecret(): string | null {
	if (process.env.E2E_USDC_SENDER_SECRET)
		return process.env.E2E_USDC_SENDER_SECRET
	try {
		return execFileSync("stellar", ["keys", "secret", "me"], {
			encoding: "utf8",
		}).trim()
	} catch {
		return null
	}
}
const SENDER_SECRET = senderSecret()
test.skip(
	SENDER_SECRET === null,
	"needs a funded USDC sender: set E2E_USDC_SENDER_SECRET or have a local stellar keystore identity `me`",
)

test.beforeAll(async () => {
	const r = await fetch(
		`https://friendbot.stellar.org/?addr=${holder.publicKey()}`,
	)
	if (!r.ok) throw new Error("friendbot failed")

	// Pay the holder a real USDC claimable balance.
	const sender = Keypair.fromSecret(SENDER_SECRET!)
	const { xdr } = buildClaimableBalanceDelivery({
		networkPassphrase: PASSPHRASE,
		sender: sender.publicKey(),
		senderSequence: (
			await horizon.loadAccount(sender.publicKey())
		).sequenceNumber(),
		recipient: holder.publicKey(),
		amount: "5.0000000",
		config: { assetCode: usdc.code, assetIssuer: usdc.issuer },
		reclaimAfterSeconds: 30 * 24 * 3600,
	})
	const tx = TransactionBuilder.fromXDR(xdr, PASSPHRASE)
	tx.sign(sender)
	await horizon.submitTransaction(tx)
})

test("claim a USDC balance through the dApp — one signature", async ({
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

	// Surface whatever the page logs, so a failure names its cause.
	page.on("console", (m) => console.log(`[browser:${m.type()}]`, m.text()))
	page.on("pageerror", (e) => console.log("[pageerror]", e.message))

	await page.goto("/app.html")
	await page.getByRole("button", { name: "Close" }).click()
	await page.getByRole("button", { name: /USDC/ }).first().click()
	await page.getByRole("button", { name: /Connect wallet/i }).click()

	// The claim screen should take over once the pending balance is found.
	const claimBtn = page.getByRole("button", {
		name: /Claim .*USDC · 1 signature/,
	})
	await expect(claimBtn).toBeVisible({ timeout: 60_000 })
	await claimBtn.click()

	// Resolve to whichever screen appears, then assert on it explicitly — a
	// silent timeout must not pass as success.
	const success = page.getByText(/USDC claimed/i)
	const failure = page.getByText(
		/Couldn’t create trustline|Couldn’t authorize/i,
	)
	await expect(success.or(failure).first()).toBeVisible({ timeout: 180_000 })

	if (
		await failure
			.first()
			.isVisible()
			.catch(() => false)
	) {
		console.log("\n───── CLAIM FAILED — screen text ─────")
		// Dumping the whole screen is the point here: it names the failure that
		// the heading hides.
		// eslint-disable-next-line playwright/no-raw-locators
		console.log(await page.locator("body").innerText())
		console.log("──────────────────────────────────────\n")
	}
	await expect(failure.first()).toBeHidden()
	await expect(success.first()).toBeVisible()

	// And the ledger must agree: the trustline now exists and holds the funds.
	const acct = await horizon.loadAccount(holder.publicKey())
	const line = acct.balances.find(
		(b) => "asset_code" in b && b.asset_code === usdc.code,
	)
	expect(line && "balance" in line ? line.balance : null).toBe("5.0000000")
})
