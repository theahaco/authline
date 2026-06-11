import { afterEach, describe, expect, it, vi } from "vitest"
import { rpc, xdr } from "@stellar/stellar-sdk"
import { getActivationStatus } from "./status.js"

const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
const ACCT = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
const SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
const PASSPHRASE = "Test SDF Network ; September 2015"
const RPC = "https://soroban-testnet.stellar.org"

// status.ts reads entries[0].val.trustLine().flags(); a duck-typed entry is
// enough to exercise the decode without constructing real ledger XDR.
const entryWithFlags = (flags: number) => ({
	val: { trustLine: () => ({ flags: () => flags }) },
})
const stubLedgerEntries = (entries: unknown[]) =>
	vi
		.spyOn(rpc.Server.prototype, "getLedgerEntries")
		.mockResolvedValue({ entries } as never)
// isSimulationSuccess checks `"transactionData" in sim`; a shaped literal with
// a real ScVal retval exercises the decode without a network round-trip.
const stubSimulation = (sim: object) =>
	vi
		.spyOn(rpc.Server.prototype, "simulateTransaction")
		.mockResolvedValue(sim as never)
const simSuccess = (authorized: boolean) => ({
	transactionData: {},
	result: { retval: xdr.ScVal.scvBool(authorized) },
})

afterEach(() => vi.restoreAllMocks())

const status = (rpcUrl = RPC, allowHttp?: boolean) =>
	getActivationStatus({
		rpcUrl,
		allowHttp,
		account: ACCT,
		assetCode: "USDC",
		assetIssuer: ISSUER,
	})
const statusWithSac = () =>
	getActivationStatus({
		rpcUrl: RPC,
		account: ACCT,
		assetCode: "USDC",
		assetIssuer: ISSUER,
		sac: SAC,
		networkPassphrase: PASSPHRASE,
	})

describe("getActivationStatus (Stellar RPC, no Horizon)", () => {
	it("reports an authorized trustline when AUTHORIZED_FLAG is set", async () => {
		stubLedgerEntries([entryWithFlags(1)])
		await expect(status()).resolves.toEqual({
			hasTrustline: true,
			isAuthorized: true,
			isAuthorizedToMaintainLiabilities: false,
		})
	})

	it("reports a created-but-unauthorized trustline when the flag is clear", async () => {
		stubLedgerEntries([entryWithFlags(0)])
		await expect(status()).resolves.toEqual({
			hasTrustline: true,
			isAuthorized: false,
			isAuthorizedToMaintainLiabilities: false,
		})
	})

	it("reports partial authorization (maintain-liabilities bit)", async () => {
		stubLedgerEntries([entryWithFlags(2)])
		await expect(status()).resolves.toEqual({
			hasTrustline: true,
			isAuthorized: false,
			isAuthorizedToMaintainLiabilities: true,
		})
	})

	it("reports no trustline when the ledger entry is absent", async () => {
		stubLedgerEntries([])
		await expect(status()).resolves.toEqual({
			hasTrustline: false,
			isAuthorized: false,
			isAuthorizedToMaintainLiabilities: false,
		})
	})

	it("allows a localhost-http RPC (local-dev default)", async () => {
		stubLedgerEntries([])
		await expect(status("http://localhost:8000")).resolves.toEqual({
			hasTrustline: false,
			isAuthorized: false,
			isAuthorizedToMaintainLiabilities: false,
		})
	})

	it("refuses a remote http RPC by default", async () => {
		stubLedgerEntries([])
		await expect(status("http://rpc.evil.example")).rejects.toThrow(/insecure/)
	})

	it("surfaces a transient read error in readError (still non-throwing)", async () => {
		vi.spyOn(rpc.Server.prototype, "getLedgerEntries").mockRejectedValue(
			new Error("rpc 503"),
		)
		await expect(status()).resolves.toEqual({
			hasTrustline: false,
			isAuthorized: false,
			isAuthorizedToMaintainLiabilities: false,
			readError: "rpc 503",
		})
	})
})

describe("getActivationStatus — SAC authorized() view", () => {
	it("reads sacAuthorized=true via simulation when sac+passphrase are given", async () => {
		stubLedgerEntries([entryWithFlags(1)])
		stubSimulation(simSuccess(true))
		await expect(statusWithSac()).resolves.toEqual({
			hasTrustline: true,
			isAuthorized: true,
			isAuthorizedToMaintainLiabilities: false,
			sacAuthorized: true,
		})
	})

	it("surfaces a classic/SAC divergence (classic authorized, SAC says no)", async () => {
		stubLedgerEntries([entryWithFlags(1)])
		stubSimulation(simSuccess(false))
		await expect(statusWithSac()).resolves.toEqual({
			hasTrustline: true,
			isAuthorized: true,
			isAuthorizedToMaintainLiabilities: false,
			sacAuthorized: false,
		})
	})

	it("reports sacAuthorized=false without a trustline (SAC traps on missing entries)", async () => {
		stubLedgerEntries([])
		const sim = stubSimulation(simSuccess(true))
		await expect(statusWithSac()).resolves.toEqual({
			hasTrustline: false,
			isAuthorized: false,
			isAuthorizedToMaintainLiabilities: false,
			sacAuthorized: false,
		})
		expect(sim).not.toHaveBeenCalled()
	})

	it("keeps classic flags authoritative when the SAC simulation fails", async () => {
		stubLedgerEntries([entryWithFlags(1)])
		stubSimulation({ error: "HostError: Error(Contract, #13)" })
		const st = await statusWithSac()
		expect(st).toEqual({
			hasTrustline: true,
			isAuthorized: true,
			isAuthorizedToMaintainLiabilities: false,
			readError: expect.stringContaining("Error(Contract, #13)"),
		})
		// `toEqual` ignores undefined-valued keys — pin the absence explicitly.
		expect("sacAuthorized" in st).toBe(false)
	})

	it("reports the issuer's own account as SAC-authorized despite having no trustline", async () => {
		stubLedgerEntries([])
		const sim = stubSimulation(simSuccess(false))
		await expect(
			getActivationStatus({
				rpcUrl: RPC,
				account: ISSUER,
				assetCode: "USDC",
				assetIssuer: ISSUER,
				sac: SAC,
				networkPassphrase: PASSPHRASE,
			}),
		).resolves.toEqual({
			hasTrustline: false,
			isAuthorized: false,
			isAuthorizedToMaintainLiabilities: false,
			sacAuthorized: true,
		})
		expect(sim).not.toHaveBeenCalled()
	})

	it("does not simulate when no sac is configured", async () => {
		stubLedgerEntries([entryWithFlags(1)])
		const sim = stubSimulation(simSuccess(true))
		await status()
		expect(sim).not.toHaveBeenCalled()
	})
})
