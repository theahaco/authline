import {
	Asset,
	BASE_FEE,
	Keypair,
	Networks,
	Operation,
	TransactionBuilder,
	rpc,
	type Transaction,
} from "@stellar/stellar-sdk"
import {
	ROUTERS,
	buildAuthorizeTx,
	getActivationStatus,
	type OnboarderConfig,
} from "@theahaco/authline"
import { beforeAll, describe, expect, it } from "vitest"

const RUN = process.env.RUN_TESTNET_E2E === "1"
const NET = {
	rpcUrl: "https://soroban-testnet.stellar.org",
	passphrase: Networks.TESTNET,
}
// The pinned testnet EURCV test token (AUTH_REQUIRED + AUTH_REVOCABLE) with the
// authorizer-stub as its SAC admin — see the registry pin. This suite covers
// what the TLO suite does not: detecting an EXISTING unauthorized trustline
// (classic flags + the SAC's authorized() view) and the direct authorize-only
// path (Authorizer.authorize_trustline → SAC set_authorized), no router.
const CONFIG: OnboarderConfig = {
	assetCode: "EURCV",
	assetIssuer: "GCTYD662VYXT34UEPPURGATJSY3YH3YVDM35A7ZAO5F222WTAY2G76L7",
	sac: "CAPQ3JM4LVTKZRDO4PUR3BWHT4IK6QUQK6GLE24MC7IQ6PKTNNZNXPQT",
	authorizer: "CCRKMAOBTP43QRFZR6A62OPNJNQFNHFEY6APAAI2ABHTFOQ4HTDL3D4X",
	router: ROUTERS.TESTNET,
	backends: ["cap73-one-signature"],
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function submitAndConfirm(tx: Transaction) {
	const server = new rpc.Server(NET.rpcUrl)
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
	if (got.status === "NOT_FOUND")
		throw new Error("tx not confirmed within deadline")
	expect(got.status).toBe("SUCCESS")
}

// Both classic flag bits AND the SAC's own authorized() view in one read.
const status = (account: string) =>
	getActivationStatus({
		rpcUrl: NET.rpcUrl,
		account,
		assetCode: CONFIG.assetCode,
		assetIssuer: CONFIG.assetIssuer,
		sac: CONFIG.sac,
		networkPassphrase: NET.passphrase,
	})

describe.skipIf(!RUN)(
	"testnet EURCV unauthorized-trustline detection + authorize-only (real chain)",
	() => {
		const holder = Keypair.random()

		beforeAll(async () => {
			const r = await fetch(
				`https://friendbot.stellar.org/?addr=${holder.publicKey()}`,
			)
			if (!r.ok) throw new Error("friendbot failed")
		}, 120_000)

		it("reads a fresh account as fully not-activated", async () => {
			await expect(status(holder.publicKey())).resolves.toEqual({
				holderKind: "account",
				hasTrustline: false,
				isAuthorized: false,
				isAuthorizedToMaintainLiabilities: false,
				sacAuthorized: false,
			})
		})

		it("detects a classic-created trustline as existing but UNauthorized (classic + SAC agree)", async () => {
			// Plain classic ChangeTrust — for an AUTH_REQUIRED issuer this creates
			// the line with the authorized flag CLEAR. This is the state the dApp's
			// new "authorize" phase must detect.
			const server = new rpc.Server(NET.rpcUrl)
			const acct = await server.getAccount(holder.publicKey())
			const tx = new TransactionBuilder(acct, {
				fee: BASE_FEE,
				networkPassphrase: NET.passphrase,
			})
				.addOperation(
					Operation.changeTrust({
						asset: new Asset(CONFIG.assetCode, CONFIG.assetIssuer),
					}),
				)
				.setTimeout(120)
				.build()
			tx.sign(holder)
			await submitAndConfirm(tx)

			await expect(status(holder.publicKey())).resolves.toEqual({
				holderKind: "account",
				hasTrustline: true,
				isAuthorized: false,
				isAuthorizedToMaintainLiabilities: false,
				sacAuthorized: false,
			})
		}, 120_000)

		it("authorizes via the SAC-admin authorizer; classic AND SAC views flip to authorized", async () => {
			// The direct authorize-only path the dApp's Authorize button uses:
			// Authorizer.authorize_trustline(holder) → SAC set_authorized. The
			// holder is only the fee source; authority comes from the Authorizer
			// being the SAC admin. Also proves the P26 JS decode of a flag-WRITING
			// simulation works end-to-end (buildAuthorizeTx calls prepareTransaction).
			const xdr = await buildAuthorizeTx({
				rpcUrl: NET.rpcUrl,
				networkPassphrase: NET.passphrase,
				source: holder.publicKey(),
				account: holder.publicKey(),
				config: CONFIG,
			})
			const tx = TransactionBuilder.fromXDR(xdr, NET.passphrase) as Transaction
			tx.sign(holder)
			await submitAndConfirm(tx)

			await expect(status(holder.publicKey())).resolves.toEqual({
				holderKind: "account",
				hasTrustline: true,
				isAuthorized: true,
				isAuthorizedToMaintainLiabilities: false,
				sacAuthorized: true,
			})
		}, 180_000)
	},
)
