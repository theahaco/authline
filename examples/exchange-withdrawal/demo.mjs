/**
 * Reference third-party (exchange) withdrawal flow — runnable on Stellar testnet.
 *
 * Proves the RFP's core: an exchange establishes an *authorized* trustline FOR a
 * brand-new, zero-XLM user — paying the reserve (CAP-33 sponsorship) and
 * authorizing on the issuer's behalf (permissionless authorize_trustline, no
 * issuer signature) — with the user signing exactly once.
 *
 * Run from the repo root:  node examples/exchange-withdrawal/demo.mjs
 *
 * No secrets: it generates fresh exchange + user keypairs at runtime and funds
 * the exchange via friendbot. The Authorizer/SAC ids below are public testnet
 * contract ids deployed by this project.
 */
import {
	Keypair,
	Horizon,
	rpc,
	TransactionBuilder,
	Networks,
} from "@stellar/stellar-sdk"
import {
	buildAuthorizeTx,
	buildSponsoredOnboardTx,
	getActivationStatus,
	onboardingRequest,
} from "@theahaco/authline"

const NET = {
	rpcUrl: "https://soroban-testnet.stellar.org",
	horizonUrl: "https://horizon-testnet.stellar.org",
	passphrase: Networks.TESTNET,
}
const CONFIG = {
	assetCode: "TLO",
	assetIssuer: "GATBENNAFELDD6XLFPIMT3GBYAGWT4A7XY45P4YCFVPK2HHRNC2HQJ4U",
	sac: "CDVVAQAQ4FKQ4DCPPIIOIAOPRJJBO6HVOXRQX3PXONJVJNNK432O6HW3",
	authorizer: "CD7K7S43HSIR2DLGDT5OWSHDJQIQWFAJWZOIO66T2OVMLNYFL74OK2KU",
	onboard: "CCQJ53C6C7ROJ6DSUG572NN46W3KHRT3BF3RDLZL4PGB4JYICDTPSAZ5",
	backends: ["cap73-one-signature", "cap33-sponsored"],
}
// Classic-submission transport for this demo (the SDK itself no longer uses Horizon).
const horizon = new Horizon.Server(NET.horizonUrl)
const server = new rpc.Server(NET.rpcUrl)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sx = (s, n = 6) => `${s.slice(0, n)}…${s.slice(-n)}`
const expertAcct = (a) => `https://stellar.expert/explorer/testnet/account/${a}`
const expertTx = (h) => `https://stellar.expert/explorer/testnet/tx/${h}`

async function fund(pub) {
	const res = await fetch(`https://friendbot.stellar.org/?addr=${pub}`)
	if (!res.ok) throw new Error(`friendbot failed for ${pub}`)
}
async function submitClassic(xdr, ...signers) {
	const tx = TransactionBuilder.fromXDR(xdr, NET.passphrase)
	signers.forEach((s) => tx.sign(s))
	return horizon.submitTransaction(tx)
}
async function submitSoroban(xdr, signer) {
	const tx = TransactionBuilder.fromXDR(xdr, NET.passphrase)
	tx.sign(signer)
	const sent = await server.sendTransaction(tx)
	if (sent.status === "ERROR")
		throw new Error("send failed: " + JSON.stringify(sent.errorResult))
	let got = await server.getTransaction(sent.hash)
	while (got.status === "NOT_FOUND") {
		await sleep(1500)
		got = await server.getTransaction(sent.hash)
	}
	if (got.status !== "SUCCESS") throw new Error("tx " + got.status)
	return sent.hash
}

