#!/usr/bin/env node
/**
 * Standalone testnet proof run for the Authline SDK deliverable.
 *
 * Exercises the three transaction shapes the SDK builds — plus the
 * claimable-balance withdrawal that defers onboarding to the user's claim —
 * against the real Stellar testnet, and prints every resulting transaction
 * hash as a stellar.expert link. The point is evidence a third party can
 * verify without trusting this output: every hash below is a public ledger
 * entry.
 *
 *   Case A  authorize an existing unauthorized trustline — ZERO user signatures
 *   Case B  holder has nothing, not even an account — CAP-33 sponsored, ONE signature
 *   Case C  the onboard router — one call, on-chain discovery, ONE signature
 *   Case D  exchange withdrawal delivered as a claimable balance; the claim
 *           itself opens the trustline — ONE signature
 *
 * Every account is generated fresh and funded by friendbot, so the run owns
 * all of its own state and can be repeated by anyone at any time. Nothing
 * here reads a secret or touches mainnet.
 *
 * Usage, from the repo root:
 *
 *   npm run build -w @theahaco/authline
 *   node scripts/prove-cases.mjs [--out docs/testnet-evidence.md]
 *
 * Assertions are hard failures: the script cannot print a claim it did not
 * actually prove on-chain.
 */
import { execFileSync } from "node:child_process"
import { existsSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import {
	Account,
	Asset,
	BASE_FEE,
	Horizon,
	Keypair,
	Networks,
	Operation,
	TransactionBuilder,
	rpc,
} from "@stellar/stellar-sdk"

const require = createRequire(import.meta.url)

const DIST = new URL("../packages/authline-sdk/dist/index.js", import.meta.url)
if (!existsSync(DIST)) {
	console.error(
		"The SDK is not built. Run:\n\n  npm run build -w @theahaco/authline\n",
	)
	process.exit(1)
}
const {
	ROUTERS,
	buildAuthorizeTx,
	buildClaimTx,
	buildClaimableBalanceDelivery,
	buildOnboardTx,
	buildSponsoredOnboardTx,
	decodeOnboardStatus,
	findClaimableBalances,
	getActivationStatus,
	getClaimableBalance,
	onboardingRequest,
	planClaim,
} = await import("@theahaco/authline")

// ---------------------------------------------------------------------------
// Network + pinned testnet ids
// ---------------------------------------------------------------------------

const NET = {
	rpcUrl: "https://soroban-testnet.stellar.org",
	horizonUrl: "https://horizon-testnet.stellar.org",
	passphrase: Networks.TESTNET,
}
const horizon = new Horizon.Server(NET.horizonUrl)
const server = new rpc.Server(NET.rpcUrl)

/** AUTH_REQUIRED test asset whose SAC admin IS the Trustline Authorizer. */
const TLO = {
	assetCode: "TLO",
	assetIssuer: "GATBENNAFELDD6XLFPIMT3GBYAGWT4A7XY45P4YCFVPK2HHRNC2HQJ4U",
	sac: "CDVVAQAQ4FKQ4DCPPIIOIAOPRJJBO6HVOXRQX3PXONJVJNNK432O6HW3",
	authorizer: "CD7K7S43HSIR2DLGDT5OWSHDJQIQWFAJWZOIO66T2OVMLNYFL74OK2KU",
}
/** Circle's testnet USDC — the open-asset counterpart. */
const USDC = {
	assetCode: "USDC",
	assetIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
	sac: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
}

const expertTx = (h) => `https://stellar.expert/explorer/testnet/tx/${h}`
const expertAcct = (a) => `https://stellar.expert/explorer/testnet/account/${a}`

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function check(cond, msg) {
	if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`)
}

async function fund(pub) {
	for (let attempt = 1; attempt <= 4; attempt++) {
		const r = await fetch(`https://friendbot.stellar.org/?addr=${pub}`)
		if (r.ok) return
		if (attempt === 4) throw new Error(`friendbot failed for ${pub}`)
		await sleep(2000 * attempt)
	}
}

const seqOf = async (pub) => (await horizon.loadAccount(pub)).sequenceNumber()

