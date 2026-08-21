import { createServer, type Server } from "node:http"
import {
	Account,
	Address,
	BASE_FEE,
	Contract,
	TransactionBuilder,
	rpc,
	scValToNative,
} from "@stellar/stellar-sdk"
import {
	buildAuthorizeTx,
	getActivationStatus,
	defaultAllowHttp,
	type OfficialAsset,
} from "@theahaco/authline"
import { loadConfig, type RelayerConfig } from "./config.js"
import { handleRequest, type ChainOps } from "./service.js"

// Re-exported so the e2e suite (and self-hosters embedding the relayer) can
// import everything from one module.
export { loadConfig, type RelayerConfig } from "./config.js"
export * from "./service.js"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The real chain behind {@link ChainOps}, one RPC server per process. */
export function makeChainOps(cfg: RelayerConfig): ChainOps {
	const server = new rpc.Server(cfg.rpcUrl, {
		allowHttp: defaultAllowHttp(cfg.rpcUrl),
	})

	return {
		async view(asset: OfficialAsset, account: string) {
			const status = await getActivationStatus({
				rpcUrl: cfg.rpcUrl,
				account,
				assetCode: asset.code,
				assetIssuer: asset.issuer,
				sac: asset.sac,
				networkPassphrase: cfg.networkPassphrase,
			})
			// A missing trustline and a missing account read identically from the
			// trustline entry — disambiguate with one getAccount only when needed.
			let accountExists = true
			if (status.holderKind === "account" && !status.hasTrustline) {
				try {
					await server.getAccount(account)
				} catch {
					accountExists = false
				}
			}
			return { status, accountExists }
		},

		async isEligible(asset: OfficialAsset, account: string) {
			if (!asset.authorizer)
				throw new Error(`${asset.code} has no authorizer contract`)
			// Simulation ignores the sequence number, so a dummy source Account
			// (the issuer — always a funded G-account) avoids a getAccount call.
			const tx = new TransactionBuilder(new Account(asset.issuer, "0"), {
				fee: BASE_FEE,
				networkPassphrase: cfg.networkPassphrase,
			})
				.addOperation(
					new Contract(asset.authorizer).call(
						"is_eligible",
						new Address(account).toScVal(),
					),
				)
				.setTimeout(60)
				.build()
			const sim = await server.simulateTransaction(tx)
			if (!rpc.Api.isSimulationSuccess(sim) || !sim.result)
				throw new Error(
					`is_eligible simulation failed: ${"error" in sim ? sim.error : "no result"}`,
				)
			const val: unknown = scValToNative(sim.result.retval)
			if (typeof val !== "boolean")
				throw new Error(`is_eligible returned a non-boolean: ${String(val)}`)
			return val
		},

		async authorize(asset: OfficialAsset, account: string) {
			const xdrB64 = await buildAuthorizeTx({
				rpcUrl: cfg.rpcUrl,
				networkPassphrase: cfg.networkPassphrase,
				source: cfg.signer.publicKey(),
				account,
				config: {
					assetCode: asset.code,
					assetIssuer: asset.issuer,
					sac: asset.sac,
					authorizer: asset.authorizer,
					backends: [],
				},
			})
			const tx = TransactionBuilder.fromXDR(xdrB64, cfg.networkPassphrase)
			tx.sign(cfg.signer)
			const sent = await server.sendTransaction(tx)
			if (sent.status === "ERROR")
				throw new Error(
					`sendTransaction ERROR: ${sent.errorResult?.toXDR("base64") ?? "(no errorResult)"}`,
				)
			const deadline = Date.now() + 60_000
			let got = await server.getTransaction(sent.hash)
			while (got.status === "NOT_FOUND" && Date.now() < deadline) {
				await sleep(1200)
				got = await server.getTransaction(sent.hash)
			}
			if (got.status !== rpc.Api.GetTransactionStatus.SUCCESS)
				throw new Error(
					got.status === rpc.Api.GetTransactionStatus.FAILED
						? `transaction ${sent.hash} failed: ${got.resultXdr.toXDR("base64")}`
						: `transaction ${sent.hash} not confirmed within deadline`,
				)
			return sent.hash
		},
	}
}

/** Wire {@link handleRequest} to node:http. Exported for the e2e suite. */
export function startServer(cfg: RelayerConfig, ops: ChainOps): Server {
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x"}`)
		const auth = req.headers.authorization
		const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined
		handleRequest(cfg, ops, req.method ?? "GET", url, bearer)
			.then(({ status, body }) => {
				res.writeHead(status, { "content-type": "application/json" })
				res.end(JSON.stringify(body))
			})
			.catch((e: unknown) => {
				res.writeHead(500, { "content-type": "application/json" })
				res.end(
					JSON.stringify({
						error: "internal",
						detail: e instanceof Error ? e.message : String(e),
					}),
				)
			})
	})
	server.listen(cfg.port)
	return server
}

// Entry point: `node dist/server.js` (skipped when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
	const cfg = loadConfig(process.env)
	startServer(cfg, makeChainOps(cfg))
	console.log(
		`authline-relayer listening on :${cfg.port} — network ${cfg.network}, ` +
			`relayer account ${cfg.signer.publicKey()}, default asset ${cfg.defaultAsset}`,
	)
}
