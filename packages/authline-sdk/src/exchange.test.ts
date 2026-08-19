import {
	Account,
	Address,
	Asset,
	BASE_FEE,
	Keypair,
	Networks,
	Operation,
	TransactionBuilder,
	type Transaction,
} from "@stellar/stellar-sdk"
import type * as stellarSdk from "@stellar/stellar-sdk"
import { describe, expect, it, vi } from "vitest"
import { type OnboarderConfig } from "./index.js"

const USER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
const SPONSOR_KP = Keypair.random()
const SPONSOR = SPONSOR_KP.publicKey()
const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
const SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
const AUTHORIZER = "CD7K7S43HSIR2DLGDT5OWSHDJQIQWFAJWZOIO66T2OVMLNYFL74OK2KU"

// Mock only the RPC server; keep the real builders/codecs.
vi.mock("@stellar/stellar-sdk", async (importActual) => {
	const actual = await importActual<typeof stellarSdk>()
	class FakeServer {
		async getAccount(id: string) {
			return new actual.Account(id, "0")
		}
		async prepareTransaction(tx: unknown) {
			return tx
		}
	}
	return { ...actual, rpc: { ...actual.rpc, Server: FakeServer } }
})

const config: OnboarderConfig = {
	assetCode: "EURCV",
	assetIssuer: ISSUER,
	sac: SAC,
	authorizer: AUTHORIZER,
	backends: ["cap33-sponsored"],
}
const rpcUrl = "https://soroban-testnet.stellar.org"
const networkPassphrase = Networks.TESTNET

describe("buildAuthorizeTx (Case A — authorize on behalf)", () => {
	it("builds one authorize_trustline(account) call on the authorizer", async () => {
		const { buildAuthorizeTx } = await import("./exchange.js")
		const xdr = await buildAuthorizeTx({
			rpcUrl,
			networkPassphrase,
			source: SPONSOR,
			account: USER,
			config,
		})
		const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase) as Transaction
		// The INTEGRATOR sources the transaction, which is what makes Case A cost
		// the user zero signatures — the user is only ever the argument.
		expect(tx.source).toBe(SPONSOR)
		expect(tx.operations).toHaveLength(1)
		const op = tx.operations[0] as Operation.InvokeHostFunction
		const call = op.func.invokeContract()
		expect(Address.fromScAddress(call.contractAddress()).toString()).toBe(
			AUTHORIZER,
		)
		expect(call.functionName().toString()).toBe("authorize_trustline")
		expect(Address.fromScVal(call.args()[0]).toString()).toBe(USER)
	})

	it("throws when the asset has no authorizer configured", async () => {
		const { buildAuthorizeTx } = await import("./exchange.js")
		await expect(
			buildAuthorizeTx({
				rpcUrl,
				networkPassphrase,
				source: SPONSOR,
				account: USER,
				config: { ...config, authorizer: undefined },
			}),
		).rejects.toThrow(/config.authorizer is required/)
	})
})

describe("buildSponsoredOnboardTx (Case B — CAP-33 sponsored reserve)", () => {
	const base = {
		rpcUrl,
		networkPassphrase,
		sponsor: SPONSOR,
		user: USER,
		config,
	}

	it("wraps a user-sourced ChangeTrust in the sponsor's sandwich", async () => {
		const { buildSponsoredOnboardTx } = await import("./exchange.js")
		const tx = TransactionBuilder.fromXDR(
			await buildSponsoredOnboardTx(base),
			networkPassphrase,
		) as Transaction
		expect(tx.operations.map((o) => o.type)).toEqual([
			"beginSponsoringFutureReserves",
			"changeTrust",
			"endSponsoringFutureReserves",
		])
		// The sponsor sources the envelope and pays; only the ops the USER must
		// authorize carry their address, which is what keeps them to one signature.
		expect(tx.source).toBe(SPONSOR)
		expect(tx.operations[1].source).toBe(USER)
		expect(tx.operations[2].source).toBe(USER)
		const ct = tx.operations[1] as Operation.ChangeTrust
		expect((ct.line as Asset).getCode()).toBe("EURCV")
		expect((ct.line as Asset).getIssuer()).toBe(ISSUER)
	})

	it("adds a sponsored CreateAccount for a user who does not exist yet", async () => {
		const { buildSponsoredOnboardTx } = await import("./exchange.js")
		const tx = TransactionBuilder.fromXDR(
			await buildSponsoredOnboardTx({ ...base, createUserAccount: true }),
			networkPassphrase,
		) as Transaction
		expect(tx.operations.map((o) => o.type)).toEqual([
			"beginSponsoringFutureReserves",
			"createAccount",
			"changeTrust",
			"endSponsoringFutureReserves",
		])
		const create = tx.operations[1] as Operation.CreateAccount
		expect(create.destination).toBe(USER)
		// Zero starting balance: the sponsor covers the base reserve too, so the
		// user needs no XLM of their own at any point.
		expect(Number(create.startingBalance)).toBe(0)
	})
})