async function accountExists(pub) {
	try {
		await horizon.loadAccount(pub)
		return true
	} catch {
		return false
	}
}

/** Sign an envelope and submit it through Horizon (classic path). */
async function submit(xdr, ...signers) {
	const tx = TransactionBuilder.fromXDR(xdr, NET.passphrase)
	signers.forEach((s) => tx.sign(s))
	return horizon.submitTransaction(tx)
}

/** Submit a Soroban envelope and wait for it to reach a terminal state. */
async function submitSoroban(tx, label) {
	const sent = await server.sendTransaction(tx)
	if (sent.status === "ERROR") {
		throw new Error(
			`${label}: sendTransaction returned ERROR: ${
				sent.errorResult?.toXDR("base64") ?? "(no errorResult)"
			}`,
		)
	}
	const deadline = Date.now() + 60_000
	let got = await server.getTransaction(sent.hash)
	while (got.status === "NOT_FOUND" && Date.now() < deadline) {
		await sleep(1500)
		got = await server.getTransaction(sent.hash)
	}
	if (got.status !== "SUCCESS")
		throw new Error(`${label}: transaction did not succeed (${got.status})`)
	return { hash: sent.hash, result: got }
}

/** How many signatures on this envelope belong to `kp`. */
function userSignatureCount(tx, kp) {
	const hint = kp.signatureHint()
	return tx.signatures.filter((s) => s.hint().equals(hint)).length
}

const balanceOf = async (pub, code) => {
	const acct = await horizon.loadAccount(pub)
	const line =
		code === "native"
			? acct.balances.find((b) => b.asset_type === "native")
			: acct.balances.find((b) => b.asset_code === code)
	return {
		acct,
		balance: line && "balance" in line ? line.balance : null,
		line,
	}
}

// ---------------------------------------------------------------------------
// Evidence ledger
// ---------------------------------------------------------------------------

const evidence = []
const actors = []

function record(row) {
	evidence.push(row)
	const sig =
		row.userSignatures === 0
			? "0 user signatures"
			: `${row.userSignatures} user signature${row.userSignatures === 1 ? "" : "s"}`
	console.log(`    ✔ ${row.claim}`)
	console.log(`      ${sig}  ·  ${expertTx(row.hash)}`)
}

function heading(title) {
	console.log(`\n${"─".repeat(72)}\n${title}\n${"─".repeat(72)}`)
}

// ---------------------------------------------------------------------------
// Case B — the holder has nothing at all (CAP-33 sponsored, ONE signature)
// ---------------------------------------------------------------------------