async function main() {
	const exchange = Keypair.random() // the third party (e.g. Bitpanda)
	const user = Keypair.random() // a brand-new, unfunded self-custody wallet

	console.log("\n━━━ Authline · third-party withdrawal demo (testnet) ━━━")
	console.log("Exchange :", exchange.publicKey())
	console.log("User     :", user.publicKey(), "(brand-new, 0 XLM)\n")

	console.log("• Funding the exchange via friendbot…")
	await fund(exchange.publicKey())

	console.log(
		"• User requests a withdrawal of TLO → exchange checks their trustline status…",
	)
	let st = await getActivationStatus({
		rpcUrl: NET.rpcUrl,
		account: user.publicKey(),
		assetCode: CONFIG.assetCode,
		assetIssuer: CONFIG.assetIssuer,
	})
	console.log(
		"   status:",
		st,
		"→ no trustline; the exchange establishes one FOR the user.\n",
	)

	console.log(
		"• Step 1/2 — sponsored trustline creation (exchange pays the reserve; user signs once).",
	)
	const unsignedXdr = await buildSponsoredOnboardTx({
		rpcUrl: NET.rpcUrl,
		networkPassphrase: NET.passphrase,
		sponsor: exchange.publicKey(),
		user: user.publicKey(),
		config: CONFIG,
		createUserAccount: true,
	})
	// The sponsored envelope needs TWO signatures: the sponsor's and the user's.
	// The exchange signs FIRST, so the signature travels inside the SEP-7 `xdr`
	// and the wallet's single user signature completes the transaction. Handing
	// over an unsigned envelope would give the user a link that cannot succeed —
	// onboardingRequest now refuses to build one.
	const sponsorSigned = TransactionBuilder.fromXDR(unsignedXdr, NET.passphrase)
	sponsorSigned.sign(exchange)
	const sponsoredXdr = sponsorSigned.toXDR()
	// In a real non-custodial flow the exchange HANDS this to the user to sign — three ways:
	const req = onboardingRequest({
		txXdr: sponsoredXdr,
		networkPassphrase: NET.passphrase,
		userAddress: user.publicKey(),
		msg: "Activate TLO",
		// hostedBase must be an origin the integrator controls (no default).
		hostedBase: "https://onboard.example/app.html",
	})
	console.log("   the exchange would hand the user one of:")
	console.log("     SEP-7   :", req.sep7Uri.slice(0, 72) + "…")
	console.log("     hosted  :", req.hostedUrl)
	// Exactly what a wallet does with the link: add the user's signature, submit.
	const r1 = await submitClassic(sponsoredXdr, user)
	console.log(
		"   ✅ trustline created, reserve paid by the exchange:",
		expertTx(r1.hash),
		"\n",
	)

	console.log(
		"• Step 2/2 — authorize-on-behalf (permissionless; NO user signature, NO issuer signature).",
	)
	await sleep(6000) // let the new trustline propagate to the RPC's ledger snapshot
	// Pure JS, no Rust CLI: buildAuthorizeTx simulates and assembles the
	// authorize_trustline invocation itself. The EXCHANGE is the source and the
	// only signer — the user is merely the argument — which is what makes this
	// step cost zero user signatures.
	const authorizeXdr = await buildAuthorizeTx({
		rpcUrl: NET.rpcUrl,
		networkPassphrase: NET.passphrase,
		source: exchange.publicKey(),
		account: user.publicKey(),
		config: CONFIG,
	})
	const authorizeHash = await submitSoroban(authorizeXdr, exchange)
	console.log(
		"   ✅ authorized by the exchange via the Authorizer contract:",
		expertTx(authorizeHash),
		"\n",
	)

	st = await getActivationStatus({
		rpcUrl: NET.rpcUrl,
		account: user.publicKey(),
		assetCode: CONFIG.assetCode,
		assetIssuer: CONFIG.assetIssuer,
	})
	console.log("━━━ Result ━━━")
	console.log("User trustline status:", st)
	console.log("User on Stellar Expert:", expertAcct(user.publicKey()))
	console.log(
		st.hasTrustline && st.isAuthorized
			? "\n✓ A third party established an AUTHORIZED TLO trustline for a brand-new, zero-XLM user.\n  The user signed once; the exchange paid the reserve and authorized on the issuer's behalf.\n"
			: "\n✗ unexpected final state\n",
	)
}
main().catch((e) => {
	console.error("demo failed:", e?.message || e)
	process.exit(1)
})
