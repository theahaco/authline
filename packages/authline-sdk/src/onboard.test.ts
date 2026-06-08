import {
	Address,
	Networks,
	type Operation,
	TransactionBuilder,
} from "@stellar/stellar-sdk"
import { afterEach, describe, expect, it, vi } from "vitest"

const HOLDER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
const SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"

// Mock only the RPC server; keep the real builders/codecs.
vi.mock("@stellar/stellar-sdk", async (importActual) => {
	const actual = await importActual<typeof import("@stellar/stellar-sdk")>()
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

const opts = {
	rpcUrl: "https://soroban-testnet.stellar.org",
	networkPassphrase: Networks.TESTNET,
	holder: HOLDER,
	config: {
		assetCode: "USDC",
		assetIssuer: HOLDER,
		sac: SAC,
		authorizer: "",
		backends: [] as const,
	},
}

describe("buildTrustTx", () => {
	afterEach(() => vi.clearAllMocks())

	it("builds a single SAC.trust(holder) invocation", async () => {
		const { buildTrustTx } = await import("./onboard.js")
		const xdr = await buildTrustTx({ ...opts, allowHttp: false })
		const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET)
		expect(tx.operations).toHaveLength(1)
		const op = tx.operations[0] as Operation.InvokeHostFunction
		expect(op.type).toBe("invokeHostFunction")
		const call = op.func.invokeContract()
		expect(Address.fromScAddress(call.contractAddress()).toString()).toBe(SAC)
		expect(call.functionName().toString()).toBe("trust")
		expect(call.args()).toHaveLength(1)
		expect(Address.fromScVal(call.args()[0]).toString()).toBe(HOLDER)
	})

	it("throws when config.sac is missing", async () => {
		const { buildTrustTx } = await import("./onboard.js")
		await expect(
			buildTrustTx({ ...opts, config: { ...opts.config, sac: "" } }),
		).rejects.toThrow(/config.sac is required/)
	})
})
