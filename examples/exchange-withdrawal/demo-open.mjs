/**
 * Reference third-party withdrawal — OPEN (non-AUTH_REQUIRED) asset, on testnet.
 *
 * Most Stellar assets (USDC, EURC) are NOT AUTH_REQUIRED: a holder just needs the
 * trustline CREATED — there is no authorize step. This proves the majority case:
 * an exchange establishes the trustline FOR a brand-new, zero-XLM user (sponsoring
 * the reserve; user signs once), and the user immediately receives the asset.
 * Runs fully in JS (no Soroban) — no Protocol-26 codec dependency.
 *
 * Run from the repo root:  node examples/exchange-withdrawal/demo-open.mjs
 * No committed secrets: all keypairs are generated at runtime.
 */
import {
	Keypair,
	Horizon,
	TransactionBuilder,
	Networks,
	Operation,
	Asset,
	BASE_FEE,
} from "@stellar/stellar-sdk"
import {
	getActivationStatus,
	buildSponsoredOnboardTx,
	onboardingRequest,
} from "@theaha/authline"

const NET = {
	horizonUrl: "https://horizon-testnet.stellar.org",
	rpcUrl: "https://soroban-testnet.stellar.org",
	passphrase: Networks.TESTNET,
}
// Classic-submission transport for this demo (the SDK itself no longer uses Horizon).
const horizon = new Horizon.Server(NET.horizonUrl)
const sx = (s, n = 6) => `${s.slice(0, n)}…${s.slice(-n)}`
const expertAcct = (a) => `https://stellar.expert/explorer/testnet/account/${a}`
const expertTx = (h) => `https://stellar.expert/explorer/testnet/tx/${h}`

async function fund(pub) {
	const r = await fetch(`https://friendbot.stellar.org/?addr=${pub}`)
	if (!r.ok) throw new Error("friendbot failed for " + pub)
}
async function submit(xdr, ...signers) {
	const tx = TransactionBuilder.fromXDR(xdr, NET.passphrase)
	signers.forEach((s) => tx.sign(s))
	return horizon.submitTransaction(tx)
}

async function main() {
	const issuer = Keypair.random() // open-asset issuer (no AUTH_REQUIRED flag)
	const exchange = Keypair.random() // the third party
	const user = Keypair.random() // brand-new, unfunded self-custody wallet
	const CODE = "OPENX"
	const config = {
		assetCode: CODE,
		assetIssuer: issuer.publicKey(),
		sac: "",
		authorizer: "",
		backends: [],
	}

	console.log(
		"\n━━━ Authline · OPEN-asset third-party withdrawal demo (testnet) ━━━",
	)
	console.log(
		"Issuer   :",
		issuer.publicKey(),
		"(no AUTH_REQUIRED — like USDC/EURC)",
	)
	console.log("Exchange :", exchange.publicKey())
	console.log("User     :", user.publicKey(), "(brand-new, 0 XLM)\n")

	console.log("• Funding issuer + exchange via friendbot…")
	await Promise.all([fund(issuer.publicKey()), fund(exchange.publicKey())])

	// The open-vs-regulated distinction is now discovered on-chain by the router; the client no longer pre-classifies.
	console.log(
		"• Open asset (issuer has no AUTH_REQUIRED) — NO authorize step, NO Authorizer contract.\n",
	)

	let st = await getActivationStatus({
		rpcUrl: NET.rpcUrl,
		account: user.publicKey(),
		assetCode: CODE,
		assetIssuer: issuer.publicKey(),
	})
	console.log(
		"   user status:",
		st,
		"→ no trustline; the exchange establishes one.\n",
	)

	console.log(
		"• Establish the trustline — sponsored (exchange pays the reserve; user signs once).",
	)
	const xdr = await buildSponsoredOnboardTx({
		rpcUrl: NET.rpcUrl,
		networkPassphrase: NET.passphrase,
		sponsor: exchange.publicKey(),
		user: user.publicKey(),
		config,
		createUserAccount: true,
	})
	const req = onboardingRequest({
		txXdr: xdr,
		networkPassphrase: NET.passphrase,
		userAddress: user.publicKey(),
		msg: "Receive OPENX",
		// hostedBase must be an origin the integrator controls (no default).
		hostedBase: "https://onboard.example/app.html",
	})
	console.log("   handoff the exchange would give the user:")
	console.log("     SEP-7  :", req.sep7Uri.slice(0, 70) + "…")
	console.log("     hosted :", req.hostedUrl)
	const r1 = await submit(xdr, exchange, user) // demo co-signs as the user
	console.log(
		"   ✅ trustline created (no authorize needed), reserve paid by the exchange:",
		expertTx(r1.hash),
		"\n",
	)

	console.log(
		"• The withdrawal: issuer pays 100 OPENX to the user (immediately receivable).",
	)
	const src = await horizon.loadAccount(issuer.publicKey())
	const payXdr = new TransactionBuilder(src, {
		fee: BASE_FEE,
		networkPassphrase: NET.passphrase,
	})
		.addOperation(
			Operation.payment({
				destination: user.publicKey(),
				asset: new Asset(CODE, issuer.publicKey()),
				amount: "100",
			}),
		)
		.setTimeout(120)
		.build()
		.toXDR()
	const r2 = await submit(payXdr, issuer)
	console.log("   ✅ paid:", expertTx(r2.hash), "\n")

	st = await getActivationStatus({
		rpcUrl: NET.rpcUrl,
		account: user.publicKey(),
		assetCode: CODE,
		assetIssuer: issuer.publicKey(),
	})
	const acc = await horizon.loadAccount(user.publicKey())
	const bal = acc.balances.find((b) => b.asset_code === CODE)?.balance
	console.log("━━━ Result ━━━")
	console.log("User status:", st, "| OPENX balance:", bal)
	console.log("User on Stellar Expert:", expertAcct(user.publicKey()))
	console.log(
		st.hasTrustline
			? "\n✓ For an OPEN asset, a third party established the trustline for a brand-new zero-XLM user\n  (sponsored, one signature) — NO authorize step — and the user received the asset.\n"
			: "\n✗ unexpected final state\n",
	)
}
main().catch((e) => {
	console.error("demo failed:", e?.message || e)
	process.exit(1)
})
