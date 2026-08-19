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
	type Transaction,
} from "@stellar/stellar-sdk"
import {
	buildAuthorizeTx,
	buildSponsoredOnboardTx,
	getActivationStatus,
	type OnboarderConfig,
} from "@theahaco/authline"
import { beforeAll, describe, expect, it } from "vitest"

const RUN = process.env.RUN_TESTNET_E2E === "1"
const NET = {
	rpcUrl: "https://soroban-testnet.stellar.org",
	horizonUrl: "https://horizon-testnet.stellar.org",
	passphrase: Networks.TESTNET,
}
const horizon = new Horizon.Server(NET.horizonUrl)
const server = new rpc.Server(NET.rpcUrl)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const expertTx = (h: string) =>
	`https://stellar.expert/explorer/testnet/tx/${h}`

async function fund(pub: string) {
	const r = await fetch(`https://friendbot.stellar.org/?addr=${pub}`)
	if (!r.ok) throw new Error(`friendbot failed for ${pub}`)
}
const seqOf = async (pub: string) =>
	(await horizon.loadAccount(pub)).sequenceNumber()

/** Sign a built envelope and submit it classically. */
async function submit(xdr: string, ...signers: Keypair[]) {
	const tx = TransactionBuilder.fromXDR(xdr, NET.passphrase) as Transaction
	signers.forEach((s) => tx.sign(s))
	return horizon.submitTransaction(tx)
}

/** How many of this envelope's signatures belong to `kp`. */
function signatureCountFor(xdr: string, kp: Keypair, ...signers: Keypair[]) {
	const tx = TransactionBuilder.fromXDR(xdr, NET.passphrase) as Transaction
	signers.forEach((s) => tx.sign(s))
	const hint = kp.signatureHint()
	return tx.signatures.filter((s) => s.hint().equals(hint)).length
}

/** Does this account exist on the ledger at all? */
async function accountExists(pub: string): Promise<boolean> {
	try {
		await horizon.loadAccount(pub)
		return true
	} catch {
		return false
	}
}

/**
 * Case B — the CAP-33 sponsored path: the holder has NOTHING. No trustline, no
 * XLM, and not even an account on the ledger. The integrator sponsors both the
 * account's base reserve and the trustline reserve, and the user signs exactly
 * ONCE.
 *
 * This is the case the router (Case C) cannot serve: CAP-73 `trust()` has no
 * sponsorship, so it requires a funded holder who can pay their own 0.5 XLM.
 * Here the holder can pay nothing at all, which is why the test asserts the
 * user's native balance is still ZERO afterwards — not merely "small".
 */