async function caseB() {
	heading(
		"CASE B · holder has no account, no XLM, no trustline\n" +
			"          the platform sponsors account + reserve, user signs ONCE",
	)

	const issuer = Keypair.random()
	const exchange = Keypair.random()
	const user = Keypair.random() // never funded — this account does not exist
	const CODE = "SPNX"
	const asset = new Asset(CODE, issuer.publicKey())
	const config = {
		assetCode: CODE,
		assetIssuer: issuer.publicKey(),
		sac: "",
		backends: ["cap33-sponsored"],
	}
	actors.push({
		case: "B",
		role: "sponsoring platform",
		pub: exchange.publicKey(),
	})
	actors.push({
		case: "B",
		role: "holder (started from nothing)",
		pub: user.publicKey(),
	})

	await Promise.all([fund(issuer.publicKey()), fund(exchange.publicKey())])

	// The starting condition, proven rather than asserted in prose.
	check(
		!(await accountExists(user.publicKey())),
		"Case B holder must not exist on the ledger before the run",
	)
	const before = await getActivationStatus({
		rpcUrl: NET.rpcUrl,
		account: user.publicKey(),
		assetCode: config.assetCode,
		assetIssuer: config.assetIssuer,
	})
	check(!before.hasTrustline, "Case B holder must start with no trustline")
	console.log(`    · holder ${user.publicKey()} does not exist on-ledger`)

	const xdr = await buildSponsoredOnboardTx({
		rpcUrl: NET.rpcUrl,
		networkPassphrase: NET.passphrase,
		sponsor: exchange.publicKey(),
		user: user.publicKey(),
		config,
		createUserAccount: true,
	})

	// The CAP-33 sponsorship sandwich, with the account creation inside it.
	const built = TransactionBuilder.fromXDR(xdr, NET.passphrase)
	check(
		JSON.stringify(built.operations.map((o) => o.type)) ===
			JSON.stringify([
				"beginSponsoringFutureReserves",
				"createAccount",
				"changeTrust",
				"endSponsoringFutureReserves",
			]),
		"Case B envelope must be a CAP-33 sponsorship sandwich wrapping createAccount + changeTrust",
	)

	const signed = TransactionBuilder.fromXDR(xdr, NET.passphrase)
	signed.sign(exchange)
	signed.sign(user)
	const userSigs = userSignatureCount(signed, user)
	check(
		userSigs === 1,
		`Case B must cost the user exactly 1 signature, got ${userSigs}`,
	)

	const res = await horizon.submitTransaction(signed)

	// The holder is onboarded and paid NOTHING: both reserves are sponsored and
	// their own XLM balance is still exactly zero.
	const { acct, balance: xlm } = await balanceOf(user.publicKey(), "native")
	const { line } = await balanceOf(user.publicKey(), CODE)
	check(line !== undefined, "Case B holder must now hold the trustline")
	check(xlm === "0.0000000", `Case B holder must still hold 0 XLM, got ${xlm}`)
	check(
		acct.sponsor === exchange.publicKey(),
		"Case B account entry must be sponsored by the platform",
	)
	check(
		line.sponsor === exchange.publicKey(),
		"Case B trustline must be sponsored by the platform",
	)
	check(
		acct.num_sponsored === 3,
		`expected 3 sponsored reserves, got ${acct.num_sponsored}`,
	)

	record({
		caseId: "B",
		claim:
			"Nonexistent, zero-XLM holder gets an account AND a trustline; " +
			"platform pays all three reserves",
		userSignatures: 1,
		hash: res.hash,
		detail:
			`Holder ${user.publicKey()} did not exist on-ledger before this transaction. ` +
			`Afterwards they hold a ${CODE} trustline while their own XLM balance is still ` +
			`0.0000000 — account entry and trustline are both sponsored by ${exchange.publicKey()} ` +
			`(num_sponsored = 3).`,
	})

	// And the withdrawal can land immediately.
	const payRes = await submit(
		new TransactionBuilder(
			new Account(issuer.publicKey(), await seqOf(issuer.publicKey())),
			{ fee: BASE_FEE, networkPassphrase: NET.passphrase },
		)
			.addOperation(
				Operation.payment({
					destination: user.publicKey(),
					asset,
					amount: "100",
				}),
			)
			.setTimeout(120)
			.build()
			.toXDR(),
		issuer,
	)
	const { balance: got } = await balanceOf(user.publicKey(), CODE)
	check(
		got === "100.0000000",
		`Case B holder should have received 100 ${CODE}, got ${got}`,
	)

	record({
		caseId: "B",
		claim: "The onboarded holder receives the withdrawal immediately",
		userSignatures: 0,
		hash: payRes.hash,
		detail: `100 ${CODE} paid to the freshly onboarded holder and credited in full.`,
	})
}

// ---------------------------------------------------------------------------
// Case A — authorize an existing unauthorized trustline, ZERO user signatures
// ---------------------------------------------------------------------------

