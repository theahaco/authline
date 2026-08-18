import {
	Account,
	Asset,
	AuthRequiredFlag,
	BASE_FEE,
	Horizon,
	Keypair,
	Networks,
	Operation,
	TransactionBuilder,
	type Transaction,
} from "@stellar/stellar-sdk"
import {
	buildClaimTx,
	buildClaimableBalanceDelivery,
	getActivationStatus,
	getClaimableBalance,
	findClaimableBalances,
	planClaim,
} from "@theahaco/authline"
import { beforeAll, describe, expect, it } from "vitest"

const RUN = process.env.RUN_TESTNET_E2E === "1"
const NET = {
	rpcUrl: "https://soroban-testnet.stellar.org",
	horizonUrl: "https://horizon-testnet.stellar.org",
	passphrase: Networks.TESTNET,
}
const horizon = new Horizon.Server(NET.horizonUrl)

async function fund(pub: string) {
	const r = await fetch(`https://friendbot.stellar.org/?addr=${pub}`)
	if (!r.ok) throw new Error(`friendbot failed for ${pub}`)
}
async function submit(xdr: string, ...signers: Keypair[]) {
	const tx = TransactionBuilder.fromXDR(xdr, NET.passphrase) as Transaction
	signers.forEach((s) => tx.sign(s))
	return horizon.submitTransaction(tx)
}
const seqOf = async (pub: string) =>
	(await horizon.loadAccount(pub)).sequenceNumber()

/**
 * The exchange-withdrawal → claimable-balance → claim run, end to end on
 * testnet, for an OPEN asset. This is the deliverable's headline claim: the
 * recipient is not ready, the withdrawal completes anyway as a claimable
 * balance, and the user's ONE signature both opens the trustline and collects
 * the funds.
 *
 * A fresh issuer + asset is minted per run so the test owns its own state.
 */
