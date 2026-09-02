import { Keypair } from "@stellar/stellar-sdk"
import { resolveOfficialAsset, type ActivationStatus } from "@theahaco/authline"
import { describe, expect, it } from "vitest"
import { type RelayerConfig } from "./config.js"
import {
	computeReady,
	explainChainError,
	handleRequest,
	type AccountView,
	type ChainOps,
} from "./service.js"

// The pinned testnet assets: EURCV is regulated (has an authorizer), USDC is
// open. The relayer's behavior forks on exactly that distinction.
const EURCV = resolveOfficialAsset("EURCV", "TESTNET")!
const USDC = resolveOfficialAsset("USDC", "TESTNET")

const HOLDER = Keypair.random().publicKey()

const cfg: RelayerConfig = {
	network: "TESTNET",
	networkPassphrase: "Test SDF Network ; September 2015",
	rpcUrl: "https://soroban-testnet.stellar.org",
	signer: Keypair.random(),
	port: 0,
	defaultAsset: "EURCV",
}

const gStatus = (over: Partial<ActivationStatus> = {}): ActivationStatus => ({
	holderKind: "account",
	hasTrustline: false,
	isAuthorized: false,
	isAuthorizedToMaintainLiabilities: false,
	...over,
})

const view = (status: ActivationStatus, accountExists = true): AccountView => ({
	status,
	accountExists,
})

/** ChainOps stub: every method rejects unless overridden. */
const ops = (over: Partial<ChainOps>): ChainOps => ({
	view: () => Promise.reject(new Error("view not stubbed")),
	isEligible: () => Promise.reject(new Error("isEligible not stubbed")),
	authorize: () => Promise.reject(new Error("authorize not stubbed")),
	...over,
})

const GET = (path: string, o?: Partial<ChainOps>, token?: string) =>
	handleRequest(cfg, ops(o ?? {}), "GET", new URL(`http://x${path}`), token)
const POST = (path: string, o?: Partial<ChainOps>, token?: string) =>
	handleRequest(cfg, ops(o ?? {}), "POST", new URL(`http://x${path}`), token)

describe("computeReady", () => {
	it("regulated G-account: needs trustline AND the AUTHORIZED flag", () => {
		expect(computeReady(EURCV, view(gStatus(), false))).toEqual({
			ready: false,
			reason: "no_account",
		})
		expect(computeReady(EURCV, view(gStatus()))).toEqual({
			ready: false,
			reason: "no_trustline",
		})
		expect(computeReady(EURCV, view(gStatus({ hasTrustline: true })))).toEqual({
			ready: false,
			reason: "trustline_unauthorized",
		})
		expect(
			computeReady(
				EURCV,
				view(gStatus({ hasTrustline: true, isAuthorized: true })),
			),
		).toEqual({ ready: true })
	})

	it("open asset: a bare trustline is ready", () => {
		expect(USDC).not.toBeNull()
		expect(computeReady(USDC!, view(gStatus({ hasTrustline: true })))).toEqual({
			ready: true,
		})
	})

	it("contract holder: the SAC's authorized() view is the only signal", () => {
		const c = (sacAuthorized?: boolean): ActivationStatus =>
			gStatus({ holderKind: "contract", sacAuthorized })
		expect(computeReady(EURCV, view(c(true)))).toEqual({ ready: true })
		expect(computeReady(EURCV, view(c(false)))).toEqual({
			ready: false,
			reason: "not_authorized",
		})
		// An unreadable SAC view must NOT report ready.
		expect(computeReady(EURCV, view(c(undefined))).ready).toBe(false)
	})
})

describe("explainChainError", () => {
	it("maps the authorizer's typed refusals to stable HTTP errors", () => {
		const cases: Array<[number, number, string]> = [
			[1, 403, "account_banned"],
			[2, 403, "account_not_allowed"],
			[3, 409, "no_trustline"],
			[4, 503, "authorizer_paused"],
		]
		for (const [code, status, error] of cases) {
			const r = explainChainError(
				new Error(`host invocation failed: Error(Contract, #${code})`),
			)
			expect([r.status, r.body.error]).toEqual([status, error])
		}
	})

	it("passes anything untyped through as a 502", () => {
		const r = explainChainError(new Error("rpc timeout"))
		expect(r.status).toBe(502)
		expect(r.body.error).toBe("chain_error")
	})
})

describe("routing and validation", () => {
	it("healthz names the network and the relayer account", async () => {
		const r = await GET("/healthz")
		expect(r.status).toBe(200)
		expect(r.body).toMatchObject({
			ok: true,
			network: "TESTNET",
			relayer: cfg.signer.publicKey(),
		})
	})

	it("rejects a malformed account before touching the chain", async () => {
		const r = await GET("/v1/accounts/not-an-address/ready")
		expect([r.status, r.body.error]).toEqual([400, "invalid_account"])
	})

	it("rejects an unpinned asset code", async () => {
		const r = await GET(`/v1/accounts/${HOLDER}/ready?asset=DOGE`)
		expect([r.status, r.body.error]).toEqual([404, "unknown_asset"])
	})

	it("404s unknown routes and 405s wrong methods", async () => {
		expect((await GET("/v1/nope")).status).toBe(404)
		expect((await POST(`/v1/accounts/${HOLDER}/ready`)).status).toBe(405)
		expect((await GET(`/v1/accounts/${HOLDER}/authorize`)).status).toBe(405)
	})
})

