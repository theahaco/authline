/**
 * Reference third-party withdrawal — CLAIMABLE-BALANCE delivery, on testnet.
 *
 * The case the other two demos can't cover: the recipient isn't ready and isn't
 * around. A payment to them would BOUNCE (no trustline), so the exchange sends a
 * claimable balance instead and the withdrawal completes immediately, with zero
 * user involvement. Later — minutes or weeks — the user opens the activation
 * page and signs ONCE: that single signature opens the trustline AND collects
 * the balance in one transaction.
 *
 * Run from the repo root:  node examples/exchange-withdrawal/demo-claimable.mjs
 * No committed secrets: all keypairs are generated at runtime.
 */
import {
	Account,
	Asset,
	BASE_FEE,
	Horizon,
	Keypair,
	Networks,
	Operation,
	TransactionBuilder,
} from "@stellar/stellar-sdk"
import {
	buildClaimTx,
	buildClaimableBalanceDelivery,
	findClaimableBalances,
	getActivationStatus,
	getClaimableBalance,
	planClaim,
} from "@theahaco/authline"

const NET = {
	horizonUrl: "https://horizon-testnet.stellar.org",
	rpcUrl: "https://soroban-testnet.stellar.org",
	passphrase: Networks.TESTNET,
}
const horizon = new Horizon.Server(NET.horizonUrl)
const expertTx = (h) => `https://stellar.expert/explorer/testnet/tx/${h}`
const expertAcct = (a) => `https://stellar.expert/explorer/testnet/account/${a}`

async function fund(pub) {
	const r = await fetch(`https://friendbot.stellar.org/?addr=${pub}`)
	if (!r.ok) throw new Error(`friendbot failed for ${pub}`)
}
const seqOf = async (pub) => (await horizon.loadAccount(pub)).sequenceNumber()
async function submit(xdr, ...signers) {
	const tx = TransactionBuilder.fromXDR(xdr, NET.passphrase)
	signers.forEach((s) => tx.sign(s))
	return horizon.submitTransaction(tx)
}
async function txFrom(kp) {
	return new TransactionBuilder(
		new Account(kp.publicKey(), await seqOf(kp.publicKey())),
		{ fee: BASE_FEE, networkPassphrase: NET.passphrase },
	)
}

async function main() {
	const issuer = Keypair.random()
	const exchange = Keypair.random()
	const user = Keypair.random()
	const CODE = "CBDEMO"
	const config = { assetCode: CODE, assetIssuer: issuer.publicKey() }
	const asset = new Asset(CODE, issuer.publicKey())

	console.log(
		"\n━━━ Authline · claimable-balance withdrawal demo (testnet) ━━━",
	)
	console.log("Exchange :", exchange.publicKey())
	console.log("User     :", user.publicKey(), "(no trustline)\n")

	console.log("• Setting up the asset and funding the exchange…")
	await Promise.all([fund(issuer.publicKey()), fund(exchange.publicKey())])
	await submit(
		(await txFrom(exchange))
			.addOperation(Operation.changeTrust({ asset }))
			.setTimeout(120)
			.build()
			.toXDR(),
		exchange,
	)
	await submit(
		(await txFrom(issuer))
			.addOperation(
				Operation.payment({
					destination: exchange.publicKey(),
					asset,
					amount: "1000",
				}),
			)
			// The exchange creates the user's account at exactly the 1 XLM
			// minimum — so the user has NO spendable XLM of their own.
			.addOperation(
				Operation.createAccount({
					destination: user.publicKey(),
					startingBalance: "1",
				}),
			)
			.setTimeout(120)
			.build()
			.toXDR(),
		issuer,
	)

	console.log(
		`• The user requests a withdrawal of 100 ${CODE} — but they have no trustline.`,
	)
	const before = await getActivationStatus({
		rpcUrl: NET.rpcUrl,
		account: user.publicKey(),
		...config,
	})
	console.log("   status:", before, "\n   → a payment would bounce.\n")

	console.log(
		"• The exchange delivers a CLAIMABLE BALANCE instead (no user action, withdrawal done).",
	)
	const delivery = buildClaimableBalanceDelivery({
		networkPassphrase: NET.passphrase,
		sender: exchange.publicKey(),
		senderSequence: await seqOf(exchange.publicKey()),
		recipient: user.publicKey(),
		amount: "100.0000000",
		config,
		// Sweep it back if the user never turns up.
		reclaimAfterSeconds: 30 * 24 * 3600,
	})
	const sent = await submit(delivery.xdr, exchange)
	console.log("   ✅ delivered:", expertTx(sent.hash))
	console.log("   balance id :", delivery.balanceId, "\n")

	console.log("• …later, the user opens the activation page.")
	const found = await findClaimableBalances({
		horizonUrl: NET.horizonUrl,
		claimant: user.publicKey(),
		config,
	})
	console.log(
		`   the page finds ${found.length} balance waiting: ${found[0]?.amount} ${CODE}`,
	)
	const st = await getActivationStatus({
		rpcUrl: NET.rpcUrl,
		account: user.publicKey(),
		...config,
	})
	const plan = planClaim({
		hasTrustline: st.hasTrustline,
		isAuthorized: st.isAuthorized,
		authRequired: false,
	})
	console.log(
		`   plan: ${plan.steps.map((s) => s.kind).join(" → ")} · ${plan.userSignatures} user signature\n`,
	)

	console.log(
		"• One signature: opens the trustline AND claims the balance, in one transaction.",
	)
	const claimXdr = buildClaimTx({
		networkPassphrase: NET.passphrase,
		claimant: user.publicKey(),
		// The exchange sources and sponsors, so the user spends nothing at all.
		feeSource: exchange.publicKey(),
		sourceSequence: await seqOf(exchange.publicKey()),
		balanceId: delivery.balanceId,
		config,
		createTrustline: true,
		sponsor: exchange.publicKey(),
	})
	const claimed = await submit(claimXdr, exchange, user)
	console.log("   ✅ claimed:", expertTx(claimed.hash), "\n")

	const after = await getActivationStatus({
		rpcUrl: NET.rpcUrl,
		account: user.publicKey(),
		...config,
	})
	const acct = await horizon.loadAccount(user.publicKey())
	const line = acct.balances.find((b) => b.asset_code === CODE)
	const xlm = acct.balances.find((b) => b.asset_type === "native")
	const gone = await getClaimableBalance({
		rpcUrl: NET.rpcUrl,
		balanceId: delivery.balanceId,
	})

	console.log("━━━ Result ━━━")
	console.log("User trustline status:", after)
	console.log(`User ${CODE} balance   :`, line?.balance)
	console.log("User XLM balance     :", xlm?.balance, "(untouched — 1 XLM)")
	console.log(
		"Claimable balance    :",
		gone === null ? "consumed" : "STILL OPEN",
	)
	console.log("User on Stellar Expert:", expertAcct(user.publicKey()))
	console.log(
		after.hasTrustline && line?.balance === "100.0000000" && gone === null
			? "\n✓ A withdrawal completed to a user who wasn't ready, and their ONE signature\n  opened the trustline and collected the funds. They spent no XLM: the exchange\n  paid the fee and the reserve.\n"
			: "\n✗ unexpected final state\n",
	)
}
main().catch((e) => {
	console.error("demo failed:", e?.response?.data ?? e?.message ?? e)
	process.exit(1)
})