async function caseA() {
	heading(
		"CASE A · holder already has an UNAUTHORIZED trustline\n" +
			"          anyone can submit the authorization — ZERO user signatures",
	)

	const exchange = Keypair.random()
	const user = Keypair.random()
	const config = { ...TLO, backends: ["cap33-sponsored"] }
	actors.push({
		case: "A",
		role: "submitter (no special authority)",
		pub: exchange.publicKey(),
	})
	actors.push({
		case: "A",
		role: "holder (never signs the authorize)",
		pub: user.publicKey(),
	})

	await fund(exchange.publicKey())

	// Setup: produce the starting condition — an unauthorized trustline on a
	// regulated (AUTH_REQUIRED) asset.
	const setupXdr = await buildSponsoredOnboardTx({
		rpcUrl: NET.rpcUrl,
		networkPassphrase: NET.passphrase,
		sponsor: exchange.publicKey(),
		user: user.publicKey(),
		config,
		createUserAccount: true,
	})
	const setupRes = await submit(setupXdr, exchange, user)
	console.log(
		`    · setup: sponsored TLO trustline — ${expertTx(setupRes.hash)}`,
	)

	const mid = await getActivationStatus({
		rpcUrl: NET.rpcUrl,
		account: user.publicKey(),
		assetCode: config.assetCode,
		assetIssuer: config.assetIssuer,
	})
	check(mid.hasTrustline, "Case A precondition: trustline must exist")
	check(
		!mid.isAuthorized,
		"Case A precondition: the trustline must start UNAUTHORIZED",
	)
	console.log("    · precondition confirmed: trustline exists, NOT authorized")

	// Let the new trustline reach the RPC's ledger snapshot before simulating.
	await sleep(6000)

	const xdr = await buildAuthorizeTx({
		rpcUrl: NET.rpcUrl,
		networkPassphrase: NET.passphrase,
		source: exchange.publicKey(),
		account: user.publicKey(),
		config,
	})
	const tx = TransactionBuilder.fromXDR(xdr, NET.passphrase)
	check(
		tx.source === exchange.publicKey(),
		"Case A must be sourced by the submitter, not the holder",
	)
	tx.sign(exchange)

	// THE acceptance check: the holder's key is nowhere on this envelope, and
	// the submitter holds no issuer authority either — the authorizer contract
	// exposes `authorize_trustline` permissionlessly.
	check(
		tx.signatures.length === 1,
		"Case A envelope must carry exactly one signature",
	)
	check(
		userSignatureCount(tx, user) === 0,
		"Case A must cost the holder ZERO signatures",
	)

	const { hash } = await submitSoroban(tx, "Case A authorize")

	const after = await getActivationStatus({
		rpcUrl: NET.rpcUrl,
		account: user.publicKey(),
		assetCode: config.assetCode,
		assetIssuer: config.assetIssuer,
	})
	check(
		after.hasTrustline && after.isAuthorized,
		"Case A trustline must end authorized",
	)

	record({
		caseId: "A",
		claim:
			"An unauthorized trustline is authorized on the holder's behalf, " +
			"submitted by an account with no issuer authority",
		userSignatures: 0,
		hash,
		detail:
			`The envelope is sourced by ${exchange.publicKey()} and carries exactly one ` +
			`signature, none of which belongs to holder ${user.publicKey()}. The trustline ` +
			`flipped from isAuthorized=false to isAuthorized=true. Authorizer contract: ` +
			`${TLO.authorizer}.`,
	})
}

// ---------------------------------------------------------------------------
// Case C — the onboard router: one call, on-chain discovery, ONE signature
// ---------------------------------------------------------------------------