describe.skipIf(!RUN)("testnet claimable-balance delivery (open asset)", () => {
	const issuer = Keypair.random()
	const exchange = Keypair.random()
	// The recipient: an account that exists but holds NOTHING — no trustline,
	// and (after the min-balance floor) no spendable XLM for a fee or reserve.
	const user = Keypair.random()
	const CODE = "CBX"
	const config = { assetCode: CODE, assetIssuer: issuer.publicKey() }
	const asset = new Asset(CODE, issuer.publicKey())
	let balanceId = ""

	beforeAll(async () => {
		await Promise.all([fund(issuer.publicKey()), fund(exchange.publicKey())])
		// The exchange takes delivery of the asset it will later pay out.
		const seq = await seqOf(exchange.publicKey())
		await submit(
			new TransactionBuilder(new Account(exchange.publicKey(), seq), {
				fee: BASE_FEE,
				networkPassphrase: NET.passphrase,
			})
				.addOperation(Operation.changeTrust({ asset }))
				.setTimeout(120)
				.build()
				.toXDR(),
			exchange,
		)
		const iseq = await seqOf(issuer.publicKey())
		await submit(
			new TransactionBuilder(new Account(issuer.publicKey(), iseq), {
				fee: BASE_FEE,
				networkPassphrase: NET.passphrase,
			})
				.addOperation(
					Operation.payment({
						destination: exchange.publicKey(),
						asset,
						amount: "1000",
					}),
				)
				// The user's account is created by the EXCHANGE at exactly the
				// 1 XLM minimum — zero user signatures, and zero spendable XLM,
				// so the user provably cannot fund the claim themselves.
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
	}, 180_000)

	it("cannot be paid normally — the recipient has no trustline", async () => {
		const st = await getActivationStatus({
			rpcUrl: NET.rpcUrl,
			account: user.publicKey(),
			...config,
		})
		expect(st.hasTrustline).toBe(false)

		// A plain payment to a trustline-less recipient is exactly what the
		// claimable-balance path exists to rescue: prove it really fails.
		const seq = await seqOf(exchange.publicKey())
		const doomed = new TransactionBuilder(
			new Account(exchange.publicKey(), seq),
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
		await expect(horizon.submitTransaction(doomed)).rejects.toMatchObject({
			response: { data: { status: 400 } },
		})
	}, 120_000)

	it("delivers the withdrawal as a claimable balance instead (no user action)", async () => {
		const delivery = buildClaimableBalanceDelivery({
			networkPassphrase: NET.passphrase,
			sender: exchange.publicKey(),
			senderSequence: await seqOf(exchange.publicKey()),
			recipient: user.publicKey(),
			amount: "100.0000000",
			config,
			// Sweep the balance back if the user never shows up.
			reclaimAfterSeconds: 30 * 24 * 3600,
		})
		const res = await submit(delivery.xdr, exchange)
		console.log(
			`claimable-balance delivery: https://stellar.expert/explorer/testnet/tx/${res.hash}`,
		)
		balanceId = delivery.balanceId

		// The id the SDK derived offline must match the entry actually on-ledger.
		const onChain = await getClaimableBalance({
			rpcUrl: NET.rpcUrl,
			balanceId,
		})
		expect(onChain).not.toBeNull()
		expect(onChain?.amount).toBe("100.0000000")
		expect(onChain?.asset).toBe(`${CODE}:${issuer.publicKey()}`)
		expect(onChain?.claimants).toContain(user.publicKey())
	}, 180_000)

	it("finds the pending balance from the claimant's side alone", async () => {
		// The cold-start path: the user opens the activation page with nothing
		// but their address, and the page discovers what is waiting for them.
		const found = await findClaimableBalances({
			horizonUrl: NET.horizonUrl,
			claimant: user.publicKey(),
			config,
		})
		expect(found.map((b) => b.balanceId)).toContain(balanceId)
	}, 120_000)

	it("claims it with ONE user signature that also opens the trustline", async () => {
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
		expect(plan.steps.map((s) => s.kind)).toEqual(["claim-with-trustline"])
		expect(plan.userSignatures).toBe(1)

		const xdr = buildClaimTx({
			networkPassphrase: NET.passphrase,
			claimant: user.publicKey(),
			// The exchange sources and pays; the user has nothing to spend.
			feeSource: exchange.publicKey(),
			sourceSequence: await seqOf(exchange.publicKey()),
			balanceId,
			config,
			createTrustline: true,
			sponsor: exchange.publicKey(),
		})

		// THE acceptance check: the user contributes exactly one signature.
		const tx = TransactionBuilder.fromXDR(xdr, NET.passphrase) as Transaction
		tx.sign(exchange)
		tx.sign(user)
		const hint = user.signatureHint()
		expect(tx.signatures.filter((s) => s.hint().equals(hint))).toHaveLength(1)

		const res = await horizon.submitTransaction(tx)
		console.log(
			`claim + trustline (1 user signature): https://stellar.expert/explorer/testnet/tx/${res.hash}`,
		)

		// The user now holds a real, funded trustline.
		const after = await getActivationStatus({
			rpcUrl: NET.rpcUrl,
			account: user.publicKey(),
			...config,
		})
		expect(after.hasTrustline).toBe(true)
		expect(after.isAuthorized).toBe(true)

		const acct = await horizon.loadAccount(user.publicKey())
		const line = acct.balances.find(
			(b) => "asset_code" in b && b.asset_code === CODE,
		)
		expect(line && "balance" in line ? line.balance : null).toBe("100.0000000")

		// The reserve was paid by the exchange, not the user: the user's XLM is
		// untouched at the 1 XLM they were created with.
		const xlm = acct.balances.find((b) => b.asset_type === "native")
		expect(xlm && "balance" in xlm ? xlm.balance : null).toBe("1.0000000")

		// And the balance entry is gone from the ledger.
		await expect(
			getClaimableBalance({ rpcUrl: NET.rpcUrl, balanceId }),
		).resolves.toBeNull()
	}, 240_000)
})

/**
 * The REGULATED (AUTH_REQUIRED) counterpart. Here the single-signature claim is
 * impossible, and this proves why on-chain rather than by assertion in prose:
 * a trustline opened inside the claim transaction is UNAUTHORIZED when the
 * claim operation runs, so the fused envelope fails. Authorization has to land
 * in a transaction of its own, which is exactly what `planClaim` reports.
 *
 * A fresh AUTH_REQUIRED asset is minted per run. The authorize step is done
 * here with the classic issuer-signed `SetTrustLineFlags` purely to keep this
 * test free of contract deployment — in production it is the permissionless
 * Soroban `buildAuthorizeTx` (Case A, ZERO user signatures), which the EURCV
 * e2e covers against a real deployed Authorizer. Either way it is a separate
 * transaction, which is the property under test.
 */
describe.skipIf(!RUN)(
	"testnet claimable-balance delivery (regulated asset)",
	() => {
		const issuer = Keypair.random()
		const exchange = Keypair.random()
		const user = Keypair.random()
		const CODE = "CBR"
		const config = { assetCode: CODE, assetIssuer: issuer.publicKey() }
		const asset = new Asset(CODE, issuer.publicKey())
		let balanceId = ""

		const txFrom = async (kp: Keypair) =>
			new TransactionBuilder(
				new Account(kp.publicKey(), await seqOf(kp.publicKey())),
				{ fee: BASE_FEE, networkPassphrase: NET.passphrase },
			)

		beforeAll(async () => {
			await Promise.all([fund(issuer.publicKey()), fund(exchange.publicKey())])

			// The issuer requires explicit authorization for every trustline.
			await submit(
				(await txFrom(issuer))
					// AUTH_REQUIRED alone is what makes the claim ordering matter.
					.addOperation(Operation.setOptions({ setFlags: AuthRequiredFlag }))
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
			// The exchange takes delivery of the asset it will pay out.
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
						Operation.setTrustLineFlags({
							trustor: exchange.publicKey(),
							asset,
							flags: { authorized: true },
						}),
					)
					.addOperation(
						Operation.payment({
							destination: exchange.publicKey(),
							asset,
							amount: "1000",
						}),
					)
					.setTimeout(120)
					.build()
					.toXDR(),
				issuer,
			)

			const delivery = buildClaimableBalanceDelivery({
				networkPassphrase: NET.passphrase,
				sender: exchange.publicKey(),
				senderSequence: await seqOf(exchange.publicKey()),
				recipient: user.publicKey(),
				amount: "50.0000000",
				config,
			})
			await submit(delivery.xdr, exchange)
			balanceId = delivery.balanceId
		}, 300_000)

		it("plans three steps, only two of which cost the user a signature", async () => {
			const st = await getActivationStatus({
				rpcUrl: NET.rpcUrl,
				account: user.publicKey(),
				...config,
			})
			const plan = planClaim({
				hasTrustline: st.hasTrustline,
				isAuthorized: st.isAuthorized,
				authRequired: true,
			})
			expect(plan.steps.map((s) => s.kind)).toEqual([
				"create-trustline",
				"authorize",
				"claim",
			])
			expect(plan.steps[1].signer).toBe("integrator")
			expect(plan.userSignatures).toBe(2)
		}, 120_000)

		it("rejects the fused one-signature claim — the new trustline is unauthorized", async () => {
			const xdr = buildClaimTx({
				networkPassphrase: NET.passphrase,
				claimant: user.publicKey(),
				feeSource: exchange.publicKey(),
				sourceSequence: await seqOf(exchange.publicKey()),
				balanceId,
				config,
				createTrustline: true,
				sponsor: exchange.publicKey(),
			})
			const tx = TransactionBuilder.fromXDR(xdr, NET.passphrase) as Transaction
			tx.sign(exchange)
			tx.sign(user)
			// The ledger itself refuses: this is why regulated assets need step 2.
			await expect(horizon.submitTransaction(tx)).rejects.toMatchObject({
				response: { data: { status: 400 } },
			})
		}, 180_000)

		it("succeeds as three transactions, with the authorize costing no user signature", async () => {
			// Step 1 — the user opens the trustline, reserve sponsored (user signs).
			await submit(
				(await txFrom(exchange))
					.addOperation(
						Operation.beginSponsoringFutureReserves({
							sponsoredId: user.publicKey(),
						}),
					)
					.addOperation(
						Operation.changeTrust({ asset, source: user.publicKey() }),
					)
					.addOperation(
						Operation.endSponsoringFutureReserves({ source: user.publicKey() }),
					)
					.setTimeout(120)
					.build()
					.toXDR(),
				exchange,
				user,
			)

			// Step 2 — authorize. NO user signature: in production this is
			// `buildAuthorizeTx` against the Authorizer contract (see the EURCV e2e).
			await submit(
				(await txFrom(issuer))
					.addOperation(
						Operation.setTrustLineFlags({
							trustor: user.publicKey(),
							asset,
							flags: { authorized: true },
						}),
					)
					.setTimeout(120)
					.build()
					.toXDR(),
				issuer,
			)

			// Step 3 — the claim now that the line is authorized (user signs).
			const xdr = buildClaimTx({
				networkPassphrase: NET.passphrase,
				claimant: user.publicKey(),
				feeSource: exchange.publicKey(),
				sourceSequence: await seqOf(exchange.publicKey()),
				balanceId,
				config,
			})
			const tx = TransactionBuilder.fromXDR(xdr, NET.passphrase) as Transaction
			tx.sign(exchange)
			tx.sign(user)
			const res = await horizon.submitTransaction(tx)
			console.log(
				`regulated claim (step 3/3): https://stellar.expert/explorer/testnet/tx/${res.hash}`,
			)

			const after = await getActivationStatus({
				rpcUrl: NET.rpcUrl,
				account: user.publicKey(),
				...config,
			})
			expect(after.hasTrustline).toBe(true)
			expect(after.isAuthorized).toBe(true)

			const acct = await horizon.loadAccount(user.publicKey())
			const line = acct.balances.find(
				(b) => "asset_code" in b && b.asset_code === CODE,
			)
			expect(line && "balance" in line ? line.balance : null).toBe("50.0000000")
		}, 300_000)
	},
)