describe("GET /ready", () => {
	it("reports an unauthorized trustline with authorizable from policy", async () => {
		const r = await GET(`/v1/accounts/${HOLDER}/ready`, {
			view: () => Promise.resolve(view(gStatus({ hasTrustline: true }))),
			isEligible: () => Promise.resolve(true),
		})
		expect(r.status).toBe(200)
		expect(r.body).toMatchObject({
			asset: "EURCV",
			regulated: true,
			ready: false,
			reason: "trustline_unauthorized",
			authorizable: true,
		})
	})

	it("omits authorizable when the policy read fails, rather than guessing", async () => {
		const r = await GET(`/v1/accounts/${HOLDER}/ready`, {
			view: () => Promise.resolve(view(gStatus({ hasTrustline: true }))),
			isEligible: () => Promise.reject(new Error("rpc down")),
		})
		expect(r.status).toBe(200)
		expect(r.body).not.toHaveProperty("authorizable")
	})

	it("does not consult policy for a ready account", async () => {
		const r = await GET(`/v1/accounts/${HOLDER}/ready`, {
			view: () =>
				Promise.resolve(
					view(gStatus({ hasTrustline: true, isAuthorized: true })),
				),
			// isEligible left unstubbed: calling it would reject the request.
		})
		expect(r.body).toMatchObject({ ready: true })
	})
})

describe("POST /authorize", () => {
	const unauthorized = () =>
		Promise.resolve(view(gStatus({ hasTrustline: true })))

	it("refuses an open asset outright", async () => {
		const r = await POST(`/v1/accounts/${HOLDER}/authorize?asset=USDC`)
		expect([r.status, r.body.error]).toEqual([400, "asset_not_regulated"])
	})

	it("submits and returns the tx hash", async () => {
		const r = await POST(`/v1/accounts/${HOLDER}/authorize`, {
			view: unauthorized,
			authorize: () => Promise.resolve("abc123"),
		})
		expect(r.status).toBe(200)
		expect(r.body).toMatchObject({
			authorized: true,
			alreadyAuthorized: false,
			txHash: "abc123",
		})
	})

	it("is idempotent: an already-authorized account short-circuits", async () => {
		const r = await POST(`/v1/accounts/${HOLDER}/authorize`, {
			view: () =>
				Promise.resolve(
					view(gStatus({ hasTrustline: true, isAuthorized: true })),
				),
			// authorize left unstubbed: submitting would reject the request.
		})
		expect(r.status).toBe(200)
		expect(r.body).toMatchObject({ authorized: true, alreadyAuthorized: true })
	})

	it("surfaces a denylist refusal as 403 account_banned", async () => {
		const r = await POST(`/v1/accounts/${HOLDER}/authorize`, {
			view: unauthorized,
			authorize: () =>
				Promise.reject(new Error("simulation: Error(Contract, #1)")),
		})
		expect([r.status, r.body.error]).toEqual([403, "account_banned"])
	})

	it("coalesces concurrent authorizes for one account into one submission", async () => {
		// The idempotency check is check-then-act; without coalescing, a burst
		// of identical requests would each pass it and each spend fees.
		const account = Keypair.random().publicKey()
		let submissions = 0
		let release!: (hash: string) => void
		const o: Partial<ChainOps> = {
			view: unauthorized,
			authorize: () => {
				submissions += 1
				return new Promise<string>((r) => {
					release = r
				})
			},
		}
		const [a, b] = [
			POST(`/v1/accounts/${account}/authorize`, o),
			POST(`/v1/accounts/${account}/authorize`, o),
		]
		// Let both requests reach the in-flight map before resolving.
		await new Promise((r) => setImmediate(r))
		release("txhash1")
		const [ra, rb] = await Promise.all([a, b])
		expect(submissions).toBe(1)
		expect(ra.body).toMatchObject({ authorized: true, txHash: "txhash1" })
		expect(rb.body).toMatchObject({ authorized: true, txHash: "txhash1" })

		// The key is released afterwards: a later authorize submits again.
		const later = await POST(`/v1/accounts/${account}/authorize`, {
			view: unauthorized,
			authorize: () => {
				submissions += 1
				return Promise.resolve("txhash2")
			},
		})
		expect(submissions).toBe(2)
		expect(later.body).toMatchObject({ txHash: "txhash2" })
	})

	it("enforces the bearer token only when one is configured", async () => {
		const tokenCfg = { ...cfg, apiToken: "s3cret" }
		const call = (token?: string) =>
			handleRequest(
				tokenCfg,
				ops({
					view: unauthorized,
					authorize: () => Promise.resolve("h"),
				}),
				"POST",
				new URL(`http://x/v1/accounts/${HOLDER}/authorize`),
				token,
			)
		expect((await call(undefined)).status).toBe(401)
		expect((await call("wrong")).status).toBe(401)
		expect((await call("s3cret")).status).toBe(200)
		// GET /ready stays open — reads are free and unauthenticated.
		const read = await handleRequest(
			tokenCfg,
			ops({ view: unauthorized, isEligible: () => Promise.resolve(true) }),
			"GET",
			new URL(`http://x/v1/accounts/${HOLDER}/ready`),
		)
		expect(read.status).toBe(200)
	})
})
