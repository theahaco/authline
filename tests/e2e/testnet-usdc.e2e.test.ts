import { execFileSync } from "node:child_process"
import {
	Keypair,
	Networks,
	TransactionBuilder,
	rpc,
} from "@stellar/stellar-sdk"
import {
	buildOnboardTx,
	decodeOnboardStatus,
	getActivationStatus,
	ROUTERS,
	type OnboarderConfig,
} from "@theahaco/authline"
import { beforeAll, describe, expect, it } from "vitest"

const RUN = process.env.RUN_TESTNET_E2E === "1"
const NET = {
	rpcUrl: "https://soroban-testnet.stellar.org",
	passphrase: Networks.TESTNET,
}
const CONFIG: OnboarderConfig = {
	assetCode: "USDC",
	assetIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
	sac: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
	// The pinned router id (SDK registry). .env.e2e's PUBLIC_ROUTER feeds only
	// the Playwright browser build — plain `vitest run` loads no dotenv — so
	// the Node e2e reads the pin directly, same as every other id here.
	router: ROUTERS.TESTNET,
	authorizer: "",
	backends: ["cap73-one-signature"],
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!RUN)("testnet USDC onboard via router (real chain)", () => {
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

	it("creates an authorized USDC trustline via router.onboard", async () => {
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
		// Print the on-chain evidence link (milestone D1.1 asks for one
		// onboarding of each asset type visible on Stellar Expert).
		console.log(
			`USDC onboard tx: https://stellar.expert/explorer/testnet/tx/${sent.hash}`,
		)
		// A non-SUCCESS terminal state (NOT_FOUND past the deadline, or FAILED)
		// fails here; the check also narrows `got` for `returnValue` below.
		if (got.status !== "SUCCESS")
			throw new Error(`trust tx did not succeed: ${got.status}`)
		// The router's own verdict, decoded from the real chain return value —
		// guards the wire shape `decodeOnboardStatus` assumes.
		expect(decodeOnboardStatus(got.returnValue)).toBe("Authorized")

		const st = await getActivationStatus({
			rpcUrl: NET.rpcUrl,
			account: holder.publicKey(),
			assetCode: CONFIG.assetCode,
			assetIssuer: CONFIG.assetIssuer,
		})
		expect(st).toEqual({
			holderKind: "account",
			hasTrustline: true,
			isAuthorized: true,
			isAuthorizedToMaintainLiabilities: false,
		})
	}, 180_000)
})
