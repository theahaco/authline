import {
	Address,
	Networks,
	type Operation,
	TransactionBuilder,
} from "@stellar/stellar-sdk"
import type * as stellarSdk from "@stellar/stellar-sdk"
import { describe, expect, it, vi } from "vitest"
import { type OnboarderConfig } from "./index.js"

const HOLDER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
const SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
// Any valid C-address works for the router in this offline test.
const ROUTER = "CD7K7S43HSIR2DLGDT5OWSHDJQIQWFAJWZOIO66T2OVMLNYFL74OK2KU"

// Mock only the RPC server; keep the real builders/codecs.
vi.mock("@stellar/stellar-sdk", async (importActual) => {
	const actual = await importActual<typeof stellarSdk>()
	class FakeServer {
		async getAccount(id: string) {
			return new actual.Account(id, "0")
		}
		// Skip real simulation; the op is already on the tx.
		async prepareTransaction(tx: unknown) {
			return tx
		}
	}
	return { ...actual, rpc: { ...actual.rpc, Server: FakeServer } }
})

const config: OnboarderConfig = {
	assetCode: "USDC",
	assetIssuer: ISSUER,
	sac: SAC,
	router: ROUTER,
	backends: ["cap73-one-signature"],
}
const opts = {
	rpcUrl: "https://soroban-testnet.stellar.org",
	networkPassphrase: Networks.TESTNET,
	holder: HOLDER,
	config,
}

describe("buildOnboardTx (router)", () => {
	it("builds a single router.onboard(sac, holder) invocation", async () => {
		const { buildOnboardTx } = await import("./onboard.js")
		const xdr = await buildOnboardTx({ ...opts, allowHttp: false })
		const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET)
		expect(tx.operations).toHaveLength(1)
		const op = tx.operations[0] as Operation.InvokeHostFunction
		expect(op.type).toBe("invokeHostFunction")
		const call = op.func.invokeContract()
		expect(Address.fromScAddress(call.contractAddress()).toString()).toBe(
			ROUTER,
		)
		expect(call.functionName().toString()).toBe("onboard")
		expect(call.args()).toHaveLength(2)
		expect(Address.fromScVal(call.args()[0]).toString()).toBe(SAC)
		expect(Address.fromScVal(call.args()[1]).toString()).toBe(HOLDER)
	})

	it("throws when config.router is missing", async () => {
		const { buildOnboardTx } = await import("./onboard.js")
		await expect(
			buildOnboardTx({ ...opts, config: { ...config, router: "" } }),
		).rejects.toThrow(/config.router is required/)
	})

	it("throws when config.sac is missing", async () => {
		const { buildOnboardTx } = await import("./onboard.js")
		await expect(
			buildOnboardTx({ ...opts, config: { ...config, sac: "" } }),
		).rejects.toThrow(/config.sac is required/)
	})
})