async function caseC(asset, kind) {
	heading(
		`CASE C · router path — ${asset.assetCode} (${kind})\n` +
			"          one call, asset class discovered on-chain, ONE signature",
	)

	const holder = Keypair.random()
	const config = {
		...asset,
		router: ROUTERS.TESTNET,
		backends: ["cap73-one-signature"],
	}
	actors.push({
		case: "C",
		role: `holder (${asset.assetCode})`,
		pub: holder.publicKey(),
	})

	await fund(holder.publicKey())

	const before = await getActivationStatus({
		rpcUrl: NET.rpcUrl,
		account: holder.publicKey(),
		assetCode: config.assetCode,
		assetIssuer: config.assetIssuer,
	})
	check(
		!before.hasTrustline,
		`Case C ${asset.assetCode} holder must start with no trustline`,
	)

	const xdr = await buildOnboardTx({
		rpcUrl: NET.rpcUrl,
		networkPassphrase: NET.passphrase,
		holder: holder.publicKey(),
		config,
	})

	// The wallet handoff is built from this very envelope — see sep7() below.
	if (asset.assetCode === "TLO")
		sep7Sample = { xdr, holder: holder.publicKey() }

	const tx = TransactionBuilder.fromXDR(xdr, NET.passphrase)
	tx.sign(holder)
	check(
		tx.signatures.length === 1 && userSignatureCount(tx, holder) === 1,
		"Case C must cost the holder exactly one signature and carry no others",
	)

	const { hash, result } = await submitSoroban(tx, `Case C ${asset.assetCode}`)

	// The router's own verdict, decoded from the real chain return value.
	const verdict = decodeOnboardStatus(result.returnValue)
	check(
		verdict === "Authorized",
		`router should report Authorized for ${asset.assetCode}, got ${verdict}`,
	)

	const after = await getActivationStatus({
		rpcUrl: NET.rpcUrl,
		account: holder.publicKey(),
		assetCode: config.assetCode,
		assetIssuer: config.assetIssuer,
	})
	check(
		after.hasTrustline && after.isAuthorized,
		`Case C ${asset.assetCode} must end with an authorized trustline`,
	)

	record({
		caseId: "C",
		claim:
			`Router onboards ${asset.assetCode} (${kind}) — trustline created and ` +
			`authorized in ONE transaction`,
		userSignatures: 1,
		hash,
		detail:
			`Single call to router ${ROUTERS.TESTNET} \`onboard(sac, holder)\`. The router ` +
			`probed \`SAC.admin()\` on-chain to decide whether authorization was needed and ` +
			`returned "${verdict}". Holder ${holder.publicKey()} signed once and nobody else ` +
			`signed at all.`,
	})
}

// ---------------------------------------------------------------------------
// Case D — exchange withdrawal to a recipient who is not ready
// ---------------------------------------------------------------------------

