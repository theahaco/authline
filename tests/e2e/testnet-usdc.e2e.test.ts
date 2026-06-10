import { execFileSync } from "node:child_process"
import {
	Keypair,
	Networks,
	TransactionBuilder,
	rpc,
} from "@stellar/stellar-sdk"
import {
	buildOnboardTx,
	getActivationStatus,
	ROUTERS,
	type OnboarderConfig,
} from "@theaha/authline"
import { beforeAll, describe, expect, it } from "vitest"

const RUN = process.env.RUN_TESTNET_E2E === "1"
const NET = {
	rpcUrl: "https://soroban-testnet.stellar.org",
	horizonUrl: "https://horizon-testnet.stellar.org",
	passphrase: Networks.TESTNET,
}
const CONFIG: OnboarderConfig = {
	assetCode: "USDC",
	assetIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
	sac: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
	router: process.env.PUBLIC_ROUTER ?? ROUTERS.TESTNET,
	authorizer: "",
	backends: ["cap73-one-signature"],
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!RUN)("testnet USDC trust (real chain)", () => {
	const holder = Keypair.random()

	beforeAll(async () => {
		const r = await fetch(
			`https://friendbot.stellar.org/?addr=${holder.publicKey()}`,
		)
		if (!r.ok) throw new Error("friendbot failed")
		// Ensure the SAC exists (idempotent).
		execFileSync("node", ["scripts/deploy-testnet-usdc-sac.mjs"], {
			stdio: "inherit",
			env: { ...process.env, SOURCE_SECRET: holder.secret() },
		})
	}, 120_000)

	it("creates an authorized USDC trustline via SAC.trust(holder)", async () => {
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
			throw new Error("trust tx not confirmed within deadline")
		expect(got.status).toBe("SUCCESS")

		const st = await getActivationStatus({
			horizonUrl: NET.horizonUrl,
			account: holder.publicKey(),
			assetCode: CONFIG.assetCode,
			assetIssuer: CONFIG.assetIssuer,
		})
		expect(st).toEqual({ hasTrustline: true, isAuthorized: true })
	}, 180_000)
})