describe("onboardingRequest (wallet handoffs)", () => {
	// Case C shape: the user sources it and is the only signer a wallet needs
	// to add — the handoff is complete on one signature.
	const soloXdr = new TransactionBuilder(new Account(USER, "0"), {
		fee: BASE_FEE,
		networkPassphrase,
	})
		.addOperation(Operation.changeTrust({ asset: new Asset("EURCV", ISSUER) }))
		.setTimeout(180)
		.build()
		.toXDR()

	const base = {
		txXdr: soloXdr,
		networkPassphrase,
		userAddress: USER,
	}
	const paramsOf = (uri: string) =>
		new URLSearchParams(uri.slice("web+stellar:tx?".length))

	it("emits a SEP-7 tx URI carrying the xdr and network", async () => {
		const { onboardingRequest } = await import("./exchange.js")
		const req = onboardingRequest(base)
		expect(req.sep7Uri.startsWith("web+stellar:tx?")).toBe(true)
		const p = paramsOf(req.sep7Uri)
		expect(p.get("xdr")).toBe(soloXdr)
		expect(p.get("network_passphrase")).toBe(networkPassphrase)
		// SEP-7 is the registered deep-link scheme, so these are one artifact.
		expect(req.deepLink).toBe(req.sep7Uri)
		expect(req.hostedUrl).toBeUndefined()
	})

	it("rejects an XDR that is not a transaction for this network", async () => {
		const { onboardingRequest } = await import("./exchange.js")
		expect(() =>
			onboardingRequest({ ...base, txXdr: "AAAAAgAAAABmockXDRvalue" }),
		).toThrow(/not a transaction envelope/)
	})

	it("prefixes a bare callback with `url:` as SEP-7 requires", async () => {
		const { onboardingRequest } = await import("./exchange.js")
		const req = onboardingRequest({
			...base,
			callback: "https://exchange.example/sep7-callback",
		})
		expect(paramsOf(req.sep7Uri).get("callback")).toBe(
			"url:https://exchange.example/sep7-callback",
		)
	})

	it("leaves an already-prefixed callback alone", async () => {
		const { onboardingRequest } = await import("./exchange.js")
		const req = onboardingRequest({
			...base,
			callback: "url:https://exchange.example/cb",
		})
		expect(paramsOf(req.sep7Uri).get("callback")).toBe(
			"url:https://exchange.example/cb",
		)
	})

	it("accepts msg at the 300-character limit and rejects it beyond", async () => {
		const { onboardingRequest, SEP7_MSG_MAX } = await import("./exchange.js")
		expect(SEP7_MSG_MAX).toBe(300)
		const ok = "x".repeat(SEP7_MSG_MAX)
		expect(
			paramsOf(onboardingRequest({ ...base, msg: ok }).sep7Uri).get("msg"),
		).toBe(ok)
		expect(() =>
			onboardingRequest({ ...base, msg: "x".repeat(SEP7_MSG_MAX + 1) }),
		).toThrow(/exceeds the SEP-7 limit of 300/)
	})

	it("builds a hosted URL only when given a base, without a doubled slash", async () => {
		const { onboardingRequest } = await import("./exchange.js")
		const req = onboardingRequest({
			...base,
			hostedBase: "https://onboard.example/app.html/",
		})
		expect(req.hostedUrl).toBe(
			`https://onboard.example/app.html?address=${USER}`,
		)
	})

	// A SEP-7 wallet signs as the USER and submits. For the CAP-33 sponsored
	// path that is not enough — the sponsor sources the envelope and must sign
	// it too — so an unsigned sponsored handoff is a link that cannot succeed.
	describe("transactions needing a co-signature", () => {
		const sponsoredOpts = {
			rpcUrl,
			networkPassphrase,
			sponsor: SPONSOR,
			user: USER,
			config,
			createUserAccount: true,
		}

		it("refuses an unsigned sponsored transaction", async () => {
			const { buildSponsoredOnboardTx, onboardingRequest } =
				await import("./exchange.js")
			const txXdr = await buildSponsoredOnboardTx(sponsoredOpts)
			expect(() => onboardingRequest({ ...base, txXdr })).toThrow(
				new RegExp(`also needs a signature from ${SPONSOR}`),
			)
		})

		it("accepts it once the sponsor has signed", async () => {
			const { buildSponsoredOnboardTx, onboardingRequest } =
				await import("./exchange.js")
			const tx = TransactionBuilder.fromXDR(
				await buildSponsoredOnboardTx(sponsoredOpts),
				networkPassphrase,
			) as Transaction
			tx.sign(SPONSOR_KP)
			const req = onboardingRequest({ ...base, txXdr: tx.toXDR() })
			// The sponsor's signature rides along inside the SEP-7 `xdr`, so the
			// user's signature is the one that completes the envelope.
			const carried = TransactionBuilder.fromXDR(
				paramsOf(req.sep7Uri).get("xdr")!,
				networkPassphrase,
			) as Transaction
			expect(carried.signatures).toHaveLength(1)
		})

		it("accepts it unsigned when a callback will collect the signed XDR", async () => {
			const { buildSponsoredOnboardTx, onboardingRequest } =
				await import("./exchange.js")
			const txXdr = await buildSponsoredOnboardTx(sponsoredOpts)
			const req = onboardingRequest({
				...base,
				txXdr,
				callback: "https://exchange.example/cb",
			})
			expect(paramsOf(req.sep7Uri).get("callback")).toBe(
				"url:https://exchange.example/cb",
			)
		})

		it("does not flag the router path, where the user is the only signer", async () => {
			const { onboardingRequest } = await import("./exchange.js")
			expect(() => onboardingRequest(base)).not.toThrow()
		})
	})

	describe("signed requests", () => {
		const kp = Keypair.random()

		it("refuses to sign without an origin domain to verify against", async () => {
			const { onboardingRequest } = await import("./exchange.js")
			expect(() => onboardingRequest({ ...base, signer: kp })).toThrow(
				/originDomain is required when signing/,
			)
		})

		it("sets origin_domain without a signer", async () => {
			const { onboardingRequest } = await import("./exchange.js")
			const req = onboardingRequest({
				...base,
				originDomain: "exchange.example",
			})
			expect(paramsOf(req.sep7Uri).get("origin_domain")).toBe(
				"exchange.example",
			)
			expect(req.sep7Uri).not.toContain("signature=")
		})

		it("appends a verifiable signature as the LAST parameter", async () => {
			const { onboardingRequest } = await import("./exchange.js")
			const req = onboardingRequest({
				...base,
				msg: "Activate EURCV",
				originDomain: "exchange.example",
				signer: kp,
			})

			// Must be last: a wallet recovers the payload by stripping the trailing
			// `signature` parameter, so anything after it would break verification.
			const at = req.sep7Uri.indexOf("&signature=")
			expect(at).toBeGreaterThan(-1)
			expect(req.sep7Uri.slice(at + 1).split("&")).toHaveLength(1)

			const signed = req.sep7Uri.slice(0, at)
			const sig = Buffer.from(
				decodeURIComponent(req.sep7Uri.slice(at + "&signature=".length)),
				"base64",
			)
			// Payload rebuilt straight from SEP-7 rather than from our own helper,
			// so a change to the construction fails here instead of passing itself.
			const prefix = Buffer.alloc(36)
			prefix[35] = 4
			const payload = Buffer.concat([
				prefix,
				Buffer.from(`stellar.sep.7 - URI Scheme${signed}`, "utf8"),
			])
			expect(kp.verify(payload, sig)).toBe(true)
			// And it is bound to this exact request.
			expect(
				kp.verify(
					Buffer.concat([
						prefix,
						Buffer.from(`stellar.sep.7 - URI Scheme${signed}&msg=tampered`),
					]),
					sig,
				),
			).toBe(false)
		})
	})
})

describe("asAccount", () => {
	it("rebuilds a source account at the given sequence", async () => {
		const { asAccount } = await import("./exchange.js")
		const a = asAccount(SPONSOR, "42")
		expect(a.accountId()).toBe(SPONSOR)
		expect(a.sequenceNumber()).toBe("42")
	})
})