describe.skipIf(!RUN)(
	"testnet CAP-33 sponsored onboarding — open asset",
	() => {
		const issuer = Keypair.random()
		const exchange = Keypair.random()
		// Never funded: this account does not exist until the exchange creates it.
		const user = Keypair.random()
		const CODE = "SPNX"
		const asset = new Asset(CODE, issuer.publicKey())
		const config: OnboarderConfig = {
			assetCode: CODE,
			assetIssuer: issuer.publicKey(),
			sac: "",
			backends: ["cap33-sponsored"],
		}

		beforeAll(async () => {
			await Promise.all([fund(issuer.publicKey()), fund(exchange.publicKey())])
		}, 180_000)

		it("starts from nothing — the holder has no account at all", async () => {
			expect(await accountExists(user.publicKey())).toBe(false)
			// The SDK reports a missing account as simply not-activated rather than
			// throwing, which is what lets an integrator branch on it.
			const st = await getActivationStatus({
				rpcUrl: NET.rpcUrl,
				account: user.publicKey(),
				assetCode: config.assetCode,
				assetIssuer: config.assetIssuer,
			})
			expect(st.hasTrustline).toBe(false)
		}, 120_000)

		it("creates the account AND the trustline on ONE user signature", async () => {
			const xdr = await buildSponsoredOnboardTx({
				rpcUrl: NET.rpcUrl,
				networkPassphrase: NET.passphrase,
				sponsor: exchange.publicKey(),
				user: user.publicKey(),
				config,
				createUserAccount: true,
			})

			// The sponsorship sandwich, with the CreateAccount inside it.
			const built = TransactionBuilder.fromXDR(
				xdr,
				NET.passphrase,
			) as Transaction
			expect(built.operations.map((o) => o.type)).toEqual([
				"beginSponsoringFutureReserves",
				"createAccount",
				"changeTrust",
				"endSponsoringFutureReserves",
			])

			// THE acceptance check for Case B: the user contributes exactly one.
			expect(signatureCountFor(xdr, user, exchange, user)).toBe(1)

			const res = await submit(xdr, exchange, user)
			console.log(
				`CAP-33 sponsored onboard (1 user signature): ${expertTx(res.hash)}`,
			)

			const acct = await horizon.loadAccount(user.publicKey())
			const line = acct.balances.find(
				(b) => "asset_code" in b && b.asset_code === CODE,
			)
			expect(line).toBeDefined()

			// The user paid NOTHING: no base reserve, no trustline reserve. Both the
			// account entry and the trustline are sponsored by the exchange, and the
			// user's own XLM is still exactly zero.
			const xlm = acct.balances.find((b) => b.asset_type === "native")
			expect(xlm && "balance" in xlm ? xlm.balance : null).toBe("0.0000000")
			expect(acct.sponsor).toBe(exchange.publicKey())
			expect(line && "sponsor" in line ? line.sponsor : null).toBe(
				exchange.publicKey(),
			)
			// Three sponsored reserves, not two: an account's minimum balance is
			// `(2 + subentries) * baseReserve`, so the account ENTRY itself
			// accounts for two of them and the trustline subentry for the third.
			expect(acct.subentry_count).toBe(1)
			expect(acct.num_sponsored).toBe(3)

			const sponsorAcct = await horizon.loadAccount(exchange.publicKey())
			expect(sponsorAcct.num_sponsoring).toBe(3)
		}, 240_000)

		it("leaves the holder able to receive the withdrawal immediately", async () => {
			await submit(
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

			const acct = await horizon.loadAccount(user.publicKey())
			const line = acct.balances.find(
				(b) => "asset_code" in b && b.asset_code === CODE,
			)
			expect(line && "balance" in line ? line.balance : null).toBe(
				"100.0000000",
			)
		}, 180_000)
	},
)

/**
 * Case B for a REGULATED asset, which needs Case A bolted on: the sponsored
 * `ChangeTrust` leaves an UNAUTHORIZED trustline, and the integrator authorizes
 * it permissionlessly afterwards. The point of this pair is the signature
 * ledger — one signature from the user for the whole onboarding, and ZERO on
 * the authorize, which is asserted here on the real envelope rather than
 * asserted in prose.
 *
 * Uses the deployed TLO asset (SAC admin = the asset-agnostic Authorizer).
 */
describe.skipIf(!RUN)(
	"testnet CAP-33 sponsored onboarding — regulated asset",
	() => {
		const exchange = Keypair.random()
		const user = Keypair.random()
		const config: OnboarderConfig = {
			assetCode: "TLO",
			assetIssuer: "GATBENNAFELDD6XLFPIMT3GBYAGWT4A7XY45P4YCFVPK2HHRNC2HQJ4U",
			sac: "CDVVAQAQ4FKQ4DCPPIIOIAOPRJJBO6HVOXRQX3PXONJVJNNK432O6HW3",
			authorizer: "CD7K7S43HSIR2DLGDT5OWSHDJQIQWFAJWZOIO66T2OVMLNYFL74OK2KU",
			backends: ["cap33-sponsored"],
		}

		beforeAll(async () => {
			await fund(exchange.publicKey())
		}, 180_000)

		it("sponsors the trustline for a nonexistent account — 1 user signature", async () => {
			expect(await accountExists(user.publicKey())).toBe(false)

			const xdr = await buildSponsoredOnboardTx({
				rpcUrl: NET.rpcUrl,
				networkPassphrase: NET.passphrase,
				sponsor: exchange.publicKey(),
				user: user.publicKey(),
				config,
				createUserAccount: true,
			})
			expect(signatureCountFor(xdr, user, exchange, user)).toBe(1)
			const res = await submit(xdr, exchange, user)
			console.log(`sponsored TLO trustline: ${expertTx(res.hash)}`)

			// Created, but NOT yet usable: AUTH_REQUIRED means the line starts
			// unauthorized, which is exactly what the authorize step is for.
			const st = await getActivationStatus({
				rpcUrl: NET.rpcUrl,
				account: user.publicKey(),
				assetCode: config.assetCode,
				assetIssuer: config.assetIssuer,
			})
			expect(st.hasTrustline).toBe(true)
			expect(st.isAuthorized).toBe(false)
		}, 240_000)

		it("authorizes it with ZERO user signatures (Case A)", async () => {
			// Let the new trustline reach the RPC's ledger snapshot before the
			// authorize simulates against it.
			await sleep(6000)
			const xdr = await buildAuthorizeTx({
				rpcUrl: NET.rpcUrl,
				networkPassphrase: NET.passphrase,
				source: exchange.publicKey(),
				account: user.publicKey(),
				config,
			})

			const tx = TransactionBuilder.fromXDR(xdr, NET.passphrase) as Transaction
			// The integrator sources it; the holder appears only as the argument.
			expect(tx.source).toBe(exchange.publicKey())
			tx.sign(exchange)
			// THE acceptance check for Case A: the user signs nothing, and the
			// envelope carries the exchange's signature alone.
			expect(tx.signatures).toHaveLength(1)
			expect(
				tx.signatures.filter((s) => s.hint().equals(user.signatureHint())),
			).toHaveLength(0)

			const sent = await server.sendTransaction(tx)
			if (sent.status === "ERROR")
				throw new Error(
					`sendTransaction returned ERROR: ${sent.errorResult?.toXDR("base64") ?? "(no errorResult)"}`,
				)
			const deadline = Date.now() + 60_000
			let got = await server.getTransaction(sent.hash)
			while (got.status === "NOT_FOUND" && Date.now() < deadline) {
				await sleep(1500)
				got = await server.getTransaction(sent.hash)
			}
			if (got.status !== "SUCCESS")
				throw new Error(`authorize did not succeed: ${got.status}`)
			console.log(
				`authorize-on-behalf (0 user signatures): ${expertTx(sent.hash)}`,
			)

			const st = await getActivationStatus({
				rpcUrl: NET.rpcUrl,
				account: user.publicKey(),
				assetCode: config.assetCode,
				assetIssuer: config.assetIssuer,
			})
			expect(st.hasTrustline).toBe(true)
			expect(st.isAuthorized).toBe(true)
		}, 240_000)
	},
)