async function caseD() {
	heading(
		"CASE D · exchange withdrawal, recipient NOT ready\n" +
			"          delivered as a claimable balance; the claim opens the trustline",
	)

	const issuer = Keypair.random()
	const exchange = Keypair.random()
	const user = Keypair.random()
	const CODE = "CBX"
	const config = { assetCode: CODE, assetIssuer: issuer.publicKey() }
	const asset = new Asset(CODE, issuer.publicKey())
	actors.push({ case: "D", role: "exchange", pub: exchange.publicKey() })
	actors.push({ case: "D", role: "withdrawing user", pub: user.publicKey() })

	await Promise.all([fund(issuer.publicKey()), fund(exchange.publicKey())])

	// The exchange takes delivery of the asset it will pay out, and creates the
	// user's account at exactly the 1 XLM floor — so the user provably cannot
	// fund a reserve or a fee themselves.
	await submit(
		new TransactionBuilder(
			new Account(exchange.publicKey(), await seqOf(exchange.publicKey())),
			{ fee: BASE_FEE, networkPassphrase: NET.passphrase },
		)
			.addOperation(Operation.changeTrust({ asset }))
			.setTimeout(120)
			.build()
			.toXDR(),
		exchange,
	)
	await submit(
		new TransactionBuilder(
			new Account(issuer.publicKey(), await seqOf(issuer.publicKey())),
			{ fee: BASE_FEE, networkPassphrase: NET.passphrase },
		)
			.addOperation(
				Operation.payment({
					destination: exchange.publicKey(),
					asset,
					amount: "1000",
				}),
			)
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

	// A plain payment genuinely fails — this is what the claimable path rescues.
	const st = await getActivationStatus({
		rpcUrl: NET.rpcUrl,
		account: user.publicKey(),
		...config,
	})
	check(!st.hasTrustline, "Case D recipient must start with no trustline")
	const doomed = new TransactionBuilder(
		new Account(exchange.publicKey(), await seqOf(exchange.publicKey())),
		{ fee: BASE_FEE, networkPassphrase: NET.passphrase },
	)
		.addOperation(
			Operation.payment({
				destination: user.publicKey(),
				asset,
				amount: "100",
			}),
		)
		.setTimeout(120)
		.build()
	doomed.sign(exchange)
	let plainPaymentFailed = false
	try {
		await horizon.submitTransaction(doomed)
	} catch {
		plainPaymentFailed = true
	}
	check(
		plainPaymentFailed,
		"Case D precondition: a plain payment to a trustline-less recipient must fail",
	)
	console.log(
		"    · precondition confirmed: a plain payment to this user FAILS",
	)

	// The withdrawal completes anyway, with no user action at all.
	const delivery = buildClaimableBalanceDelivery({
		networkPassphrase: NET.passphrase,
		sender: exchange.publicKey(),
		senderSequence: await seqOf(exchange.publicKey()),
		recipient: user.publicKey(),
		amount: "100.0000000",
		config,
		reclaimAfterSeconds: 30 * 24 * 3600,
	})
	const delRes = await submit(delivery.xdr, exchange)

	const onChain = await getClaimableBalance({
		rpcUrl: NET.rpcUrl,
		balanceId: delivery.balanceId,
	})
	check(onChain !== null, "the claimable balance must exist on-ledger")
	check(
		onChain.amount === "100.0000000" &&
			onChain.claimants.includes(user.publicKey()),
		"the on-ledger balance must match what the SDK derived offline",
	)

	record({
		caseId: "D",
		claim:
			"Withdrawal to an unready recipient completes as a claimable balance " +
			"(no user action required)",
		userSignatures: 0,
		hash: delRes.hash,
		detail:
			`The recipient had no trustline and a plain payment to them failed. The exchange ` +
			`instead created claimable balance ${delivery.balanceId} for 100 ${CODE}, with a ` +
			`30-day reclaim clause. The SDK derived that balance id offline and it matches ` +
			`the ledger entry exactly.`,
	})

	// The user opens the activation page knowing only their own address.
	const found = await findClaimableBalances({
		horizonUrl: NET.horizonUrl,
		claimant: user.publicKey(),
		config,
	})
	check(
		found.map((b) => b.balanceId).includes(delivery.balanceId),
		"the claimant must be able to discover the pending balance from their address alone",
	)
	console.log(
		"    · user discovers the pending balance from their address alone",
	)

	// The claim: ONE signature that also sets up the trustline.
	const plan = planClaim({
		hasTrustline: st.hasTrustline,
		isAuthorized: st.isAuthorized,
		authRequired: false,
	})
	check(
		plan.userSignatures === 1 &&
			JSON.stringify(plan.steps.map((s) => s.kind)) ===
				JSON.stringify(["claim-with-trustline"]),
		"the open-asset claim must plan as a single fused step costing one signature",
	)

	const claimXdr = buildClaimTx({
		networkPassphrase: NET.passphrase,
		claimant: user.publicKey(),
		feeSource: exchange.publicKey(),
		sourceSequence: await seqOf(exchange.publicKey()),
		balanceId: delivery.balanceId,
		config,
		createTrustline: true,
		sponsor: exchange.publicKey(),
	})
	const claimTx = TransactionBuilder.fromXDR(claimXdr, NET.passphrase)
	claimTx.sign(exchange)
	claimTx.sign(user)
	check(
		userSignatureCount(claimTx, user) === 1,
		"the claim must cost the user exactly one signature",
	)

	const claimRes = await horizon.submitTransaction(claimTx)

	const after = await getActivationStatus({
		rpcUrl: NET.rpcUrl,
		account: user.publicKey(),
		...config,
	})
	check(
		after.hasTrustline && after.isAuthorized,
		"the claim must leave an authorized trustline",
	)
	const { balance: assetBal } = await balanceOf(user.publicKey(), CODE)
	const { balance: xlmBal } = await balanceOf(user.publicKey(), "native")
	check(
		assetBal === "100.0000000",
		`user should hold 100 ${CODE}, got ${assetBal}`,
	)
	check(xlmBal === "1.0000000", `user's XLM must be untouched, got ${xlmBal}`)
	check(
		(await getClaimableBalance({
			rpcUrl: NET.rpcUrl,
			balanceId: delivery.balanceId,
		})) === null,
		"the claimable balance entry must be consumed",
	)

	record({
		caseId: "D",
		claim:
			"ONE user signature claims the balance AND opens the trustline in the " +
			"same transaction",
		userSignatures: 1,
		hash: claimRes.hash,
		detail:
			`The user signed once. That single transaction created their ${CODE} trustline ` +
			`(reserve sponsored by the exchange) and collected the 100 ${CODE}. Their own XLM ` +
			`balance is unchanged at 1.0000000, and the claimable balance entry is gone from ` +
			`the ledger.`,
	})
}

// ---------------------------------------------------------------------------
// Wallet handoffs — SEP-7 URI / deep link / hosted redirect
// ---------------------------------------------------------------------------

let sep7Sample = null
let handoffs = null

function walletHandoffs() {
	heading("WALLET HANDOFFS · SEP-7 URI, deep link, hosted redirect")
	if (!sep7Sample) {
		console.log("    (skipped — no Case C envelope captured)")
		return
	}
	// The SDK deliberately has no default hosting origin — an integrator opts
	// into one they control. Pass --hosted-base to exercise the third handoff;
	// without it the run reports two forms rather than inventing a URL.
	handoffs = onboardingRequest({
		txXdr: sep7Sample.xdr,
		networkPassphrase: NET.passphrase,
		userAddress: sep7Sample.holder,
		...(hostedBase ? { hostedBase } : {}),
		msg: "Activate your TLO trustline",
	})
	console.log(
		"    SEP-7 URI (open in any Stellar wallet — Nido, Freighter, Lobstr):",
	)
	console.log(`      ${handoffs.sep7Uri.slice(0, 110)}…`)
	console.log(`    deep link:   same URI, routed by the OS to a wallet app`)
	console.log(
		handoffs.hostedUrl
			? `    hosted page: ${handoffs.hostedUrl}`
			: "    hosted page: not generated — pass --hosted-base <origin you control>",
	)
	console.log(
		"\n    NOTE: these are generated and shape-checked here, but proving a wallet\n" +
			"    OPENS and SIGNS them is a UI claim — record it on video, since no\n" +
			"    transaction hash can demonstrate which app produced a signature.",
	)
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function writeReport(outPath, startedAt) {
	let commit = "(unknown)"
	try {
		commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
			encoding: "utf8",
		}).trim()
	} catch {}
	let version = "(unknown)"
	try {
		version = require("../packages/authline-sdk/package.json").version
	} catch {}

	const CASE_TITLES = {
		A: "Case A — existing unauthorized trustline, authorized by anyone (0 user signatures)",
		B: "Case B — holder has nothing; platform sponsors account + reserve (1 user signature)",
		C: "Case C — onboard router, asset class discovered on-chain (1 user signature)",
		D: "Case D — claimable-balance withdrawal; the claim opens the trustline (1 user signature)",
	}

	const lines = []
	lines.push("# Authline SDK — testnet proof run")
	lines.push("")
	lines.push(
		"Every transaction below is a real entry on the Stellar **testnet** public ledger. " +
			"Follow any link to verify it independently — nothing here relies on trusting this document.",
	)
	lines.push("")
	lines.push(`- **Run at:** ${startedAt.toISOString()}`)
	lines.push(`- **Network:** Stellar testnet (\`${NET.passphrase}\`)`)
	lines.push(
		`- **SDK:** \`@theahaco/authline\` v${version} @ commit \`${commit}\``,
	)
	lines.push(`- **Onboard router:** \`${ROUTERS.TESTNET}\``)
	lines.push(`- **Trustline authorizer:** \`${TLO.authorizer}\``)
	lines.push("")
	lines.push("Reproduce with:")
	lines.push("")
	lines.push("```")
	lines.push("npm ci")
	lines.push("npm run build -w @theahaco/authline")
	lines.push("node scripts/prove-cases.mjs")
	lines.push("```")
	lines.push("")
	lines.push(
		"All accounts are generated fresh and funded by friendbot on each run, so the script " +
			"owns all of its own state and needs no secrets or preexisting setup.",
	)
	lines.push("")
	lines.push("## Summary")
	lines.push("")
	lines.push("| Case | What it proves | User signatures | Transaction |")
	lines.push("| --- | --- | --- | --- |")
	for (const e of evidence) {
		lines.push(
			`| ${e.caseId} | ${e.claim} | **${e.userSignatures}** | [\`${e.hash.slice(0, 12)}…\`](${expertTx(e.hash)}) |`,
		)
	}
	lines.push("")

	for (const id of ["A", "B", "C", "D"]) {
		const rows = evidence.filter((e) => e.caseId === id)
		if (rows.length === 0) continue
		lines.push(`## ${CASE_TITLES[id]}`)
		lines.push("")
		for (const e of rows) {
			lines.push(`### ${e.claim}`)
			lines.push("")
			lines.push(`- **User signatures:** ${e.userSignatures}`)
			lines.push(`- **Transaction:** ${expertTx(e.hash)}`)
			lines.push("")
			lines.push(e.detail)
			lines.push("")
		}
	}

	if (handoffs) {
		lines.push("## Wallet handoffs")
		lines.push("")
		lines.push(
			"The SDK emits three handoff forms for the same onboarding. The URI below was " +
				"generated by this run from the Case C envelope:",
		)
		lines.push("")
		lines.push("```")
		lines.push(handoffs.sep7Uri)
		lines.push("```")
		lines.push("")
		lines.push(
			handoffs.hostedUrl
				? `Hosted activation page: ${handoffs.hostedUrl}`
				: "Hosted redirect: not exercised by this run. The SDK has no default hosting " +
						"origin by design — an integrator opts into one they control, via " +
						"`--hosted-base`.",
		)
		lines.push("")
		lines.push(
			"The deep link is the same SEP-7 URI — SEP-7 *is* the registered scheme; it is " +
				"surfaced separately because integrators place it in an `href` rather than a QR code.",
		)
		lines.push("")
		lines.push(
			"> A transaction hash proves a signature exists, not which application produced it. " +
				"That a wallet opens and signs this URI is a UI claim and should be evidenced by a " +
				"screen recording.",
		)
		lines.push("")
	}

	lines.push("## Accounts used")
	lines.push("")
	lines.push("| Case | Role | Account |")
	lines.push("| --- | --- | --- |")
	for (const a of actors) {
		lines.push(
			`| ${a.case} | ${a.role} | [\`${a.pub.slice(0, 8)}…${a.pub.slice(-6)}\`](${expertAcct(a.pub)}) |`,
		)
	}
	lines.push("")

	writeFileSync(outPath, `${lines.join("\n")}\n`)
	return outPath
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const flag = (name) => {
	const i = args.indexOf(name)
	return i !== -1 && args[i + 1] ? args[i + 1] : null
}
const outPath = flag("--out") ?? "testnet-evidence.md"
/** Origin serving the hosted activation page. No default: see walletHandoffs. */
const hostedBase = flag("--hosted-base")

const startedAt = new Date()

console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║  Authline SDK — testnet proof run                                    ║
║  Three transaction shapes + claimable-balance delivery, on-chain.    ║
╚══════════════════════════════════════════════════════════════════════╝

Network : Stellar testnet
Router  : ${ROUTERS.TESTNET}
Started : ${startedAt.toISOString()}

Every account below is generated fresh and funded by friendbot.
`)

try {
	await caseA()
	await caseB()
	await caseC(TLO, "regulated / AUTH_REQUIRED")
	await caseC(USDC, "open")
	await caseD()
	walletHandoffs()

	const written = writeReport(outPath, startedAt)

	heading("RESULT")
	console.log(
		`    ${evidence.length} claims proven on testnet, all assertions passed.\n`,
	)
	for (const e of evidence) {
		console.log(
			`    Case ${e.caseId} · ${e.userSignatures} user sig · ${expertTx(e.hash)}`,
		)
	}
	console.log(`\n    Shareable report written to: ${written}\n`)
} catch (err) {
	console.error(`\n\n✖ PROOF RUN FAILED\n\n  ${err.message}\n`)
	if (evidence.length > 0) {
		console.error("  Proven before the failure:")
		for (const e of evidence)
			console.error(`    Case ${e.caseId} · ${expertTx(e.hash)}`)
		console.error("")
	}
	process.exitCode = 1
}
