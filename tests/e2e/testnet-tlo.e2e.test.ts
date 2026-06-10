import {
	Keypair,
	Networks,
	TransactionBuilder,
	rpc,
} from "@stellar/stellar-sdk"
import {
	ROUTERS,
	buildOnboardTx,
	getActivationStatus,
	type OnboarderConfig,
} from "@theaha/authline"
import { beforeAll, describe, expect, it } from "vitest"

const RUN = process.env.RUN_TESTNET_E2E === "1"
const NET = {
	rpcUrl: "https://soroban-testnet.stellar.org",
	horizonUrl: "https://horizon-testnet.stellar.org",
	passphrase: Networks.TESTNET,
}
// TLO is the AUTH_REQUIRED test asset whose SAC admin IS the asset-agnostic
// authorizer contract (denylist, open-by-default) — see the SEP draft's
// Reference Implementation table. Onboarding it exercises the router's
// on-chain DISCOVERY path: trust → admin probe → authorize, one signature.
const CONFIG: OnboarderConfig = {
	assetCode: "TLO",
	assetIssuer: "GATBENNAFELDD6XLFPIMT3GBYAGWT4A7XY45P4YCFVPK2HHRNC2HQJ4U",
	sac: "CDVVAQAQ4FKQ4DCPPIIOIAOPRJJBO6HVOXRQX3PXONJVJNNK432O6HW3",
	// The pinned router id (SDK registry) — see the note in the USDC e2e.
	router: ROUTERS.TESTNET,
	backends: ["cap73-one-signature"],
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!RUN)("testnet TLO discovery onboard (real chain)", () => {
	const holder = Keypair.random()

	beforeAll(async () => {
		const r = await fetch(
			`https://friendbot.stellar.org/?addr=${holder.publicKey()}`,
		)
		if (!r.ok) throw new Error("friendbot failed")
	}, 120_000)

	it("creates AND authorizes an AUTH_REQUIRED trustline via admin discovery", async () => {
		const xdr = await buildOnboardTx({
			rpcUrl: NET.rpcUrl,
			networkPassphrase: NET.passphrase,
			holder: holder.publicKey(),
			config: CONFIG,
		})
		const tx = TransactionBuilder.fromXDR(xdr, NET.passphrase)
		tx.sign(holder)
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
			throw new Error("onboard tx not confirmed within deadline")
		expect(got.status).toBe("SUCCESS")

		// AUTH_REQUIRED + authorized==true proves the DISCOVERED authorize step
		// ran — trust alone would leave isAuthorized false for TLO.
		const st = await getActivationStatus({
			horizonUrl: NET.horizonUrl,
			account: holder.publicKey(),
			assetCode: CONFIG.assetCode,
			assetIssuer: CONFIG.assetIssuer,
		})
		expect(st).toEqual({ hasTrustline: true, isAuthorized: true })
	}, 180_000)
})
